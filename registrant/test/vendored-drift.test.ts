import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  // f57.14: the registrar app's OWN registrant (primus bootstrap) vendors
  // the same registrant + shared sources — byte-pinned like the devices copy.
  ['registrant/src/client.ts', 'balena/registrar/registrant-own/src/client.ts'],
  ['registrant/src/clock-gate.ts', 'balena/registrar/registrant-own/src/clock-gate.ts'],
  ['registrant/src/config.ts', 'balena/registrar/registrant-own/src/config.ts'],
  ['registrant/src/identity-store.ts', 'balena/registrar/registrant-own/src/identity-store.ts'],
  ['registrant/src/index.ts', 'balena/registrar/registrant-own/src/index.ts'],
  ['registrant/src/run.ts', 'balena/registrar/registrant-own/src/run.ts'],
  ['registrant/tsconfig.json', 'balena/registrar/registrant-own/tsconfig.json'],
  ['shared/src/index.ts', 'balena/registrar/registrant-own/shared/src/index.ts'],
  ['shared/tsconfig.json', 'balena/registrar/registrant-own/shared/tsconfig.json'],
  ['balena/devices/registrant/vs-entrypoint.sh', 'balena/registrar/registrant-own/vs-entrypoint.sh'],
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
  // e5o.3: the memory-key mint client is a registrar source — vendored
  ['registrar/src/gateway-mint.ts', 'balena/registrar/registrar/src/gateway-mint.ts'],
  ['registrar/src/index.ts', 'balena/registrar/registrar/src/index.ts'],
  ['registrar/src/keys.ts', 'balena/registrar/registrar/src/keys.ts'],
  ['registrar/src/rate-limit.ts', 'balena/registrar/registrar/src/rate-limit.ts'],
  ['registrar/src/rotate.ts', 'balena/registrar/registrar/src/rotate.ts'],
  ['registrar/src/session.ts', 'balena/registrar/registrar/src/session.ts'],
  ['registrar/src/slots.ts', 'balena/registrar/registrar/src/slots.ts'],
  // f57.11: structured-fields renderer is a registrar source — vendored
  ['registrar/src/structured-fields.ts', 'balena/registrar/registrar/src/structured-fields.ts'],
  // j7g.1: the A2A mesh-enroll module is a registrar source — vendored
  ['registrar/src/mesh-enroll.ts', 'balena/registrar/registrar/src/mesh-enroll.ts'],
  // zbq.2: embedded persona library (generated module) is a registrar source — vendored
  ['registrar/src/persona-library.ts', 'balena/registrar/registrar/src/persona-library.ts'],
  ['registrar/src/db/key-crypto.ts', 'balena/registrar/registrar/src/db/key-crypto.ts'],
  ['registrar/src/db/schema.ts', 'balena/registrar/registrar/src/db/schema.ts'],
  ['registrar/tsconfig.json', 'balena/registrar/registrar/tsconfig.json'],
  ['shared/src/index.ts', 'balena/registrar/registrar/shared/src/index.ts'],
  ['shared/tsconfig.json', 'balena/registrar/registrar/shared/tsconfig.json'],
  ['registrar/drizzle/0000_yielding_morlun.sql', 'balena/registrar/registrar/drizzle/0000_yielding_morlun.sql'],
  ['registrar/drizzle/0001_mesh_enroll_keys.sql', 'balena/registrar/registrar/drizzle/0001_mesh_enroll_keys.sql'],
  ['registrar/drizzle/meta/0000_snapshot.json', 'balena/registrar/registrar/drizzle/meta/0000_snapshot.json'],
  ['registrar/drizzle/meta/0001_snapshot.json', 'balena/registrar/registrar/drizzle/meta/0001_snapshot.json'],
  ['registrar/drizzle/meta/_journal.json', 'balena/registrar/registrar/drizzle/meta/_journal.json'],
  // f57.13: the CA shim ships in BOTH the deploy/ image and the balena
  // devices registrant image — one file, two COPY targets, byte-pinned.
  ['deploy/vs-entrypoint.sh', 'balena/devices/registrant/vs-entrypoint.sh'],
  // j7g.1: the devices app vendors the queue docs (the Dockerfile.agent-
  // hermes COPY docs surface) — byte-pinned to docs/ at the repo root,
  // same pattern as the registrar app's vendored docs.
  // e5o.1: each image vendors ITS OWN map — the devices set is
  // queue-conventions.md + device-environment.md (the WORKER map);
  // vs-environment.md (the master map) is the registrar app's vendored
  // set ONLY. A device agent reading primus's map is the shipped
  // identity defect this lane fixes — guarded by the dedicated wrong-map
  // regression test below, not just this byte-pin list.
  ['docs/queue-conventions.md', 'balena/devices/docs/queue-conventions.md'],
  ['docs/device-environment.md', 'balena/devices/docs/device-environment.md'],
  // the master image's vendored set (curator + master map):
  ['docs/queue-conventions.md', 'balena/registrar/docs/queue-conventions.md'],
  ['docs/vs-environment.md', 'balena/registrar/docs/vs-environment.md'],
  // e5o.4: the A2A operational conventions doc ships in BOTH images
  // (role-neutral — correct for master and device alike).
  ['docs/a2a-conventions.md', 'balena/devices/docs/a2a-conventions.md'],
  ['docs/a2a-conventions.md', 'balena/registrar/docs/a2a-conventions.md'],
  // e5o.6: the gateway ops runbook ships in BOTH images too (the
  // owner + the master coordinator are its audience, but device
  // agents run the read-only probes) — one doc, one truth.
  ['docs/gateway-ops.md', 'balena/registrar/docs/gateway-ops.md'],
  ['docs/gateway-ops.md', 'balena/devices/docs/gateway-ops.md'],
  // e5o.3: the memory conventions doc ships in BOTH images (every
  // agent is its audience) — one doc, one truth.
  ['docs/memory-conventions.md', 'balena/registrar/docs/memory-conventions.md'],
  ['docs/memory-conventions.md', 'balena/devices/docs/memory-conventions.md'],
  // j7g.1: the A2A mesh wiring hook ships in THREE places — deploy/
  // (canonical), the devices agent image, and the registrar's primus
  // image — one file, three COPY targets, byte-pinned (the vs-entrypoint
  // pattern).
  ['deploy/vs-a2a-wiring.sh', 'balena/devices/agent/vs-a2a-wiring.sh'],
  ['deploy/vs-a2a-wiring.sh', 'balena/registrar/vs-a2a-wiring.sh'],
  // e5o.3: the gateway-memory plugin ships in THREE places — deploy/
  // gateway-memory/ (canonical), and the two balena app dirs the images
  // COPY from — byte-pinned per file (the vs-entrypoint one-file pattern
  // extended to the plugin's file set, provenance-sha256.txt included:
  // the stamp is data, drift in IT is drift too).
  ['deploy/gateway-memory/PROVENANCE.md', 'balena/registrar/gateway-memory/PROVENANCE.md'],
  ['deploy/gateway-memory/README.md', 'balena/registrar/gateway-memory/README.md'],
  ['deploy/gateway-memory/__init__.py', 'balena/registrar/gateway-memory/__init__.py'],
  ['deploy/gateway-memory/plugin.yaml', 'balena/registrar/gateway-memory/plugin.yaml'],
  ['deploy/gateway-memory/schemas.py', 'balena/registrar/gateway-memory/schemas.py'],
  ['deploy/gateway-memory/tools.py', 'balena/registrar/gateway-memory/tools.py'],
  ['deploy/gateway-memory/skills/gateway-memory/SKILL.md', 'balena/registrar/gateway-memory/skills/gateway-memory/SKILL.md'],
  ['deploy/gateway-memory/provenance-sha256.txt', 'balena/registrar/gateway-memory/provenance-sha256.txt'],
  ['deploy/gateway-memory/PROVENANCE.md', 'balena/devices/agent/gateway-memory/PROVENANCE.md'],
  ['deploy/gateway-memory/README.md', 'balena/devices/agent/gateway-memory/README.md'],
  ['deploy/gateway-memory/__init__.py', 'balena/devices/agent/gateway-memory/__init__.py'],
  ['deploy/gateway-memory/plugin.yaml', 'balena/devices/agent/gateway-memory/plugin.yaml'],
  ['deploy/gateway-memory/schemas.py', 'balena/devices/agent/gateway-memory/schemas.py'],
  ['deploy/gateway-memory/tools.py', 'balena/devices/agent/gateway-memory/tools.py'],
  ['deploy/gateway-memory/skills/gateway-memory/SKILL.md', 'balena/devices/agent/gateway-memory/skills/gateway-memory/SKILL.md'],
  ['deploy/gateway-memory/provenance-sha256.txt', 'balena/devices/agent/gateway-memory/provenance-sha256.txt'],
  // e5o.3: the memory-tools boot hook ships in THREE places — deploy/
  // (canonical) + both balena app dirs (the a2a-wiring one-file pattern).
  ['deploy/vs-memory-tools.sh', 'balena/registrar/vs-memory-tools.sh'],
  ['deploy/vs-memory-tools.sh', 'balena/devices/agent/vs-memory-tools.sh'],
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

  // e5o.1 — the wrong-map regression guard. Before this lane the devices
  // image vendored primus's MASTER map byte-identical (vs-environment.md),
  // so a device agent opened its own environment doc and read "You are
  // primus … the queue CURATOR" plus a queue host (dolt:3306) that is
  // unreachable from a device. The byte-pin list above proves the
  // vendored copies match the ROOT docs; THIS test proves each image
  // vendors its OWN map — the set membership, the identity direction,
  // and the device map's worker framing are all asserted so a re-vendor
  // slip fails CI with the cause, not a live device agent.
  it('e5o.1: each image vendors its own environment map (wrong-map regression)', () => {
    const devicesDocs = path.join(repoRoot, 'balena/devices/docs');
    const registrarDocs = path.join(repoRoot, 'balena/registrar/docs');

    // The devices vendored set: the WORKER map, never the master's.
    expect(
      existsSync(path.join(devicesDocs, 'device-environment.md')),
      'devices app must vendor docs/device-environment.md',
    ).toBe(true);
    expect(
      existsSync(path.join(devicesDocs, 'queue-conventions.md')),
      'devices app must vendor docs/queue-conventions.md',
    ).toBe(true);
    expect(
      existsSync(path.join(devicesDocs, 'vs-environment.md')),
      'devices app must NOT vendor the master map (vs-environment.md) — a device agent reading "You are primus" is the e5o.1 defect',
    ).toBe(false);

    // The master image's vendored set: the MASTER map, never the device's.
    expect(
      existsSync(path.join(registrarDocs, 'vs-environment.md')),
      'registrar app must vendor docs/vs-environment.md (primus\'s own map)',
    ).toBe(true);
    expect(
      existsSync(path.join(registrarDocs, 'device-environment.md')),
      'registrar app must NOT vendor the device map — each image carries its own set',
    ).toBe(false);

    // The device map must carry the worker identity framing, never the
    // coordinator's: "You are primus" anywhere in the devices vendored
    // docs is the shipped defect verbatim. Swept across EVERY file the
    // devices image vendors (a2a-conventions, future additions) — a
    // hardcode list would let a new vendored doc reintroduce the defect.
    for (const doc of readdirSync(devicesDocs)) {
      const body = readFileSync(path.join(devicesDocs, doc), 'utf8');
      expect(
        body.includes('You are primus'),
        `balena/devices/docs/${doc} carries the master-map identity framing ("You are primus") — the e5o.1 defect`,
      ).toBe(false);
    }

    // The device map must name the worker join contract (the LAN :3326
    // queue host, delivered via the bundle) — the master map's
    // compose-internal dolt:3306 is unreachable from a device and must
    // not be the only queue host a device agent can find.
    const deviceMap = readFileSync(
      path.join(devicesDocs, 'device-environment.md'),
      'utf8',
    );
    expect(deviceMap).toMatch(/:3326/);
    expect(deviceMap).toMatch(/WORKER/);
    expect(deviceMap).toMatch(/NEVER run `bd init`/);
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