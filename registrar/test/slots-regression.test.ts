import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { buildApp } from '../src/app.js';
import { readSlot } from '../src/slots.js';
import { hashKey } from '../src/db/key-crypto.js';
import { AuthRateLimiter } from '../src/rate-limit.js';
import { randomUUID } from 'node:crypto';
import type { IdentityBundle } from '@vector-sigma/shared';
import {
  createMemDb,
  patchMemPgQuery,
  seedDevice,
  TEST_CONFIG,
  FakeClock,
  type DB,
} from './helpers.js';

/**
 * Run-4 E2E regression (2026-09-18): registrar 500s on every replay/status
 * call — TypeError: snapshot.rearmsAt.getTime is not a function.
 *
 * Root cause: readSlot selects rearmsAt as a RAW sql expression
 * (delivered_at + auto_rearm_after), which bypasses drizzle's column type
 * mapping. On real pg, drizzle's node-postgres session deliberately disables
 * pg's temporal type parsers (session.cjs rawQueryConfig: identity parser
 * for TIMESTAMPTZ/TIMESTAMP/DATE/INTERVAL) and relies on each TYPED column's
 * mapFromDriverValue to restore Date objects — a raw fragment gets NO
 * mapper, so rearmsAt arrives as the wire STRING pg emits ("2026-01-01
 * 01:00:00+00"). pg-mem instead returns real Date objects in-process, which
 * is why the unit suite (56/56) never saw the crash while the volume-backed
 * E2E 500'd on the very first replay.
 *
 * This rig makes pg-mem DRIVER-FAITHFUL: wrapWireFaithful() converts every
 * temporal value in every result row to the exact wire text real pg emits,
 * reproducing the driver contract without a Postgres server (devpi03 has no
 * docker runtime; a testcontainers/compose variant can subsume this when
 * every builder lane has one). The meta-assertion inside each test proves
 * the wrapper is active (raw select still returns a string), so the test
 * cannot silently degrade back to pg-mem's Date objects and pass vacuously.
 *
 * Red at the pre-fix head: readSlot hands the string through, the replay
 * 500s exactly as devpi05 saw it. Green with the boundary mapping in
 * readSlot (rearmsAt: r.rearmsAt ? new Date(r.rearmsAt) : null).
 */

/** Postgres wire text for a Date — what node-postgres returns after drizzle's identity parser. */
function pgWireText(d: Date): string {
  // pg emits microsecond precision with a space separator and numeric offset:
  // 2026-01-01 01:00:00.123456+00 (V8 Date holds ms; format stays wire-shaped).
  return d.toISOString().replace('T', ' ').replace('Z', '+00');
}

/**
 * Wrap a pg-mem Pool instance so RESULT rows carry temporal values as the
 * wire strings real pg returns (after drizzle disables pg's parsers).
 * Sits on the instance, above the prototype patch from patchMemPgQuery;
 * MemPg.connect() hands out the same instance, so transactional queries
 * are covered too. Params are untouched (mapToDriverValue still applies).
 */
function wrapWireFaithful(pool: { query: (...a: unknown[]) => Promise<unknown> }): void {
  const orig = pool.query.bind(pool);
  const toWire = (v: unknown): unknown => (v instanceof Date ? pgWireText(v) : v);
  pool.query = (async (query: unknown, values?: unknown[]) => {
    const res = (await orig(query, values)) as {
      rows: Array<Record<string, unknown> | unknown[]>;
    };
    const rows = res.rows.map((row) =>
      Array.isArray(row) ? row.map(toWire) : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toWire(v)])),
    );
    return { ...res, rows };
  }) as typeof pool.query;
}

/** Full app over a driver-faithful pg-mem DB (same shape as createTestEnv). */
function createWireFaithfulEnv() {
  const memDb: DB = createMemDb();
  const pgModule = memDb.adapters.createPg();
  patchMemPgQuery(pgModule);
  const pool = new pgModule.Pool();
  wrapWireFaithful(pool);
  const db = drizzle(pool) as unknown as NodePgDatabase;
  const clock = new FakeClock();
  const limiter = new AuthRateLimiter(clock, 900_000, 5);
  const app = buildApp({ db, config: TEST_CONFIG, clock, limiter });

  const uuid = randomUUID();
  const key = `bk_${randomUUID()}`;
  const bundle: IdentityBundle = {
    schema_version: 1,
    bundle_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    files: [{ path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=test\n' }],
  };

  const request = async (o: { method: string; url: string; body?: object }) => {
    const res = await app.inject({
      method: o.method as never,
      url: o.url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
    });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(res.body);
    } catch {
      /* non-JSON body */
    }
    return { status: res.statusCode, headers: res.headers as Record<string, string>, body };
  };

  return { db, clock, request, device: { uuid, key, bundle } };
}

describe('driver-faithful regression — raw-fragment rearmsAt is a WIRE STRING on real pg (run-4 E2E)', () => {
  it('readSlot maps the raw fragment to a real Date (projection contract)', async () => {
    const env = createWireFaithfulEnv();
    const hash = await hashKey(env.device.key, { memoryCostKiB: 256, timeCost: 1 });
    await seedDevice(env.db, { uuid: env.device.uuid, hash, bundle: env.device.bundle });
    const first = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid } });
    expect(first.status).toBe(200); // first delivery works (typed columns) — AC1 parity

    // Meta: the wrapper is active — the raw expression still comes back a
    // string at the driver layer. This is the shape that killed run 4.
    const raw = (await env.db.execute(
      sql`SELECT delivered_at + auto_rearm_after AS r FROM delivery_slots WHERE device_id = ${env.device.uuid}`,
    )) as unknown as { rows: Array<{ r: unknown }> };
    expect(typeof raw.rows[0].r).toBe('string');

    // The contract: the snapshot readSlot hands out carries a real Date.
    const snap = await readSlot(env.db, env.device.uuid);
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe('consumed');
    expect(snap!.rearmsAt).toBeInstanceOf(Date);
  });

  it('replay → 425 + Retry-After, status → 200 (run-4 AC2/AC4 were 500s)', async () => {
    const env = createWireFaithfulEnv();
    const hash = await hashKey(env.device.key, { memoryCostKiB: 256, timeCost: 1 });
    await seedDevice(env.db, { uuid: env.device.uuid, hash, bundle: env.device.bundle });
    const first = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid } });
    expect(first.status).toBe(200);

    // Replay inside the window: 425 with Retry-After (run-4 got 500 + TypeError).
    const replay = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid } });
    expect(replay.status).toBe(425);
    const ra = Number(replay.headers['retry-after']);
    expect(Number.isInteger(ra)).toBe(true);
    expect(ra).toBeGreaterThan(0);
    expect(replay.body.retry_after_seconds).toBe(ra);

    // Status reads the effective slot state (run-4 AC4 got 500).
    const status = await env.request({ method: 'GET', url: `/v1/status?balena_uuid=${env.device.uuid}` });
    expect(status.status).toBe(200);
    expect(status.body.slot).toMatchObject({ state: 'consumed', delivery_count: 1 });

    // Past the window the slot auto-rearms and delivers again (run-4 AC3 path).
    env.clock.advance(3_601_000);
    const again = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid } });
    expect(again.status).toBe(200);
  });
});