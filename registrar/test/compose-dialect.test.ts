import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Compose-dialect guard for healthcheck probes (fleet-ops-1py.3).
 *
 * The two caddy composes are written in DIFFERENT dialects on purpose:
 *
 *  - deploy/compose.yaml is driven by docker compose, which de-escapes
 *    `$$` -> `$` at config time. Its `$$` is the documented, correct way
 *    to defer expansion to the in-container shell.
 *
 *  - balena/registrar/docker-compose.yml is built by balena's remote
 *    builder, which does NOT de-escape `$$` — it is stored literally,
 *    the CMD-SHELL probe expands it to the shell PID, the curl
 *    --resolve arg is corrupted, and the supervisor restart-loops caddy
 *    ~every 95s. Proven live on release 4370090 (master device 13681815,
 *    registrar-v1.1.4): 19 clean SIGTERM cycles in a 30m window;
 *    byte-exact in-container replay of the stored string -> curl RC=49,
 *    identical single-$ control -> RC=0.
 *
 * Because CI's E2E exercises the deploy/ dialect (compose-simulated,
 * where `$$` de-escapes properly), the balena dialect bug sails through
 * every gate — exactly how PR #29 shipped it. This test pins both
 * dialects so the divergence is enforced, not remembered:
 *
 *   1. balena/registrar/docker-compose.yml: NO `$$` anywhere — every
 *      runtime-expanded healthcheck must use single-$ / ${VAR} shapes,
 *      the form already proven on-device by the postgres and dolt probes.
 *   2. deploy/compose.yaml: the caddy healthcheck keeps its `$$` (docker
 *      compose de-escapes; downgrading it to single-$ would let the
 *      ${VAR} interpolation parser eat TLS_HOSTNAME at config time).
 *
 * Full-line comments are stripped before scanning; both files carry
 * documentation comments that legitimately mention `$$` in prose.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The caddy TLS healthcheck probe line(s) in a comment-stripped compose. */
function caddyProbeLines(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => line.includes('CMD-SHELL') && line.includes('curl -fsk'));
}

describe('compose dialect guard: balena/registrar/docker-compose.yml', () => {
  const code = stripComments(
    readFileSync(
      path.join(repoRoot, 'balena/registrar/docker-compose.yml'),
      'utf8',
    ),
  );

  it('carries no $$ (balena builder stores it literally -> restart-loop; fleet-ops-1py.3)', () => {
    expect(code).not.toContain('$$');
  });

  it('caddy healthcheck probes the TLS front door with single-$ runtime expansion', () => {
    const probes = caddyProbeLines(code);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toContain('--resolve \\"${TLS_HOSTNAME:-vsigma.lan}:443:127.0.0.1\\"');
    expect(probes[0]).toContain('https://${TLS_HOSTNAME:-vsigma.lan}/healthz');
    expect(probes[0]).not.toContain('$$');
  });
});

describe('compose dialect guard: deploy/compose.yaml', () => {
  const code = stripComments(
    readFileSync(path.join(repoRoot, 'deploy/compose.yaml'), 'utf8'),
  );

  it('caddy healthcheck keeps $$ (docker compose de-escapes; runtime TLS_HOSTNAME must not reach the ${VAR} parser)', () => {
    const probes = caddyProbeLines(code);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toContain('--resolve \\"$${TLS_HOSTNAME:-vsigma.lan}:443:127.0.0.1\\"');
    expect(probes[0]).toContain('https://$${TLS_HOSTNAME:-vsigma.lan}/healthz');
  });
});
