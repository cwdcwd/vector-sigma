/**
 * Signed A2A identity, registrar side (docs/a2a-signed-identity.md): device key reports, the
 * conflict alarm, peer_keys distribution through the rotate plane, and the owner-gated strict
 * switch. pg-mem with the real drizzle migrations.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IdentityBundle } from '@vector-sigma/shared';
import { hashKey } from '../src/db/key-crypto.js';
import { identityBlobs, a2aPublicKeys } from '../src/db/schema.js';
import {
  A2aKeyError,
  approveDeviceKey,
  getStrict,
  keyFingerprint,
  readiness,
  registerDeviceKey,
  reportGuardStatus,
  revokeDeviceKey,
  setStrict,
} from '../src/a2a-keys.js';
import { createTestEnv, seedDevice, seedAdminKey, getAuditRows, AdminClient, extractCsrf, type TestEnv } from './helpers.js';

function newPublicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

function a2aBundle(me: string, peer: string): IdentityBundle {
  return {
    schema_version: 1,
    bundle_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    files: [
      { path: 'config/agent.env', mode: '0600', content: `AGENT_NAME=${me}\n` },
      {
        path: 'config/a2a.json',
        mode: '0600',
        content: JSON.stringify({
          identity_key: `sk-${me}-mesh`,
          trusted_peers: [peer],
          peer_tokens: { [peer]: `sk-${peer}-mesh` },
          public_url: `https://${me}.synth-tailnet.ts.net:9900`,
        }) + '\n',
      },
    ],
  };
}

async function a2aOf(env: TestEnv, uuid: string): Promise<{ a2a: Record<string, unknown>; version: number }> {
  const rows = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
  const files = (rows[0].bundle as IdentityBundle).files;
  return { a2a: JSON.parse(files.find((f) => f.path === 'config/a2a.json')!.content), version: rows[0].version };
}

describe('signed A2A identity: registrar', () => {
  let env: TestEnv;
  const A = { uuid: randomUUID(), key: `bk_${randomUUID()}`, name: 'agent-a' };
  const B = { uuid: randomUUID(), key: `bk_${randomUUID()}`, name: 'agent-b' };

  beforeEach(async () => {
    env = await createTestEnv();
    for (const [d, peer] of [[A, B.name], [B, A.name]] as const) {
      await seedDevice(env.db, {
        uuid: d.uuid,
        hash: await hashKey(d.key, { memoryCostKiB: 256, timeCost: 1 }),
        agentName: d.name,
        bundle: a2aBundle(d.name, peer),
      });
    }
  });

  const report = (d: typeof A, body: Record<string, unknown>, key: string | null = d.key) =>
    env.request({ method: 'POST', url: '/v1/a2a-key', key, body: { balena_uuid: d.uuid, ...body } });

  it('fingerprint matches the guard (sha256(raw)[:16]) and rejects malformed keys', () => {
    const pub = newPublicKey();
    const expected = createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('hex').slice(0, 16);
    expect(keyFingerprint(pub)).toBe(expected);
    expect(() => keyFingerprint('short')).toThrow(A2aKeyError);
  });

  it('POST /v1/a2a-key requires the device credential', async () => {
    const pub = newPublicKey();
    expect((await report(A, { ed25519: pub }, null)).status).toBe(401);
    expect((await report(A, { ed25519: pub }, B.key)).status).toBe(401); // another device's key
    expect((await report(A, { ed25519: 'not-a-key' })).status).toBe(400);
    const ok = await report(A, { ed25519: pub });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'active', fingerprint: keyFingerprint(pub) });
  });

  it('a different key later is a conflict alarm, never a replacement', async () => {
    const first = newPublicKey();
    const second = newPublicKey();
    await report(A, { ed25519: first });
    expect((await report(A, { ed25519: first })).body.status).toBe('unchanged');
    expect((await report(A, { ed25519: second })).body.status).toBe('conflict');
    const row = (await env.db.select().from(a2aPublicKeys).where(eq(a2aPublicKeys.deviceId, A.uuid)))[0];
    expect(row.ed25519).toBe(first); // the active key stays
    expect(row.conflictFingerprint).toBe(keyFingerprint(second));
    const audits = await getAuditRows(env);
    expect(audits.some((r) => String(r.reason).startsWith('a2a_key_conflict:'))).toBe(true);
  });

  it('active keys reach the peers as peer_keys (public only), via the rotate plane', async () => {
    const pa = newPublicKey();
    const pb = newPublicKey();
    await report(A, { ed25519: pa });
    await report(B, { ed25519: pb });
    const a = await a2aOf(env, A.uuid);
    const b = await a2aOf(env, B.uuid);
    expect(a.a2a.peer_keys).toEqual({ 'agent-b': pb });
    expect(b.a2a.peer_keys).toEqual({ 'agent-a': pa });
    expect(a.a2a.strict).toBe(false);
    expect(a.a2a.peer_tokens).toEqual({ 'agent-b': 'sk-agent-b-mesh' }); // dual: legacy path intact
    expect(a.version).toBeGreaterThan(1);
  });

  it('strict is refused until every device reports ready; strict drops raw peer keys; off restores them', async () => {
    await report(A, { ed25519: newPublicKey() });
    await report(B, { ed25519: newPublicKey() });
    await expect(setStrict(env.db, env.clock, true)).rejects.toMatchObject({ code: 'not_ready', status: 409 });
    for (const d of [A, B]) {
      const { version } = await a2aOf(env, d.uuid);
      await reportGuardStatus(env.db, env.clock, d.uuid,
        { running: true, strict: false, outbound_peers: [d === A ? B.name : A.name] }, version);
    }
    expect((await readiness(env.db, env.clock)).every((r) => r.ready)).toBe(true);
    await setStrict(env.db, env.clock, true);
    expect(await getStrict(env.db)).toBe(true);
    const strictA = (await a2aOf(env, A.uuid)).a2a;
    expect(strictA.strict).toBe(true);
    expect(strictA.peer_tokens).toBeUndefined(); // no raw mesh key of the keyed peer on this device
    await setStrict(env.db, env.clock, false); // live rollback is always allowed
    const offA = (await a2aOf(env, A.uuid)).a2a;
    expect(offA.strict).toBe(false);
    expect(offA.peer_tokens).toEqual({ 'agent-b': 'sk-agent-b-mesh' });
  });

  it('a stale guard report does not count as ready', async () => {
    await report(A, { ed25519: newPublicKey() });
    const { version } = await a2aOf(env, A.uuid);
    await reportGuardStatus(env.db, env.clock, A.uuid, { running: true, outbound_peers: [B.name] }, version);
    env.clock.advance(16 * 60 * 1000);
    expect((await readiness(env.db, env.clock)).find((r) => r.agentName === A.name)?.guardRunning).toBe(false);
  });

  it('revoking a key removes it from the peers', async () => {
    await report(A, { ed25519: newPublicKey() });
    await report(B, { ed25519: newPublicKey() });
    await revokeDeviceKey(env.db, env.clock, B.uuid);
    expect((await a2aOf(env, A.uuid)).a2a.peer_keys).toBeUndefined();
  });

  it('approving a conflict swaps the new key in for the peers', async () => {
    const first = newPublicKey();
    const second = newPublicKey();
    await report(B, { ed25519: newPublicKey() });
    await report(A, { ed25519: first });
    await report(A, { ed25519: second });
    expect((await a2aOf(env, B.uuid)).a2a.peer_keys).toEqual({ 'agent-a': first });
    await approveDeviceKey(env.db, env.clock, A.uuid);
    expect((await a2aOf(env, B.uuid)).a2a.peer_keys).toEqual({ 'agent-a': second });
  });

  it('VS_A2A_KEY_APPROVAL=always holds the first key as pending until approved', async () => {
    const pa = newPublicKey();
    await report(B, { ed25519: newPublicKey() });
    const r = await registerDeviceKey(env.db, env.clock, A.uuid, pa, 'always');
    expect(r.status).toBe('pending');
    expect((await a2aOf(env, B.uuid)).a2a.peer_keys).toBeUndefined(); // not distributed
    await approveDeviceKey(env.db, env.clock, A.uuid);
    expect((await a2aOf(env, B.uuid)).a2a.peer_keys).toEqual({ 'agent-a': pa });
  });

  it('console: /admin/a2a shows keys + readiness; strict ON is refused with a readable error', async () => {
    await seedAdminKey(env.db, 'ak_test_admin');
    const admin = new AdminClient(env.app);
    expect((await admin.login('ak_test_admin')).status).toBeLessThan(400);
    const pa = newPublicKey();
    await report(A, { ed25519: pa });
    const pageRes = await admin.get('/admin/a2a');
    expect(pageRes.status).toBe(200);
    expect(pageRes.html).toContain('Signed A2A identity');
    expect(pageRes.html).toContain(keyFingerprint(pa));
    expect(pageRes.html).toMatch(/Turn strict ON<\/button>/);
    const toggled = await admin.postForm('/admin/a2a/strict', { _csrf: extractCsrf(pageRes.html), strict: 'on' });
    expect(toggled.status).toBe(303);
    expect(String(toggled.headers.location)).toContain('error=');
    expect(await getStrict(env.db)).toBe(false);
  });

  it('console: strict ON succeeds through the form once every device is ready (and OFF rolls back)', async () => {
    await seedAdminKey(env.db, 'ak_test_admin');
    const admin = new AdminClient(env.app);
    await admin.login('ak_test_admin');
    await report(A, { ed25519: newPublicKey() });
    await report(B, { ed25519: newPublicKey() });
    for (const d of [A, B]) {
      const { version } = await a2aOf(env, d.uuid);
      await reportGuardStatus(env.db, env.clock, d.uuid, { running: true, outbound_peers: ['x'] }, version);
    }
    const page1 = await admin.get('/admin/a2a');
    expect(page1.html).not.toMatch(/Turn strict ON<\/button>[^]*disabled/);
    const on = await admin.postForm('/admin/a2a/strict', { _csrf: extractCsrf(page1.html), strict: 'on' });
    expect(String(on.headers.location)).toBe('/admin/a2a');
    expect(await getStrict(env.db)).toBe(true);
    const page2 = await admin.get('/admin/a2a');
    await admin.postForm('/admin/a2a/strict', { _csrf: extractCsrf(page2.html), strict: 'off' });
    expect(await getStrict(env.db)).toBe(false);
  });
});
