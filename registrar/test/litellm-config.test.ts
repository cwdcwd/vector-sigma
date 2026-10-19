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

  it('keeps the auto-router template comments-only and the YAML parseable', () => {
    const parsed = parseYaml(config) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(JSON.stringify(parsed)).not.toMatch(/auto_router|complexity_router/);
    const template = config.slice(config.indexOf('# auto_router template'), config.indexOf('\nrouter_settings:'));
    expect(template).toContain('# - model_name: auto_router/complexity_router');
    expect(template).toContain('#     complexity_router_config:');
    expect(template).toContain('#       tiers:');
    expect(template).toContain('#         SIMPLE: ollama-cloud/glm-5.3-flash');
    expect(template).toContain('#       session_affinity: true');
    expect(template).toMatch(/^#\s*context_compaction: false$/m);
    expect(template).toContain('#       #   classification_rubric: <rubric>');
    expect(template.split('\n').every((line) => line === '' || line.startsWith('#'))).toBe(true);
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

  it('keeps the sensitive-text constraint stated in the docs and template', () => {
    const canonical = readFileSync(path.join(repoRoot, 'docs/gateway-ops.md'), 'utf8');
    expect(canonical).toContain('if any routed traffic may carry sensitive');
    expect(canonical).toContain('map every tier only to self-hosted model groups');
    expect(canonical).toContain('hosted ollama-cloud lanes');
    expect(canonical).toContain('no self-hosted model');
    const template = config.slice(config.indexOf('# auto_router template'), config.indexOf('\nrouter_settings:'));
    expect(template).toContain('# Sensitive text: if routed traffic may carry sensitive free text, map every tier');
    expect(template).toContain('# only to self-hosted model groups');
    expect(template).toContain('# self-hosted model group, so this template must stay commented in shared defaults.');
    expect(template.split('\n').every((line) => line === '' || line.startsWith('#'))).toBe(true);
  });
});
