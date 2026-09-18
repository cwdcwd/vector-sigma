import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, seedDevice, getAuditRows, type TestEnv } from './helpers.js';
import { randomUUID } from 'node:crypto';

let env: TestEnv;
const fast = { memoryCostKiB: 256, timeCost: 1 };

beforeEach(async () => {
  env = await createTestEnv({ hashParams: fast });
});

describe('GET /healthz', () => {
  it('returns 200 without auth', async () => {
    const res = await env.request({ method: 'GET', url: '/healthz' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /v1/bootstrap — happy path', () => {
  it('delivers the bundle, consumes the slot, audits delivered', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const res = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(res.status).toBe(200);
    expect(res.body.bundle).toEqual(env.device.bundle);
    expect(res.body.bundle_version).toBe(1);
    expect(typeof res.body.delivered_at).toBe('string');

    const audit = await getAuditRows(env);
    expect(audit).toHaveLength(1);
    expect(audit[0].outcome).toBe('delivered');
    expect(audit[0].device_id).toBe(env.device.uuid);
    expect(audit[0].reason).toBeNull();
  });

  it('sets slot consumed + delivery_count=1 + delivered_at', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    const rows = await getSlot(env);
    expect(rows[0].state).toBe('consumed');
    expect(rows[0].delivery_count).toBe(1);
    expect(rows[0].delivered_at).not.toBeNull();
  });
});

describe('POST /v1/bootstrap — slot state machine (armed→consumed→auto-rearm)', () => {
  it('replay inside the window: 425 + Retry-After, audit slot_consumed', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const first = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(first.status).toBe(200);

    const second = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(second.status).toBe(425);
    const ra = Number(second.headers['retry-after']);
    expect(Number.isInteger(ra)).toBe(true);
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(3600);
    expect(second.body.retry_after_seconds).toBe(ra);

    const audit = await getAuditRows(env);
    expect(audit).toHaveLength(2);
    expect(audit[1].outcome).toBe('denied');
    expect(audit[1].reason).toBe('slot_consumed');
    expect(audit[1].device_id).toBe(env.device.uuid);
  });

  it('auto-rearms after the window and delivers again (delivery_count=2)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });

    const first = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(first.status).toBe(200);

    // 1s before window close: still 425.
    env.clock.advance(3_599_000);
    const early = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(early.status).toBe(425);

    // Window elapsed: delivers again without any explicit re-arm write.
    env.clock.advance(2_000);
    const again = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(again.status).toBe(200);
    expect(again.body.bundle).toEqual(env.device.bundle);

    const rows = await getSlot(env);
    expect(rows[0].delivery_count).toBe(2);

    const audit = await getAuditRows(env);
    expect(audit.filter((a) => a.outcome === 'delivered')).toHaveLength(2);
    expect(audit.filter((a) => a.outcome === 'denied')).toHaveLength(1);
  });
});

describe('POST /v1/bootstrap — two-factor rejection paths', () => {
  it('401 on unknown uuid (no device row), audited with device_id NULL', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const res = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: randomUUID() },
      key: env.device.key,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    const audit = await getAuditRows(env);
    expect(audit).toHaveLength(1);
    expect(audit[0].outcome).toBe('denied');
    expect(audit[0].reason).toBe('unknown_uuid');
    expect(audit[0].device_id).toBeNull();
  });

  it('401 on bad key with valid uuid', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const res = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: 'bk_totally-wrong-key',
    });
    expect(res.status).toBe(401);
    const audit = await getAuditRows(env);
    expect(audit[0].reason).toBe('bad_key');
    expect(audit[0].device_id).toBe(env.device.uuid);
  });

  it('401 on missing key', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const res = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: null });
    expect(res.status).toBe(401);
    const audit = await getAuditRows(env);
    expect(audit[0].reason).toBe('missing_key');
    expect(audit[0].key_id).toBeNull();
  });

  it('403 on pending device (key valid, uuid valid, status != active)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, status: 'pending', bundle: env.device.bundle });
    const res = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    const audit = await getAuditRows(env);
    expect(audit[0].reason).toBe('device_not_active');
    expect(audit[0].device_id).toBe(env.device.uuid);
  });

  it('403 on revoked device', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, status: 'revoked', bundle: env.device.bundle });
    const res = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(res.status).toBe(403);
    const audit = await getAuditRows(env);
    expect(audit[0].reason).toBe('device_not_active');
  });

  it('400 on malformed body (uuid not a uuid)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const res = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: 'not-a-uuid' }, key: env.device.key });
    expect(res.status).toBe(400);
    const audit = await getAuditRows(env);
    expect(audit[0].reason).toBe('invalid_body');
  });
});

describe('POST /v1/bootstrap — rate limiting', () => {
  it('429 + Retry-After after repeated key failures from one IP', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    for (let i = 0; i < 5; i++) {
      const res = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: 'bk_wrong' });
      expect(res.status).toBe(401);
    }
    const locked = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    const audit = await getAuditRows(env);
    expect(audit.filter((a) => a.outcome === 'denied' && a.reason === 'rate_limited')).toHaveLength(1);
  });
});

describe('GET /v1/status', () => {
  it('reports armed slot + bundle version for a provisioned device', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const res = await env.request({
      method: 'GET',
      url: `/v1/status?balena_uuid=${env.device.uuid}`,
      key: env.device.key,
    });
    expect(res.status).toBe(200);
    expect(res.body.balena_uuid).toBe(env.device.uuid);
    expect(res.body.device_status).toBe('active');
    expect(res.body.slot.state).toBe('armed');
    expect(res.body.slot.delivery_count).toBe(0);
    expect(res.body.slot.delivered_at).toBeNull();
    expect(res.body.bundle_version).toBe(1);
  });

  it('reports consumed after delivery, armed after auto-rearm window', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    const consumed = await env.request({ method: 'GET', url: `/v1/status?balena_uuid=${env.device.uuid}`, key: env.device.key });
    expect(consumed.status).toBe(200);
    expect(consumed.body.slot.state).toBe('consumed');
    expect(consumed.body.slot.delivery_count).toBe(1);

    env.clock.advance(3_600_000);
    const rearmed = await env.request({ method: 'GET', url: `/v1/status?balena_uuid=${env.device.uuid}`, key: env.device.key });
    expect(rearmed.body.slot.state).toBe('armed');
  });

  it('401 on bad key and on unknown uuid', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
    const badKey = await env.request({ method: 'GET', url: `/v1/status?balena_uuid=${env.device.uuid}`, key: 'bk_nope' });
    expect(badKey.status).toBe(401);
    const unknown = await env.request({ method: 'GET', url: `/v1/status?balena_uuid=${randomUUID()}`, key: env.device.key });
    expect(unknown.status).toBe(401);
  });
});

/** Slot row readback via raw SQL on the mem DB. */
async function getSlot(e: TestEnv): Promise<Array<Record<string, unknown>>> {
  const { sql } = await import('drizzle-orm');
  const res = await e.db.execute(
    sql`SELECT state, delivery_count, delivered_at FROM delivery_slots WHERE device_id = ${e.device.uuid}`,
  );
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
}