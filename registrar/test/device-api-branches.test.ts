/**
 * The device-facing API's refusals (src/app.ts), endpoint by endpoint: lockout after repeated
 * auth failures (429 + Retry-After, even for the right key), malformed bodies (400), missing or
 * wrong keys (401), and the not-yet-delivered states a fresh device reports.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { devices, identityBlobs } from '../src/db/schema.js';
import { createTestEnv, getAuditRows, seedAdminKey, seedDevice, type TestEnv } from './helpers.js';

const ADMIN_KEY = 'ak_test-device-api-0001';
let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({ hashParams: { memoryCostKiB: 256, timeCost: 1 } });
  await seedAdminKey(env.db, ADMIN_KEY);
  await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: env.device.bundle });
});

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const json = (method: 'GET' | 'POST', url: string, key?: string, payload?: unknown, ip = '10.9.9.9') =>
  env.app.inject({ method, url, headers: { ...(key ? bearer(key) : {}), 'content-type': 'application/json' }, payload: payload as object, remoteAddress: ip });

function publicKey(): string {
  const der = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

/** Five wrong keys from one IP, then the right key from the same IP is still locked out. */
async function expectLockout(call: (key: string) => Promise<{ statusCode: number; headers: Record<string, unknown> }>, goodKey: string) {
  for (let i = 0; i < 5; i++) await call(`bk_${randomUUID()}`);
  const res = await call(goodKey);
  expect(res.statusCode).toBe(429);
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
}

describe('/v1/status', () => {
  const status = (key?: string, uuid = env.device.uuid, ip?: string) =>
    json('GET', `/v1/status?balena_uuid=${encodeURIComponent(uuid)}`, key, undefined, ip);

  it('needs a key (401) and a well-formed uuid (400)', async () => {
    expect((await status()).statusCode).toBe(401);
    expect((await status(env.device.key, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('a device with no bundle yet reports bundle_version null and an armed slot', async () => {
    await env.db.delete(identityBlobs).where(eq(identityBlobs.deviceId, env.device.uuid));
    const res = await status(env.device.key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bundle_version: null, slot: { state: 'armed' } });
  });

  it('locks out an IP after repeated wrong keys', async () => {
    await expectLockout((k) => status(k, env.device.uuid, '10.1.1.1'), env.device.key);
  });
});

describe('/v1/bootstrap', () => {
  it('refuses a malformed body (400)', async () => {
    expect((await json('POST', '/v1/bootstrap', env.device.key, { balena_uuid: 'nope' })).statusCode).toBe(400);
  });

  it('a device whose bundle the owner has not saved yet gets a RETRYABLE 5xx, audited as no_bundle', async () => {
    // 5xx on purpose: the registrant treats 4xx as permanent and 5xx as "try again", and the
    // owner saving a bundle is exactly the condition that makes a retry succeed.
    await env.db.delete(identityBlobs).where(eq(identityBlobs.deviceId, env.device.uuid));
    const res = await json('POST', '/v1/bootstrap', env.device.key, { balena_uuid: env.device.uuid });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    const rows = await getAuditRows(env);
    expect(rows.some((r) => r.reason === 'no_bundle' && r.device_id === env.device.uuid)).toBe(true);
  });
});

describe('/v1/a2a-key', () => {
  const report = (key?: string, body: object = { balena_uuid: env.device.uuid, ed25519: publicKey() }, ip?: string) =>
    json('POST', '/v1/a2a-key', key, body, ip);

  it('needs the device key (401) and a well-formed report (400)', async () => {
    expect((await report()).statusCode).toBe(401);
    expect((await report(env.device.key, { balena_uuid: env.device.uuid, ed25519: 'short' })).statusCode).toBe(400);
  });

  it('a revoked device is refused (403) even with its own key', async () => {
    await env.db.update(devices).set({ status: 'revoked' }).where(eq(devices.balenaUuid, env.device.uuid));
    expect((await report(env.device.key)).statusCode).toBe(403);
  });

  it('accepts the key alone, then a later report carrying guard status and bundle version', async () => {
    const pub = publicKey();
    expect((await report(env.device.key, { balena_uuid: env.device.uuid, ed25519: pub })).json().status).toBe('active');
    const res = await report(env.device.key, { balena_uuid: env.device.uuid, ed25519: pub, guard_status: null, bundle_version: 1 });
    expect(res.json().status).toBe('unchanged');
  });

  it('locks out an IP after repeated wrong keys', async () => {
    await expectLockout((k) => report(k, undefined, '10.2.2.2'), env.device.key);
  });
});

describe('admin-key endpoints: /v1/re-arm and /v1/rotate', () => {
  it.each(['/v1/re-arm', '/v1/rotate'])('%s refuses a malformed body (400) and locks out wrong keys', async (url) => {
    expect((await json('POST', url, ADMIN_KEY, { balena_uuid: 'nope' })).statusCode).toBe(400);
    for (let i = 0; i < 5; i++) await json('POST', url, `ak_${randomUUID()}`, {}, '10.3.3.3');
    const res = await json('POST', url, ADMIN_KEY, { balena_uuid: env.device.uuid }, '10.3.3.3');
    expect(res.statusCode).toBe(429);
  });

  it('re-arm for an unknown device is a 404', async () => {
    const res = await json('POST', '/v1/re-arm', ADMIN_KEY, { balena_uuid: randomUUID() });
    expect(res.statusCode).toBe(404);
  });
});

describe('machine-auth mesh-enroll endpoints', () => {
  it.each([
    ['GET', '/v1/mesh-enroll/status'],
    ['POST', '/v1/mesh-enroll'],
  ] as const)('%s %s locks out an IP after repeated bad machine keys', async (method, url) => {
    for (let i = 0; i < 5; i++) await json(method, url, `mk_${randomUUID()}`, method === 'POST' ? {} : undefined, '10.4.4.4');
    const res = await json(method, url, `mk_${randomUUID()}`, method === 'POST' ? {} : undefined, '10.4.4.4');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited' });
  });
});
