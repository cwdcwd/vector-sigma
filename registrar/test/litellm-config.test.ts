import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = readFileSync(path.join(repoRoot, 'balena/registrar/litellm-config.yaml'), 'utf8');

function explicitGroup(name: string): string {
  const start = config.indexOf(`  - model_name: ollama-cloud/${name}`);
  expect(start, `${name} group must exist`).toBeGreaterThanOrEqual(0);
  const rest = config.slice(start);
  const next = rest.indexOf('  - model_name:', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('Ollama Cloud native route configuration', () => {
  it('routes both explicit groups through native ollama_chat without the /v1 base', () => {
    for (const version of ['glm-5.3', 'glm-5.2']) {
      const group = explicitGroup(version);
      expect(group).toContain(`model: ollama_chat/${version}`);
      expect(group).toMatch(/api_base: https:\/\/ollama\.com(?:\s|$)/);
      const apiBase = (/^\s+api_base:\s*([^#\n]+)/m.exec(group)?.[1] ?? '').trim();
      expect(apiBase).not.toContain('/v1');
    }
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
});
