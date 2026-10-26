import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = readFileSync(path.join(repoRoot, 'images/litellm/litellm-config.yaml'), 'utf8');

function explicitGroup(name: string): string {
  const start = config.indexOf(`  - model_name: ollama-cloud/${name}`);
  expect(start, `${name} group must exist`).toBeGreaterThanOrEqual(0);
  const rest = config.slice(start);
  const next = rest.indexOf('  - model_name:', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

type GatewayEntry = {
  model_name: string;
  litellm_params: { model: string; [key: string]: unknown };
};
type GatewayConfig = {
  model_list: GatewayEntry[];
  router_settings: { fallbacks: Array<Record<string, string[]>> };
};

function routerEntry(cfg: string): GatewayEntry | undefined {
  return (parseYaml(cfg) as GatewayConfig).model_list.find((e) => e.model_name === 'auto_router/complexity_router');
}

function tiersOf(entry: GatewayEntry | undefined): Record<string, string> {
  const cfg = entry?.litellm_params?.complexity_router_config as { tiers: Record<string, string> } | undefined;
  return cfg?.tiers ?? {};
}

describe('Ollama Cloud native route configuration', () => {
  it('routes both explicit groups through native ollama_chat without the /v1 base', () => {
    for (const version of ['glm-5.3', 'glm-5.2', 'glm-5.3-flash', 'nemotron-3-super', 'deepseek-v4.1-flash']) {
      const group = explicitGroup(version);
      expect(group).toContain(`model: ollama_chat/${version}`);
      expect(group).toMatch(/api_base: https:\/\/ollama\.com(?:\s|$)/);
      const apiBase = (/^\s+api_base:\s*([^#\n]+)/m.exec(group)?.[1] ?? '').trim();
      expect(apiBase).not.toContain('/v1');
    }
  });

  it('prices both explicit Ollama groups while leaving wildcard pass-through unpriced', () => {
    for (const version of ['glm-5.3', 'glm-5.2']) {
      const group = explicitGroup(version);
      expect(group).toMatch(/input_cost_per_token: 0\.0000014/);
      expect(group).toMatch(/cache_read_input_token_cost: 0\.00000026/);
      expect(group).toMatch(/output_cost_per_token: 0\.0000044/);
    }
    const wildcard = config.match(/  - model_name: "\*"[\s\S]*?(?=  # Future anthropic lane)/)?.[0];
    expect(wildcard).toBeDefined();
    expect(wildcard).not.toContain('model_info:');
  });

  it('pins exact pricing and roles for the three new native lanes', () => {
    const expected = {
      'glm-5.3-flash': ['0.00000015', '0.00000003', '0.0000005'],
      'nemotron-3-super': ['0.000000015', '0.000000015', '0.0000006'],
      'deepseek-v4.1-flash': ['0.0000003', '0.000000006', '0.0000012'],
    } as const;
    for (const [name, [input, cached, output]] of Object.entries(expected)) {
      const group = explicitGroup(name);
      expect(group).toContain(`input_cost_per_token: ${input}`);
      expect(group).toContain(`cache_read_input_token_cost: ${cached}`);
      expect(group).toContain(`output_cost_per_token: ${output}`);
      expect(group).toMatch(/api_key: os\.environ\/OLLAMA_CLOUD_API_KEY/);
      expect(group).toMatch(/ROLE:/);
    }
    expect(explicitGroup('glm-5.3-flash')).toContain('max_input_tokens: 1000000');
    for (const name of ['nemotron-3-super', 'deepseek-v4.1-flash']) {
      expect(explicitGroup(name)).toMatch(/TODO:.*context limit; do not guess/);
      expect(explicitGroup(name)).not.toContain('max_input_tokens');
    }
    expect(explicitGroup('deepseek-v4.1-flash')).toContain('Off-peak pricing row also exists upstream');
  });

  it('declares the default lane fallback chain in escalation order', () => {
    const router = config.match(/router_settings:[\s\S]*$/)?.[0] ?? '';
    expect(router).toContain('- ollama-cloud/glm-5.3-flash: ["ollama-cloud/glm-5.2", "ollama-cloud/glm-5.3", "ollama-cloud/deepseek-v4.1-flash"]');
    expect(router).not.toMatch(/^- ollama-cloud\/(?:glm-5.3|nemotron-3-super|deepseek-v4.1-flash):/m);
  });

  it('preserves the wildcard OpenAI-compatible pass-through block verbatim', () => {
    const wildcard = config.match(/  # Wildcard pass-through[\s\S]*?(?=  # Future anthropic lane)/)?.[0];
    expect(wildcard).toBe(`  # Wildcard pass-through (mirrors the origin fleet's gateway shape): routes any other
  # model name to Ollama Cloud's OpenAI-compatible /v1 endpoint. It ROUTES but
  # cannot failover — never list "*" as a fallback target (j9f).
  - model_name: "*"
    litellm_params:
      model: openai/*
      api_base: os.environ/OLLAMA_CLOUD_API_BASE
      api_key: os.environ/OLLAMA_CLOUD_API_KEY
`);
  });

  it('declares the verified glm-5.3 context limit and flags glm-5.2 as unverified', () => {
    expect(explicitGroup('glm-5.3')).toMatch(/model_info:\s*\n\s+max_input_tokens: 1000000/);
    expect(explicitGroup('glm-5.2')).toMatch(/# TODO:.*glm-5.2 context limit; do not guess/);
    expect(explicitGroup('glm-5.2')).not.toContain('max_input_tokens');
  });

  it('activates the default complexity auto-router in model_list (1py.50)', () => {
    const parsed = parseYaml(config) as GatewayConfig;
    expect(parsed).toBeDefined();
    // The alias must be a real, ACTIVE entry — the block it replaced was
    // comments-only by design (PR #88's inert-shape test enforced that) until
    // fleet-ops-1py.50 flipped the router to the gateway default.
    const entry = routerEntry(config);
    expect(entry, 'router alias must be an ACTIVE model_list entry').toBeDefined();
    expect(entry!.litellm_params.model).toBe('auto_router/complexity_router');
    expect(entry!.litellm_params.complexity_router_config).toEqual({
      tiers: {
        SIMPLE: 'ollama-cloud/glm-5.3-flash',
        MEDIUM: 'ollama-cloud/glm-5.3',
        COMPLEX: 'ollama-cloud/glm-5.3',
        REASONING: 'ollama-cloud/glm-5.3',
      },
      session_affinity: true,
      context_compaction: false,
    });
  });

  it('maps every router tier to an explicitly listed group, never the wildcard', () => {
    const parsed = parseYaml(config) as GatewayConfig;
    const names = parsed.model_list.map((e) => e.model_name);
    for (const target of Object.values(tiersOf(routerEntry(config)))) {
      expect(names, `tier target ${target} must be a listed model group`).toContain(target);
      expect(target).not.toBe('*');
    }
  });

  it('ships an explicit fallback chain for the router alias and no broken shape', () => {
    const parsed = parseYaml(config) as GatewayConfig;
    const names = new Set(parsed.model_list.map((e) => e.model_name));
    const chain = (parsed.router_settings.fallbacks.find((f) => f['auto_router/complexity_router']) ?? {})[
      'auto_router/complexity_router'
    ];
    expect(chain).toEqual(['ollama-cloud/glm-5.3-flash', 'ollama-cloud/glm-5.3', 'ollama-cloud/deepseek-v4.1-flash']);
    for (const target of chain) {
      expect(names.has(target), `${target} must be explicitly listed`).toBe(true);
      expect(target).not.toBe('*');
    }
    // Known-broken shapes (PR #88 fixture findings) never appear UNCOMMENTED:
    // `auto_router_config:` (a string path on 1.105.1; its dict form was the
    // dropped-deployment defect) and a bare `context_compaction: true`.
    const uncommented = config.split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(uncommented.some((line) => /auto_router_config:/.test(line))).toBe(false);
    const compactionLines = uncommented.filter((line) => line.includes('context_compaction:'));
    expect(compactionLines.join('\n')).toBe('        context_compaction: false');
  });

  it('documents weekly budgets in the gateway ops docs', () => {
    const canonical = readFileSync(path.join(repoRoot, 'docs/gateway-ops.md'), 'utf8');
    expect(canonical).toContain('## Per-key budget caps (weekly example)');
    expect(canonical).toContain('budget_duration: 7d');
    expect(canonical).toContain('budget_reset_at');
    expect(canonical).toContain('POST /key/{token}/reset_spend');
    expect(canonical).toContain('{"reset_to": 0}');
    expect(canonical).toContain('Budgets also gate MCP calls');
  });

  it('keeps the data-handling constraint prominent in the docs and at the active entry', () => {
    const canonical = readFileSync(path.join(repoRoot, 'docs/gateway-ops.md'), 'utf8');
    expect(canonical).toContain('## Default auto-router (active)');
    expect(canonical).toContain('Every tier of the router is a HOSTED ollama-cloud lane');
    expect(canonical).toContain('Do not route sensitive free text through the alias');
    expect(canonical).toContain('explicit fallback chain');
    assertActiveRouterBlock();
  });
});

function assertActiveRouterBlock(): void {
  const block = config.slice(config.indexOf('# auto_router'), config.indexOf('\nrouter_settings:'));
  expect(block.length, 'router block present in the shipped config').toBeGreaterThan(0);
  expect(block).toContain('# SENSITIVE TEXT — every tier below is a HOSTED ollama-cloud lane');
  expect(block).toContain('# through this alias; instead define self-hosted model groups');
  // The router entry is ACTIVE (uncommented) in the shipped config:
  expect(block.split('\n').some((line) => line === '  - model_name: auto_router/complexity_router')).toBe(true);
}

describe('Router serving fixture — runtime mirrors the shipped router (1py.50)', () => {
  const runtimeRaw = readFileSync(path.join(repoRoot, 'test/e2e/litellm-runtime-config.yaml'), 'utf8');
  const runtimeParsed = parseYaml(runtimeRaw) as GatewayConfig;
  const runtimeEntry = routerEntry(runtimeRaw);
  const shipped = routerEntry(config);

  it('mirrors the shipped alias, tier mapping, affinity, and compaction exactly', () => {
    expect(runtimeEntry).toBeDefined();
    expect(shipped).toBeDefined();
    expect(runtimeEntry!.litellm_params.model).toBe('auto_router/complexity_router');
    expect(runtimeEntry!.litellm_params.complexity_router_config).toEqual(
      shipped!.litellm_params.complexity_router_config,
    );
  });

  it('routes every tier target group to the local ollama-mock service', () => {
    const groups = new Map(runtimeParsed.model_list.map((e) => [e.model_name, e]));
    for (const target of Object.values(tiersOf(runtimeEntry))) {
      const group = groups.get(target);
      expect(group, `fixture group ${target} present`).toBeDefined();
      expect(group!.litellm_params.api_base).toBe('http://ollama-mock:11434');
    }
  });

  it('keeps the simulation wildcard-free (explicit groups only)', () => {
    expect(runtimeParsed.model_list.map((e) => e.model_name)).not.toContain('*');
  });
});
