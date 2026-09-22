import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vendored-source drift guard (fleet-ops-f57.6).
 *
 * balena remote-build contexts are confined to the app source dir, so
 * balena/devices/ and balena/registrar/ vendor the registrant,
 * registrar, and shared workspace sources byte-for-byte. This test
 * pins that: any edit to a workspace source that is not mirrored into
 * the vendored copy fails CI with the file list. To regenerate after
 * an upstream change (see each app dir's README for the full recipe):
 *
 *   cp registrant/src/*.ts balena/devices/registrant/src/
 *   cp shared/src/index.ts balena/devices/registrant/shared/src/
 *   cp -f registrar/src/*.ts balena/registrar/registrar/src/
 *   ... etc.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** canonical dir -> vendored copy, compared byte-exact. */
const vendoredFiles = [
  // devices app: registrant + shared
  ['registrant/src/client.ts', 'balena/devices/registrant/src/client.ts'],
  ['registrant/src/clock-gate.ts', 'balena/devices/registrant/src/clock-gate.ts'],
  ['registrant/src/config.ts', 'balena/devices/registrant/src/config.ts'],
  ['registrant/src/identity-store.ts', 'balena/devices/registrant/src/identity-store.ts'],
  ['registrant/src/index.ts', 'balena/devices/registrant/src/index.ts'],
  ['registrant/src/run.ts', 'balena/devices/registrant/src/run.ts'],
  ['registrant/tsconfig.json', 'balena/devices/registrant/tsconfig.json'],
  ['shared/src/index.ts', 'balena/devices/registrant/shared/src/index.ts'],
  ['shared/tsconfig.json', 'balena/devices/registrant/shared/tsconfig.json'],
  // registrar app: registrar sources + shared + migrations
  ['registrar/src/admin-auth.ts', 'balena/registrar/registrar/src/admin-auth.ts'],
  ['registrar/src/admin-html.ts', 'balena/registrar/registrar/src/admin-html.ts'],
  ['registrar/src/admin-key.ts', 'balena/registrar/registrar/src/admin-key.ts'],
  ['registrar/src/admin.ts', 'balena/registrar/registrar/src/admin.ts'],
  ['registrar/src/app.ts', 'balena/registrar/registrar/src/app.ts'],
  ['registrar/src/audit.ts', 'balena/registrar/registrar/src/audit.ts'],
  ['registrar/src/auth.ts', 'balena/registrar/registrar/src/auth.ts'],
  ['registrar/src/clock.ts', 'balena/registrar/registrar/src/clock.ts'],
  ['registrar/src/config.ts', 'balena/registrar/registrar/src/config.ts'],
  ['registrar/src/index.ts', 'balena/registrar/registrar/src/index.ts'],
  ['registrar/src/keys.ts', 'balena/registrar/registrar/src/keys.ts'],
  ['registrar/src/rate-limit.ts', 'balena/registrar/registrar/src/rate-limit.ts'],
  ['registrar/src/rotate.ts', 'balena/registrar/registrar/src/rotate.ts'],
  ['registrar/src/session.ts', 'balena/registrar/registrar/src/session.ts'],
  ['registrar/src/slots.ts', 'balena/registrar/registrar/src/slots.ts'],
  // f57.11: structured-fields renderer is a registrar source — vendored
  ['registrar/src/structured-fields.ts', 'balena/registrar/registrar/src/structured-fields.ts'],
  ['registrar/src/db/key-crypto.ts', 'balena/registrar/registrar/src/db/key-crypto.ts'],
  ['registrar/src/db/schema.ts', 'balena/registrar/registrar/src/db/schema.ts'],
  ['registrar/tsconfig.json', 'balena/registrar/registrar/tsconfig.json'],
  ['shared/src/index.ts', 'balena/registrar/registrar/shared/src/index.ts'],
  ['shared/tsconfig.json', 'balena/registrar/registrar/shared/tsconfig.json'],
  ['registrar/drizzle/0000_yielding_morlun.sql', 'balena/registrar/registrar/drizzle/0000_yielding_morlun.sql'],
  ['registrar/drizzle/meta/0000_snapshot.json', 'balena/registrar/registrar/drizzle/meta/0000_snapshot.json'],
  ['registrar/drizzle/meta/_journal.json', 'balena/registrar/registrar/drizzle/meta/_journal.json'],
  // f57.13: the CA shim ships in BOTH the deploy/ image and the balena
  // devices registrant image — one file, two COPY targets, byte-pinned.
  ['deploy/vs-entrypoint.sh', 'balena/devices/registrant/vs-entrypoint.sh'],
] as const;

describe('balena vendored sources', () => {
  it('are byte-for-byte identical to the workspace originals', () => {
    const drifted: string[] = [];
    for (const [original, vendored] of vendoredFiles) {
      const a = readFileSync(path.join(repoRoot, original), 'utf8');
      const b = readFileSync(path.join(repoRoot, vendored), 'utf8');
      if (a !== b) drifted.push(`${original} != ${vendored}`);
    }
    expect(
      drifted,
      `drift detected, regenerate vendored copies:\n${drifted.join('\n')}`,
    ).toEqual([]);
  });

  it('carry the pinned dependency versions of the root lockfile', () => {
    const lock = JSON.parse(
      readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
    );
    const pins: Record<string, string> = {
      'node_modules/zod': '3.25.76',
      'node_modules/typescript': '5.9.3',
      'node_modules/@types/node': '24.13.5',
      'node_modules/@node-rs/argon2': '2.2.1',
      'node_modules/drizzle-orm': '0.45.2',
      'node_modules/fastify': '5.12.5',
      'node_modules/pg': '8.23.0',
      'node_modules/@types/pg': '8.23.1',
    };
    const drifted: string[] = [];
    for (const [key, want] of Object.entries(pins)) {
      const got = lock.packages[key]?.version;
      if (got !== want) drifted.push(`${key}: lockfile ${got}, vendored pin ${want}`);
    }
    expect(
      drifted,
      `version pins drifted from root lockfile:\n${drifted.join('\n')}`,
    ).toEqual([]);
  });
});