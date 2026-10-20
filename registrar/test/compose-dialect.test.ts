import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Compose-dialect guard for runtime-expanded values (fleet-ops-1py.3;
 * REWRITTEN for the prebuilt `balena deploy` pipeline, registrar-v1.5.4).
 *
 * Every compose this repo ships is now parsed by compose-go before it
 * reaches a container:
 *
 *  - platforms/compose/compose.yaml — docker compose (compose-go).
 *  - platforms/balena/{registrar,devices}/docker-compose.yml — the release
 *    workflows `balena deploy` them; balena-cli 25 parses with
 *    @balena/compose-parser, which wraps compose-go with the OS env and
 *    .env. A single `$VAR` / `${VAR}` is interpolated at DEPLOY time from
 *    the release runner's environment, where it is unset — so it ships as
 *    "". registrar-v1.5.2/1.5.3 shipped the dolt probe as `-p ""`: dolt
 *    never went healthy and the supervisor restarted it every ~5 min. The
 *    postgres probe lost -U/-d the same way (silently: pg_isready passes
 *    without them). `$$` is compose-go's escape: it reaches the container
 *    as a single `$`, which the CMD-SHELL probe expands at probe time.
 *
 * (The old rule here — "no $$ on balena" — was right for the retired
 * `balena push` remote builder, which stored `$$` literally; release
 * 4370090. That builder is no longer in the path.)
 *
 * This guard pins:
 *   1. the balena composes: NO single-$ interpolation anywhere — there is
 *      no deploy-time environment to interpolate from; every `$` is `$$`.
 *   2. compose.yaml: every healthcheck probe uses `$$` (a single `$` would
 *      bake values — DOLT_PASSWORD included — into `docker inspect`).
 *      Config-time ${VAR:?...} for service environment stays allowed.
 *
 * Full-line comments are stripped before scanning; the files carry
 * documentation comments that mention `$` forms in prose.
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

/** Lines that still carry a `$` once every escaped `$$` is removed. */
function singleDollarLines(code: string): string[] {
  return code.split('\n').filter((l) => l.replaceAll('$$', '').includes('$'));
}

const read = (rel: string) => stripComments(readFileSync(path.join(repoRoot, rel), 'utf8'));

for (const rel of [
  'platforms/balena/registrar/docker-compose.yml',
  'platforms/balena/devices/docker-compose.yml',
]) {
  describe(`compose dialect guard: ${rel}`, () => {
    it('carries no single-$ interpolation (balena deploy would expand it to "" on the release runner)', () => {
      expect(singleDollarLines(read(rel))).toEqual([]);
    });
  });
}

describe('compose dialect guard: the registrar probes', () => {
  for (const rel of ['platforms/balena/registrar/docker-compose.yml', 'platforms/compose/compose.yaml']) {
    const code = read(rel);
    it(`${rel}: dolt probe defers DOLT_PASSWORD to the container shell ($$)`, () => {
      const probe = code.split('\n').find((l) => l.includes('dolt --host'));
      expect(probe).toBeDefined();
      expect(probe!).toContain('-p \\"$$DOLT_PASSWORD\\"');
    });
    it(`${rel}: postgres probe defers its role + database to the container shell ($$)`, () => {
      const probe = code.split('\n').find((l) => l.includes('pg_isready'));
      expect(probe).toBeDefined();
      expect(probe!).toContain('-U $${POSTGRES_USER} -d $${POSTGRES_DB}');
    });
  }
});

describe('compose dialect guard: platforms/compose/compose.yaml', () => {
  it('every healthcheck probe is free of config-time interpolation', () => {
    const probes = read('platforms/compose/compose.yaml')
      .split('\n')
      .filter((l) => l.includes('CMD-SHELL'));
    expect(probes.length).toBeGreaterThan(0);
    expect(singleDollarLines(probes.join('\n'))).toEqual([]);
  });
});
