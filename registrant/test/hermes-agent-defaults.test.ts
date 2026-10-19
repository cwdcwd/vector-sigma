import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template = readFileSync(path.join(repoRoot, 'images/agent/hermes-agent-defaults.yaml'), 'utf8');

function render(source: string, env: Record<string, string>): string {
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => env[name] ?? fallback ?? `\u0024{${name}}`);
}

describe('device Hermes defaults template', () => {
  it('renders the six defaults and permits every runtime override', () => {
    const defaults = render(template, {});
    expect(defaults).toContain('threshold_tokens: 128000');
    expect(defaults).toContain('max_bytes: 20000');
    expect(defaults).toContain('file_read_max_chars: 40000');
    expect(defaults).toContain('mcp_result_size_chars: 20000');
    expect(defaults).toContain('context_length: 1000000');
    expect(defaults).toContain('provider: custom');
    expect(defaults).toContain('model: \"${VS_HERMES_SUMMARY_MODEL}\"');
    expect(defaults).toContain('base_url: \"${GATEWAY_URL}\"');

    const overridden = render(template, {
      VS_HERMES_COMPRESSION_THRESHOLD_TOKENS: '64000',
      VS_HERMES_TOOL_OUTPUT_MAX_BYTES: '12000',
      VS_HERMES_FILE_READ_MAX_CHARS: '25000',
      VS_HERMES_MCP_RESULT_SIZE_CHARS: '9000',
      VS_HERMES_CONTEXT_LENGTH: '512000',
      VS_HERMES_SUMMARY_MODEL: 'custom/summary-model',
      GATEWAY_URL: 'https://gateway.example.invalid/v1',
    });
    expect(overridden).toContain('threshold_tokens: 64000');
    expect(overridden).toContain('max_bytes: 12000');
    expect(overridden).toContain('file_read_max_chars: 25000');
    expect(overridden).toContain('mcp_result_size_chars: 9000');
    expect(overridden).toContain('context_length: 512000');
    expect(overridden).toContain('model: \"custom/summary-model\"');
    expect(overridden).toContain('base_url: \"https://gateway.example.invalid/v1\"');
  });
});
