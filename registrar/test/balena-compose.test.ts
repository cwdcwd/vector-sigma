import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Balena compose builder-contract guard (fleet-ops-f57.20).
 *
 * The balena remote builder / supervisor validates compose files with
 * @balena/compose, which rejects long-form depends_on entries with:
 *   Only "service_started" type of service dependency is supported
 * (registrar-v1.1.0 deploy run 36155320589 failed on exactly this).
 * Plain docker compose accepts the long-form — so CI's compose-simulated
 * E2E (deploy/, plain docker) stays green while the balena deploy breaks.
 * This test pins the builder contract on BOTH balena app composes so the
 * divergence class can never silently return:
 *
 *   1. no `condition:` key anywhere (service_healthy /
 *      service_completed_successfully are both builder-rejected),
 *   2. the load-bearing `version: "2.4"` pin stays (without it the
 *      balena CLI falls back to the legacy v1 schema and rejects every
 *      modern service key).
 *
 * Full-line comments are stripped before scanning; the file carries
 * documentation comments that legitimately mention both shapes.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const composes = [
  'balena/registrar/docker-compose.yml',
  'balena/devices/docker-compose.yml',
];

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe.each(composes)('balena builder contract: %s', (rel) => {
  const raw = readFileSync(path.join(repoRoot, rel), 'utf8');
  const code = stripComments(raw);

  it('carries no long-form depends_on condition (builder rejects non-service_started)', () => {
    expect(code).not.toMatch(/^\s*condition:/m);
  });

  it('keeps the load-bearing compose version 2.4 pin', () => {
    expect(code).toMatch(/^version:\s*"2\.4"$/m);
  });
});