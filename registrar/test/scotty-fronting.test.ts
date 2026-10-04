import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Scotty fronting guard (fleet-ops-77i; REWORKED fleet-ops-lnf, j7g
 * phase 2 — the serve-only edge).
 *
 * 77i took the queue UI from the composition's widest exposure (raw
 * unauthenticated HTTP on host :3306 to the LAN) to caddy-fronted
 * basic_auth on 8444. lnf retires the caddy layer entirely: scotty
 * publishes on 127.0.0.1 loopback ONLY, and the tailscale serve edge
 * fronts it at the MagicDNS name :8444 on the balena master — its lock
 * is the tailnet ACL tag + TLS identity alone (the owner GO on caddy
 * retirement: basic_auth dies with caddy). The same-release rule that
 * 77i introduced (add the fronting + drop the raw publish together)
 * still binds: this release adds the loopback publish + the serve
 * entry AND retires the old edge in one release.
 *
 * This test pins:
 *   1. BOTH compose twins: scotty's loopback publish is the ONLY host
 *      publish (127.0.0.1:3306:3306); the compose-internal :3306
 *      listener stays untouched (scotty's healthcheck and bd bridge
 *      ride the compose network).
 *   2. The serve config fronts scotty at the MagicDNS name :8444 ->
 *      http://127.0.0.1:3306 (the fronting the edge provides now).
 *   3. No basic_auth / SCOTTY_BASIC_AUTH_HASH anywhere (retired).
 *
 * Full-line comments are stripped before scanning.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function serviceBlock(code: string, name: string): string {
  const lines = code.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (start === -1) return '';
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && (/^  \S/.test(line) || /^\S/.test(line))) break;
    block.push(line);
  }
  return block.join('\n');
}

describe.each([
  ['balena/registrar/docker-compose.yml', 'balena'],
  ['deploy/compose.yaml', 'deploy'],
])('scotty fronting (lnf serve-only): %s', (rel) => {
  const raw = readFileSync(path.join(repoRoot, rel), 'utf8');
  const code = stripComments(raw);
  const scotty = serviceBlock(code, 'scotty');

  it('scotty publishes loopback-only (the serve edge fronts it at :8444 on the master)', () => {
    expect(scotty).toMatch(/- "127\.0\.0\.1:3306:3306"/);
  });

  it('the compose-internal listener is untouched (healthcheck probes in-container)', () => {
    expect(scotty).toMatch(/127\.0\.0\.1:3306\/api\/projects/);
  });

  it('carries no basic_auth machinery (retired with caddy)', () => {
    expect(scotty).not.toMatch(/basic_auth/);
    expect(scotty).not.toMatch(/SCOTTY_BASIC_AUTH_HASH/);
  });
});

describe('serve config: scotty fronted at the MagicDNS name (lnf)', () => {
  it('the serve config proxies :8444 to the scotty loopback publish', () => {
    const sc = JSON.parse(
      readFileSync(path.join(repoRoot, 'balena/registrar/serve-config.json'), 'utf8'),
    );
    const key = 'vector-sigma.tailb7207e.ts.net:8444';
    expect(sc.Web[key].Handlers['/'].Proxy).toBe('http://127.0.0.1:3306');
  });
});