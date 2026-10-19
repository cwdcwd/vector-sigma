import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const composeFiles = ['platforms/balena/registrar/docker-compose.yml', 'platforms/compose/compose.yaml'];

function publishedPorts(rel: string, service: string): string[] {
  const compose = parse(read(rel)) as { services?: Record<string, { ports?: Array<string | { published?: string; target?: number; host_ip?: string }> }> };
  const ports = compose.services?.[service]?.ports ?? [];
  return ports.map((entry) => typeof entry === 'string' ? entry : `${entry.host_ip ?? ''}:${entry.published ?? ''}:${entry.target ?? ''}`);
}

describe('gateway proxy hardening contract', () => {
  it.each(composeFiles)('%s keeps gateway and database host ports loopback-bound', (rel) => {
    expect(publishedPorts(rel, 'litellm')).toEqual(['127.0.0.1:4000:4000']);
    expect(publishedPorts(rel, 'dolt')).toEqual(['127.0.0.1:3326:3306']);
  });

  it('enables LiteLLM forwarded client IP handling', () => {
    const config = parse(read('images/litellm/litellm-config.yaml')) as { general_settings?: { use_x_forwarded_for?: boolean } };
    expect(config.general_settings?.use_x_forwarded_for).toBe(true);
  });

  it('documents liveness, proxy logging/trust, loopback ports, and ships the doc in both Hermes images', () => {
    const canonical = read('docs/gateway-ops.md');
    expect(canonical).toContain('## Gateway liveness and proxy front (logs, real client IPs, loopback)');
    expect(canonical).toContain('GET /api/status');
    expect(canonical).toContain('X-Litellm-Api-Key delete');
    expect(canonical).toContain("outside the network's dynamic");
    // Single source: both images COPY docs/gateway-ops.md straight from the
    // repo-root build context (no vendored copies to keep in sync).
    for (const dockerfile of ['images/hermes/Dockerfile', 'images/agent/Dockerfile']) {
      expect(read(dockerfile), dockerfile).toMatch(/^\s+docs\/gateway-ops\.md \\$/m);
    }
  });
});
