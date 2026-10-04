import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Compose-dialect guard for healthcheck probes (fleet-ops-1py.3;
 * REWORKED fleet-ops-lnf, j7g phase 2 — the caddy healthcheck is gone
 * with the caddy service).
 *
 * The two composes are written in DIFFERENT dialects on purpose:
 *
 *  - deploy/compose.yaml is driven by docker compose, which de-escapes
 *    `$$` -> `$` at config time. Its `$$` is the documented, correct way
 *    to defer expansion to the in-container shell.
 *
 *  - balena/registrar/docker-compose.yml is built by balena's remote
 *    builder, which does NOT de-escape `$$` — it is stored literally,
 *    the CMD-SHELL probe expands it to the shell PID, and the
 *    supervisor restart-loops the service ~every 95s. Proven live on
 *    release 4370090 (master device 13681815, the caddy TLS probe).
 *
 * lnf removed the caddy service (and with it the $$ healthcheck that
 * this guard originally pinned), but the DIALECT CONTRACT still binds
 * every runtime-expanded probe in the balena compose — postgres
 * (${POSTGRES_USER}) and dolt ($DOLT_PASSWORD) carry it today. This
 * guard pins:
 *
 *   1. balena/registrar/docker-compose.yml: NO `$$` anywhere — every
 *      runtime-expanded healthcheck must use single-$ / ${VAR} shapes,
 *      the form proven on-device.
 *   2. deploy/compose.yaml: the dolt probe KEEPS its `$$` (docker
 *      compose de-escapes; single-$ would let the ${VAR} interpolation
 *      parser eat DOLT_PASSWORD at config time — a secret leak into
 *      `docker inspect` output).
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
});

describe('compose dialect guard: deploy/compose.yaml', () => {
  const code = stripComments(
    readFileSync(path.join(repoRoot, 'deploy/compose.yaml'), 'utf8'),
  );

  it('dolt healthcheck keeps $$ (runtime expansion of DOLT_PASSWORD must not leak through config-time interpolation)', () => {
    // The raw file carries the literal $$ bytes (comment lines may
    // legitimately mention $$ in prose, so scan only the live probe
    // line): find the dolt probe line in the comment-stripped code
    // and assert its expansion shape directly.
    const probe = code.split('\n').find((l) => l.includes('dolt --host'));
    expect(probe).toBeDefined();
    expect(probe!).toContain('\$\$DOLT_PASSWORD');
    expect(probe!).not.toContain('\${DOLT_PASSWORD}');
  });
});