import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestEnv, seedDevice, seedAdminKey, AdminClient, extractCsrf, type TestEnv } from './helpers.js';
import { hashKey } from '../src/db/key-crypto.js';
import {
  startIdentityRotation,
  startModelRotation,
  advanceRotations,
  RotationError,
  upsertBundleReport,
  bundledEnvValue,
} from '../src/credential-rotation.js';
import { credentialRotations, identityBlobs, devices } from '../src/db/schema.js';
import type { IdentityBundle } from '@vector-sigma/shared';

/**
 * credential-rotation contract (fleet-ops-1py.24 — issue #81).
 *
 * The five spec pillars, pinned against a pg-mem fleet + a mocked
 * gateway:
 *   1. fleet-wide propagation — an identity rotation reaches EVERY
 *      referencing peer, not just the target.
 *   2. overlap window — peers receive new(canonical) + old(overlap);
 *      the target keeps presenting the OLD key until flipped.
 *   3. deliver-then-revoke — no /key/delete before every needed applied
 *      report (or the owner's asserted force-revoke).
 *   4. observability/resumability — the registry row carries the exact
 *      state (status, peer ledger, versions, timestamps, wiped tokens).
 *   5. no failed A2A send by construction — peer bundles only advance.
 */

const ENV = {
  GATEWAY_KEY_CREATOR_KEY: 'sk-creator-test',
  GATEWAY_KEY_MINT_BASE_URL: 'http://gateway:4000',
};

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const calls: Call[] = [];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let keySeq = 0;
/** Live gateway key rows the /key/list stub answers from. */
let keyList: Array<{ key_alias: string; key: string }> = [];
let deletedKeys: string[] = [];

function stubGateway(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      calls.push(c);
      const u = c.url;
      if (c.method === 'POST' && u.includes('/key/generate')) {
        keySeq += 1;
        return respond(200, { key: `sk-rotated-${keySeq}` });
      }
      if (c.method === 'GET' && u.includes('/key/list')) {
        const alias = new URL(u).searchParams.get('key_alias');
        const row = keyList.find((k) => k.key_alias === alias);
        return respond(200, { keys: row ? [row] : [] });
      }
      if (c.method === 'POST' && u.includes('/key/delete')) {
        const keys = (c.body?.keys as string[] | undefined) ?? [];
        deletedKeys.push(...keys);
        keyList = keyList.filter((k) => !keys.includes(k.key));
        return respond(200, { deleted_keys: keys });
      }
      if (c.method === 'POST' && u.includes('/user/new')) {
        return respond(200, {});
      }
      if (c.method === 'POST' && u.includes('/v1/agents')) {
        return respond(200, {});
      }
      return respond(404, { error: `unexpected gateway call ${c.method} ${u}` });
    }),
  );
}

/** Mesh bundle whose env carries AGENT_NAME + an optional model key. */
function meshBundle(me: string, peers: string[], opts?: { modelKey?: string }): IdentityBundle {
  const a2a: Record<string, unknown> = {
    identity_key: `sk-${me}-mesh`,
    public_url: `https://${me}.synth-tailnet.ts.net:9900`,
    trusted_peers: peers,
    peer_tokens: Object.fromEntries(peers.map((p) => [p, `sk-${p}-mesh`])),
    peer_tokens_overlap: {},
  };
  const envLines = [`AGENT_NAME=${me}`];
  if (opts?.modelKey !== undefined) envLines.push(`GATEWAY_API_KEY=${opts.modelKey}`);
  return {
    schema_version: 1,
    bundle_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    files: [
      { path: 'config/agent.env', mode: '0600', content: `${envLines.join('\n')}\n` },
      { path: 'config/a2a.json', mode: '0600', content: `${JSON.stringify(a2a, null, 2)}\n` },
    ],
  };
}

async function bundleOf(env: TestEnv, uuid: string): Promise<{ bundle: IdentityBundle; version: number }> {
  const rows = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
  expect(rows.length).toBe(1);
  return { bundle: rows[0].bundle as IdentityBundle, version: rows[0].version };
}

async function a2aOf(env: TestEnv, uuid: string): Promise<Record<string, unknown>> {
  const { bundle } = await bundleOf(env, uuid);
  return JSON.parse(bundle.files.find((f) => f.path === 'config/a2a.json')!.content);
}

async function rotationRows(env: TestEnv): Promise<Array<typeof credentialRotations.$inferSelect>> {
  return await env.db.select().from(credentialRotations);
}
/** Insert a mesh device (devices + slot + bundle), returns its uuid. */
async function seedAgent(
  env: TestEnv,
  name: string,
  peers: string[],
  opts?: { modelKey?: string },
): Promise<string> {
  const uuid = randomUUID();
  const key = `dk_${name}_${randomUUID()}`;
  const hash = await hashKey(key, { memoryCostKiB: 256, timeCost: 1 });
  await seedDevice(env.db, {
    uuid,
    hash,
    status: 'active',
    agentName: name,
    bundle: meshBundle(name, peers, opts),
  });
  return uuid;
}

/** Env-only bundle (no a2a.json), optionally with a base64-encoded env. Shared by both edge describes. */
export async function seedPlain(
  env: TestEnv,
  name: string,
  opts?: { modelKey?: string; b64Env?: boolean },
): Promise<string> {
  const uuid = randomUUID();
  const hash = await hashKey(`dk_${name}_${randomUUID()}`, { memoryCostKiB: 256, timeCost: 1 });
  const envContent = `AGENT_NAME=${name}${opts?.modelKey !== undefined ? `\nGATEWAY_API_KEY=${opts.modelKey}` : ''}\n`;
  const files = opts?.b64Env
    ? [{ path: 'config/agent.env', mode: '0600', content: Buffer.from(envContent).toString('base64'), encoding: 'base64' }]
    : [{ path: 'config/agent.env', mode: '0600', content: envContent }];
  await seedDevice(env.db, {
    uuid,
    hash,
    status: 'active',
    agentName: name,
    bundle: { schema_version: 1, bundle_version: 1, generated_at: '2026-01-01T00:00:00Z', files } as IdentityBundle,
  });
  return uuid;
}

describe('credential rotation — a2a_identity', () => {
  let env: TestEnv;
  let gamma: string; // the rotation TARGET
  let alpha: string; // referencing peer
  let delta: string; // referencing peer
  let echo: string; // an enrolled device that does NOT reference gamma

  beforeEach(async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    env = await createTestEnv();
    gamma = await seedAgent(env, 'gamma', ['alpha', 'delta']);
    alpha = await seedAgent(env, 'alpha', ['gamma']);
    delta = await seedAgent(env, 'delta', ['gamma']);
    echo = await seedAgent(env, 'echo', ['alpha']);
    stubGateway();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
  });

  it('start: mints a versioned alias and delivers new+old overlap to EVERY referencing peer, target untouched', async () => {
    const result = await startIdentityRotation(env.db, env.clock, ENV, 'gamma', { keyId: null });
    expect(result.newAlias).toBe('vs-gamma-a2a-r1');
    expect(result.peers).toBe(2);

    // alpha + delta: canonical = NEW, overlap = OLD
    for (const [uuid, name] of [[alpha, 'alpha'], [delta, 'delta']] as const) {
      const a2a = await a2aOf(env, uuid);
      expect((a2a['peer_tokens'] as Record<string, string>)['gamma']).toBe('sk-rotated-1');
      expect((a2a['peer_tokens_overlap'] as Record<string, string>)['gamma']).toBe('sk-gamma-mesh');
      // their OWN identity entries are untouched by gamma's rotation
      expect((a2a['identity_key'] as string).startsWith(`sk-${name}-`)).toBe(true);
    }

    // the target's bundle is UNTOUCHED (it still presents the old key)
    const target = await bundleOf(env, gamma);
    expect(target.version).toBe(1);
    expect((await a2aOf(env, gamma))['identity_key']).toBe('sk-gamma-mesh');
    expect(target.bundle.files.find((f) => f.path === 'config/a2a.json')!.content).toContain('sk-gamma-mesh');

    // echo (does not reference gamma) untouched
    expect((await bundleOf(env, echo)).version).toBe(1);

    // registry row: open in 'delivering' with the peer ledger and BOTH tokens
    const rows = await rotationRows(env);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.kind).toBe('a2a_identity');
    expect(row.agentName).toBe('gamma');
    expect(row.oldAlias).toBe('vs-gamma-a2a');
    expect(row.newAlias).toBe('vs-gamma-a2a-r1');
    expect(row.oldToken).toBe('sk-gamma-mesh');
    expect(row.newToken).toBe('sk-rotated-1');
    expect(row.status).toBe('delivering');
    expect(row.newBundleVersion).toBeNull();
    const payload = row.payload as { peers?: Array<{ agent: string; uuid: string; version: number }> };
    expect(payload.peers!.length).toBe(2);
    for (const p of payload.peers!) {
      expect([alpha, delta]).toContain(p.uuid);
      expect(p.version).toBe(2); // stage-1 bumped the peer bundles
    }

    // mint happened exactly once; no revocation yet (deliver-then-revoke)
    expect(calls.filter((c) => c.url.includes('/key/generate')).length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/key/delete')).length).toBe(0);
  });

  it('start refuses a second rotation while one is open', async () => {
    await startIdentityRotation(env.db, env.clock, ENV, 'gamma', { keyId: null });
    await expect(
      startIdentityRotation(env.db, env.clock, ENV, 'gamma', { keyId: null }),
    ).rejects.toMatchObject({ code: 'rotation_in_flight' });
  });

  it('start surfaces the version probe: a live r1 alias bumps to r2', async () => {
    keyList = [{ key_alias: 'vs-gamma-a2a-r1', key: 'sk-stale' }];
    const result = await startIdentityRotation(env.db, env.clock, ENV, 'gamma', { keyId: null });
    expect(result.newAlias).toBe('vs-gamma-a2a-r2');
  });

  it('sweep: flips the target only after EVERY peer has confirmed; never before', async () => {
    const started = await startIdentityRotation(env.db, env.clock, ENV, 'gamma', { keyId: null });
    const { version: peerVersion } = await bundleOf(env, alpha);

    // One peer reported — NOT enough: the sweep must do nothing.
    await upsertBundleReport(env.db, env.clock, alpha, peerVersion);
    const partial = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(partial.flipped.length).toBe(0);
    let rows = await rotationRows(env);
    expect(rows[0].status).toBe('delivering');

    // The last peer reports — the flip lands.
    await upsertBundleReport(env.db, env.clock, delta, peerVersion);
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(outcome.flipped.length).toBe(1);
    rows = await rotationRows(env);
    expect(rows[0].status).toBe('awaiting_target');
    expect(rows[0].flipAt).not.toBeNull();
    expect(rows[0].newBundleVersion).toBe(2); // the target's flip bump
    expect(started.rotationId).toBe(rows[0].id);

    // The target now presents the NEW key.
    expect((await a2aOf(env, gamma))['identity_key']).toBe('sk-rotated-1');
    expect((await bundleOf(env, gamma)).version).toBe(2);

    // Peers were NOT re-delivered (still their stage-1 version).
    expect((await bundleOf(env, alpha)).version).toBe(2);

    // Still no revocation — the target has not confirmed yet.
    expect(calls.filter((c) => c.url.includes('/key/delete')).length).toBe(0);
  });

  it('sweep: after target confirmation the old key is revoked and overlap cleaned; the row completes with tokens wiped', async () => {
    await startIdentityRotation(env.db, env.clock, ENV, 'gamma', { keyId: null });
    await upsertBundleReport(env.db, env.clock, alpha, 2);
    await upsertBundleReport(env.db, env.clock, delta, 2);
    await advanceRotations(env.db, env.clock, ENV, { keyId: null }); // flip
    await upsertBundleReport(env.db, env.clock, gamma, 2);
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });

    expect(outcome.revoked.length).toBe(1);
    expect(outcome.cleaned.length).toBe(1);
    expect(deletedKeys).toEqual(['sk-gamma-mesh']);

    // Peer overlap entries are gone; canonical tokens stay. (An emptied
    // overlap map may render as {} or be dropped entirely.)
    const alphaA2a = await a2aOf(env, alpha);
    const overlap = (alphaA2a['peer_tokens_overlap'] ?? {}) as Record<string, string>;
    expect(overlap['gamma']).toBeUndefined();
    expect((alphaA2a['peer_tokens'] as Record<string, string>)['gamma']).toBe('sk-rotated-1');
    expect((await bundleOf(env, alpha)).version).toBe(3); // cleanup bump

    // Row completed, plaintexts wiped.
    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[0].oldToken).toBeNull();
    expect(rows[0].newToken).toBeNull();
    expect(rows[0].gatewayError).toBeNull();
  });
});

describe('credential rotation — model_key', () => {
  let env: TestEnv;
  let romeo: string;

  beforeEach(async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    env = await createTestEnv();
    romeo = await seedAgent(env, 'romeo', [], { modelKey: 'sk-romeo-model-old' });
    stubGateway();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
  });

  it('start: mints under a versioned alias and merges the new key into the bundle; the old key stays live', async () => {
    const result = await startModelRotation(env.db, env.clock, ENV, 'romeo', { keyId: null });
    expect(result.newAlias).toBe('model-romeo-r1');
    expect(result.newBundleVersion).toBe(2);

    const { bundle } = await bundleOf(env, romeo);
    expect(bundledEnvValue(bundle.files, 'GATEWAY_API_KEY')).toBe('sk-rotated-1');
    expect(bundledEnvValue(bundle.files, 'AGENT_NAME')).toBe('romeo'); // other env lines preserved

    const rows = await rotationRows(env);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('model_key');
    expect(rows[0].oldAlias).toBe('model-romeo');
    expect(rows[0].newAlias).toBe('model-romeo-r1');
    expect(rows[0].status).toBe('delivering');
    expect(rows[0].oldToken).toBeNull(); // the model path never learns the old plaintext
    expect(rows[0].newToken).toBeNull();

    expect(calls.filter((c) => c.url.includes('/key/delete')).length).toBe(0);
  });

  it('sweep: revokes the OLD key by alias (via /key/list) once the target confirmed; completes', async () => {
    keyList = [{ key_alias: 'model-romeo', key: 'sk-romeo-model-old', token: 'sk-romeo-model-old' }];
    await startModelRotation(env.db, env.clock, ENV, 'romeo', { keyId: null });
    await upsertBundleReport(env.db, env.clock, romeo, 2);
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });

    expect(outcome.revoked.length).toBe(1);
    expect(deletedKeys).toEqual(['sk-romeo-model-old']);

    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].revokedAt).not.toBeNull();

    // A completed rotation can be followed by another one.
    keyList = [];
    const next = await startModelRotation(env.db, env.clock, ENV, 'romeo', { keyId: null });
    expect(next.newAlias).toBe('model-romeo-r2');
  });

  it('sweep: a missed gateway (key/list fails) keeps the row open with gateway_error, retried later', async () => {
    await startModelRotation(env.db, env.clock, ENV, 'romeo', { keyId: null });
    await upsertBundleReport(env.db, env.clock, romeo, 2);
    // Simulate the old alias LIST failure by making the fetch 500 for /key/list.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/key/list')) return respond(500, { error: 'boom' });
        if (u.includes('/key/generate')) {
          keySeq += 1;
          return respond(200, { key: `sk-rotated-${keySeq}` });
        }
        if (u.includes('/user/new')) return respond(200, {});
        return respond(404, {});
      }),
    );
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(outcome.errors.length).toBe(1);
    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('awaiting_revoke'); // confirmed; only the revoke failed
    expect(rows[0].gatewayError).toContain('500');

    // Now heal the gateway: the same sweep completes the rotation.
    keyList = [{ key_alias: 'model-romeo', key: 'sk-romeo-model-old', token: 'sk-romeo-model-old' }];
    stubGateway();
    const healed = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(healed.revoked.length).toBe(1);
    const healedRows = await rotationRows(env);
    expect(healedRows[0].status).toBe('completed');
  });
});

describe('credential rotation — force revoke (owner-asserted)', () => {
  let env: TestEnv;
  let juliet: string;

  beforeEach(async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    env = await createTestEnv();
    juliet = await seedAgent(env, 'juliet', ['kilo'], { modelKey: 'sk-juliet-model-old' });
    stubGateway();
    await startModelRotation(env.db, env.clock, ENV, 'juliet', { keyId: null });
    // The force-revoke test drives the MODEL flow's force path (delivering
    // → revoke with confirmations asserted); the a2a flow shares the same
    // sweep gates (confirmed = true under force).
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
  });

  it('force-revokes a model rotation past the applied confirmation, audited', async () => {
    keyList = [{ key_alias: 'model-juliet', key: 'sk-juliet-model-old', token: 'sk-juliet-model-old' }];
    const outcome = await advanceRotations(env.db, env.clock, ENV, {
      keyId: null,
      forceRevoke: 1,
    });
    expect(outcome.revoked.length).toBe(1);
    expect(deletedKeys).toEqual(['sk-juliet-model-old']);
    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('completed');
  });
});

describe('credential rotation — console', () => {
  it('console: GET /admin/rotations renders registry rows with peer applied-versions; reconcile POST with force completes an open row', async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    const env = await createTestEnv();
    await seedAdminKey(env.db, 'ak_test_admin');
    const romeo = await seedAgent(env, 'romeo', [], { modelKey: 'sk-romeo-model-old' });
    process.env['GATEWAY_KEY_CREATOR_KEY'] = ENV.GATEWAY_KEY_CREATOR_KEY;
    process.env['GATEWAY_KEY_MINT_BASE_URL'] = ENV.GATEWAY_KEY_MINT_BASE_URL;
    stubGateway();

    // Start an open rotation through the device page's POST form.
    const admin = new AdminClient(env.app);
    await admin.login('ak_test_admin');
    const detail = await admin.get(`/admin/devices/${romeo}`);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('Rotate model key (tracked)');

    const startRes = await admin.postForm(`/admin/devices/${romeo}/rotate-model-key`, {
      _csrf: extractCsrf(detail.html),
    });
    expect(startRes.status).toBe(200);
    expect(startRes.html).toContain('Model key rotation started (registry');

    // The rotations page lists it with the reconcile + force buttons.
    const page = await admin.get('/admin/rotations');
    expect(page.status).toBe(200);
    expect(page.html).toContain('model-romeo-r1');
    expect(page.html).toContain('<strong>delivering</strong>');
    expect(page.html).toContain('Reconcile');
    expect(page.html).toContain('force revoke');

    // Owner-asserted force revoke: the sweep completes the row.
    keyList = [{ key_alias: 'model-romeo', key: 'sk-romeo-model-old', token: 'sk-romeo-model-old' }];
    const rec = await admin.postForm('/admin/rotations/1/reconcile', {
      _csrf: extractCsrf(page.html),
      force: '1',
    });
    expect(rec.status).toBe(200);
    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('completed');
    expect(deletedKeys).toEqual(['sk-romeo-model-old']);
    const after = await admin.get('/admin/rotations');
    expect(after.html).toContain('<strong>completed</strong>');
    expect(after.html).not.toContain('force revoke</label>'); // closed rows carry no actions
  });

  it('console: the model-key rotate button renders only when agent.env carries GATEWAY_API_KEY', async () => {
    calls.length = 0;
    const env = await createTestEnv();
    await seedAdminKey(env.db, 'ak_test_admin');
    const admin = new AdminClient(env.app);
    await admin.login('ak_test_admin');

    // Mesh bundle WITHOUT a model key: A2A rotation eligible, model not.
    const bare = await seedAgent(env, 'bare', ['uniform']);
    const b = await admin.get(`/admin/devices/${bare}`);
    expect(b.html).toContain('Rotate A2A key (tracked)');
    expect(b.html).not.toContain('Rotate model key (tracked)');

    // With the key present both buttons appear.
    const full = await seedAgent(env, 'full', ['uniform'], { modelKey: 'sk-full-model' });
    const f = await admin.get(`/admin/devices/${full}`);
    expect(f.html).toContain('Rotate A2A key (tracked)');
    expect(f.html).toContain('Rotate model key (tracked)');
  });

  it('console: a2a start route, rate-limit + no-key failure pages, reconcile validations, gateway-error retry', async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    const env = await createTestEnv();
    await seedAdminKey(env.db, 'ak_test_admin');
    const romeo = await seedAgent(env, 'romeo', ['hotel']);
    await seedAgent(env, 'hotel', ['romeo']); // hotel's a2a references romeo → a delivery peer
    const kilo = await seedAgent(env, 'kilo', []); // a2a present, model key absent
    process.env['GATEWAY_KEY_CREATOR_KEY'] = ENV.GATEWAY_KEY_CREATOR_KEY;
    process.env['GATEWAY_KEY_MINT_BASE_URL'] = ENV.GATEWAY_KEY_MINT_BASE_URL;
    stubGateway();
    const admin = new AdminClient(env.app);
    await admin.login('ak_test_admin');

    // Empty registry: the page renders without any action buttons.
    const empty = await admin.get('/admin/rotations');
    expect(empty.status).toBe(200);
    expect(empty.html).not.toContain('Reconcile');

    // The A2A start route through the console.
    const detail = await admin.get(`/admin/devices/${romeo}`);
    const startRes = await admin.postForm(`/admin/devices/${romeo}/rotate-a2a-key`, {
      _csrf: extractCsrf(detail.html),
    });
    expect(startRes.status).toBe(200);
    expect(startRes.html).toContain('A2A identity rotation started (registry #1). 1 peer bundle');

    // The peer cell renders its unreported state.
    const page0 = await admin.get('/admin/rotations');
    expect(page0.html).toContain('no report yet');
    const page0Csrf = extractCsrf(page0.html) ?? extractCsrf(detail.html);

    // A second mint for the same agent → the rate limit failure page.
    const again = await admin.postForm(`/admin/devices/${romeo}/rotate-a2a-key`, {
      _csrf: page0Csrf,
    });
    expect(again.status).toBe(200);
    expect(again.html).toContain('Mint rate limit');

    // rotate-model-key for an agent with no GATEWAY_API_KEY → failure page.
    const kiloDetail = await admin.get(`/admin/devices/${kilo}`);
    const kiloStart = await admin.postForm(`/admin/devices/${kilo}/rotate-model-key`, {
      _csrf: extractCsrf(kiloDetail.html),
    });
    expect(kiloStart.status).toBe(200);
    expect(kiloStart.html).toContain('no GATEWAY_API_KEY');

    // Reconcile validations: malformed id → 4xx.
    const badId = await admin.postForm('/admin/rotations/abc/reconcile', {
      _csrf: page0Csrf,
    });
    expect(badId.status).toBeGreaterThanOrEqual(400);

    // Non-force reconcile while the peer hasn't reported: nothing to advance.
    const nf = await admin.postForm('/admin/rotations/1/reconcile', {
      _csrf: page0Csrf,
    });
    expect(nf.status).toBe(200);
    expect(nf.html).toContain('nothing to advance');

    const fr = await admin.postForm('/admin/rotations/1/reconcile', {
      _csrf: extractCsrf(nf.html) ?? page0Csrf,
      force: '1',
    });
    expect(fr.status).toBe(200);
    expect(fr.html).toContain('target bundle flipped (romeo) — awaiting its applied report');

    // Break the gateway: /key/delete now 500s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'GET' && u.includes('/key/list')) {
          return respond(200, { keys: keyList });
        }
        if (method === 'POST' && u.includes('/key/delete')) return respond(500, { error: 'gateway down' });
        if (method === 'POST' && u.includes('/key/generate')) return respond(200, { key: 'sk-never' });
        return respond(200, {});
      }),
    );

    // The device reports the flipped bundle (v2); the next force pass
    // runs the revoke — which the broken gateway refuses.
    await upsertBundleReport(env.db, env.clock, romeo, 2);
    const frMid = await admin.postForm('/admin/rotations/1/reconcile', {
      _csrf: extractCsrf(fr.html) ?? page0Csrf,
      force: '1',
    });
    expect(frMid.status).toBe(200);
    expect(frMid.html).toContain('force revoke encountered the error above');
    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('awaiting_revoke');
    expect(rows[0].gatewayError).toContain('gateway down');

    // Heal the gateway: the SAME reconcile retries the revoke → completed.
    stubGateway();
    const fr2 = await admin.postForm('/admin/rotations/1/reconcile', {
      _csrf: extractCsrf(frMid.html) ?? page0Csrf,
      force: '1',
    });
    expect(fr2.status).toBe(200);
    const doneRows = await rotationRows(env);
    expect(doneRows[0].status).toBe('completed');
    expect(doneRows[0].oldToken).toBeNull();
    expect(deletedKeys.length).toBe(1);
  });
});

describe('credential rotation — enroll-time propagation of an open rotation', () => {
  it('a fresh enroll of a peer mid-rotation receives the target NEW token canonical + OLD overlap (source contract)', async () => {
    // The enrollAgent peer loop reads the open rotation for the PEER agent
    // and renders both tokens into the enrolled bundle (the same render
    // path the engine's stage-1 delivery uses). Pinned so refactorings
    // cannot silently drop fleet-wide overlap propagation from the enroll.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '..', 'src', 'mesh-enroll.ts'), 'utf8');
    expect(src).toContain('findOpenRotationByAgent');
    expect(src).toContain('addPeerTokensOverlap');
    const rot = readFileSync(path.join(here, '..', 'src', 'credential-rotation.ts'), 'utf8');
    expect(rot).toContain('addPeerTokensOverlap');
    expect(rot).toContain('dropPeerTokensOverlap');
    expect(rot).toContain('revokeMeshKey');
    expect(rot).toContain('revokeModelKey');
  });
});
describe('credential rotation — edges (guards, stalls, envelope variants)', () => {
  let env: TestEnv;
  beforeEach(async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    env = await createTestEnv();
    stubGateway();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
  });

  it('start refuses agents with no device (404) or no mesh identity', async () => {
    await expect(
      startIdentityRotation(env.db, env.clock, ENV, 'ghost', { keyId: null }),
    ).rejects.toMatchObject({ code: 'no_bundle' });
    await seedPlain(env, 'plain');
    await expect(
      startIdentityRotation(env.db, env.clock, ENV, 'plain', { keyId: null }),
    ).rejects.toMatchObject({ code: 'no_bundle' });
    // No registry rows were opened for either refusal.
    expect(await rotationRows(env)).toHaveLength(0);
  });

  it('model start refuses an agent whose bundle carries no GATEWAY_API_KEY; base64 envs rotate fine', async () => {
    await expect(
      startModelRotation(env.db, env.clock, ENV, 'nobody', { keyId: null }),
    ).rejects.toMatchObject({ code: 'no_bundle' });
    await seedPlain(env, 'brutus');
    await expect(
      startModelRotation(env.db, env.clock, ENV, 'brutus', { keyId: null }),
    ).rejects.toMatchObject({ code: 'no_bundle' });
    expect(await rotationRows(env)).toHaveLength(0);

    // base64-encoded agent.env: the value is decoded for the guard and the
    // rotation re-merges it (the merge writes the updated env back).
    const b64 = await seedPlain(env, 'cordelia', { modelKey: 'sk-cordelia-old', b64Env: true });
    const result = await startModelRotation(env.db, env.clock, ENV, 'cordelia', { keyId: null });
    expect(result.newAlias).toBe('model-cordelia-r1');
    const { bundle } = await bundleOf(env, b64);
    expect(bundledEnvValue(bundle.files, 'GATEWAY_API_KEY')).toBe('sk-rotated-1');
    expect(bundledEnvValue(bundle.files, 'AGENT_NAME')).toBe('cordelia');
    // bundledEnvValue tolerates a missing env file.
    expect(bundledEnvValue([{ path: 'config/a2a.json', mode: '0600', content: '{}' }], 'GATEWAY_API_KEY')).toBe('');
  });

  it('a peerless a2a rotation skips the peer stage and flips on the first sweep', async () => {
    const kilo = await seedAgent(env, 'kilo', []); // no agent references kilo
    await startIdentityRotation(env.db, env.clock, ENV, 'kilo', { keyId: null });
    const noConfirm = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(noConfirm.flipped.length).toBe(1); // peersConfirmed([]) === true
    let rows = await rotationRows(env);
    expect(rows[0].status).toBe('awaiting_target');

    // The target confirms: revoke + complete (no peers to clean).
    await upsertBundleReport(env.db, env.clock, kilo, 2);
    const done = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(done.revoked.length).toBe(1);
    rows = await rotationRows(env);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].oldToken).toBeNull();
  });

  it("an env-undefined sweep can't revoke: the row stays open with a gateway_error, retried later", async () => {
    const juliet = await seedAgent(env, 'juliet', [], { modelKey: 'sk-jul...-old' });
    await startModelRotation(env.db, env.clock, ENV, 'juliet', { keyId: null });
    await upsertBundleReport(env.db, env.clock, juliet, 2); // target confirms
    const stalled = await advanceRotations(env.db, env.clock, undefined, { keyId: null });
    expect(stalled.revoked.length).toBe(0);
    expect(stalled.errors.length).toBe(1); // the refusal is visible to the console
    expect(stalled.errors[0].error).toContain('gateway not configured');
    const rows = await rotationRows(env);
    expect(rows[0].status).toBe('awaiting_revoke');
    // With the env restored the SAME sweep completes the rotation.
    const done = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(done.revoked.length).toBe(1);
    expect((await rotationRows(env))[0].status).toBe('completed');
  });

  it('force narrows to the given row: other open rows are left untouched', async () => {
    await seedAgent(env, 'gamma2', []);
    await seedAgent(env, 'romeo2', [], { modelKey: 'sk-rom2-old' });
    const a2a = await startIdentityRotation(env.db, env.clock, ENV, 'gamma2', { keyId: null });
    await startModelRotation(env.db, env.clock, ENV, 'romeo2', { keyId: null });

    // Force the MODEL row — the a2a row must NOT advance with it.
    const rows = await rotationRows(env);
    const modelRow = rows.find((r) => r.kind === 'model_key')!;
    const outcome = await advanceRotations(env.db, env.clock, ENV, {
      keyId: null,
      forceRevoke: modelRow.id,
    });
    expect(outcome.revoked.some((r) => r.id === modelRow.id)).toBe(true);
    const after = await rotationRows(env);
    expect(after.find((r) => r.id === a2a.rotationId)!.status).toBe('delivering'); // untouched
    expect(after.find((r) => r.id === modelRow.id)!.status).toBe('completed'); // force completed it
  });

  it('an awaiting_target row with newBundleVersion null (crash-truncated write) never confirms itself', async () => {
    const kilo2 = await seedAgent(env, 'kilo2', []);
    await env.db.insert(credentialRotations).values({
      kind: 'a2a_identity',
      deviceId: null as string | null,
      agentName: 'kilo2',
      oldAlias: 'vs-kilo2-a2a',
      newAlias: 'vs-kilo2-a2a-r1',
      newBundleVersion: null,
      status: 'awaiting_target',
    } as never);
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(outcome.targetConfirmed.length).toBe(0);
    const rows = await rotationRows(env);
    expect(rows.find((r) => r.agentName === 'kilo2')!.status).toBe('awaiting_target');
    // The seeded device is irrelevant; the guard is on the row's own fields.
    void kilo2;
  });

  it('model revoke treats an alias that is not live anymore as goal state and completes without a delete', async () => {
    keyList = []; // /key/list never finds the old alias
    const juliet2 = await seedAgent(env, 'juliet2', [], { modelKey: 'sk-juliet2-old' });
    await startModelRotation(env.db, env.clock, ENV, 'juliet2', { keyId: null });
    await upsertBundleReport(env.db, env.clock, juliet2, 2);
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(outcome.revoked.length).toBe(1);
    expect(deletedKeys).toEqual([]); // nothing to delete — the alias was absent
    expect((await rotationRows(env))[0].status).toBe('completed');
    const completed = (await rotationRows(env))[0];
    // The absent-alias completion is still audited distinctly.
    expect(completed.gatewayError).toBeNull();
  });

  it('findModelKeyToken tolerates a non-array /key/list envelope (key treated as absent)', async () => {
    // Re-stub with a malformed envelope for the list endpoint only.
    vi.unstubAllGlobals();
    const realStub = stubGateway;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'GET' && u.includes('/key/list')) return respond(200, { keys: 'not-an-array' });
        if (method === 'GET' && u.includes('nope')) return respond(200, {});
        if (method === 'POST' && u.includes('/key/generate')) return respond(200, { key: 'sk-tightrope' });
        if (method === 'POST' && u.includes('/user/new')) return respond(200, {});
        return respond(200, { deleted_keys: [] });
      }),
    );
    void realStub;
    keyList = [];
    const ghost2 = await seedAgent(env, 'ghost2', [], { modelKey: 'sk-ghost2-old' });
    await startModelRotation(env.db, env.clock, ENV, 'ghost2', { keyId: null });
    await upsertBundleReport(env.db, env.clock, ghost2, 2);
    const outcome = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    // list envelope malformed → the old alias reads as absent → completed w/o delete
    expect(outcome.revoked.length).toBe(1);
    expect(deletedKeys).toEqual([]);
  });

  it('a mid-rotation mesh enroll of a peer renders the NEW token canonical + OLD overlap', async () => {
    const { enrollAgent, MeshMintRateLimiter, MESH_CREATOR_KEY_ENV, MESH_GATEWAY_BASE_URL_ENV, MESH_TAILNET_SUFFIX_ENV, MESH_EDGE_HOST_ENV } = await import('../src/mesh-enroll.js');
    const enrollEnv: Record<string, string | undefined> = {
      ...ENV,
      [MESH_CREATOR_KEY_ENV]: ENV.GATEWAY_KEY_CREATOR_KEY,
      [MESH_GATEWAY_BASE_URL_ENV]: ENV.GATEWAY_KEY_MINT_BASE_URL,
      [MESH_TAILNET_SUFFIX_ENV]: '.synth-tailnet.ts.net',
      [MESH_EDGE_HOST_ENV]: 'vsigma-master.synth-tailnet.ts.net',
    };
    const gamma3 = await seedAgent(env, 'gamma3', ['alpha3']);
    void gamma3;
    const alpha3 = await seedAgent(env, 'alpha3', ['gamma3']);
    await startIdentityRotation(env.db, env.clock, ENV, 'gamma3', { keyId: null });
    // A FRESH enroll of alpha3 (e.g. lost device key) during gamma3's open rotation:
    // enrollAgent MINTs (the alias is already live), heals and re-renders — and the
    // rotation block feeds it gamma3's NEW token canonical + OLD one as overlap.
    const outcome = await enrollAgent(env.db, enrollEnv, 'alpha3', {
      keyId: null,
      sourceIp: null,
      originUrl: 'https://alpha3.synth-tailnet.ts.net:9900/a2a/gamma3',
      publicUrl: 'https://alpha3.synth-tailnet.ts.net:9900',
      clock: env.clock,
      mintLimiter: new MeshMintRateLimiter(env.clock),
    });
    const a2a = await a2aOf(env, alpha3);
    expect((a2a['peer_tokens'] as Record<string, string>)['gamma3']).toMatch(/sk-rotated-./);
    expect((a2a['peer_tokens_overlap'] as Record<string, string>)['gamma3']).toContain('sk-gamma3-');
    void outcome;
  });
});

describe('credential rotation — edges 2 (sweep internals)', () => {
  let env: TestEnv;
  beforeEach(async () => {
    calls.length = 0;
    keySeq = 0;
    keyList = [];
    deletedKeys = [];
    // Scrub the gateway env so "env === undefined" truly means unconfigured.
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
    env = await createTestEnv();
    stubGateway();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
  });

  it('env-undefined and broken-gateway revokes surface as sweep errors; rotationId/force narrow correctly; crash-truncated targets refuse safely', async () => {
    // A mesh-less device shares the fleet (the peer scan must skip it silently).
    await seedPlain(env, 'plain2');

    // ── a2a rotation driven to awaiting_revoke, then swept WITHOUT env ──
    const romeo4 = await seedAgent(env, 'romeo4', ['hotel4']);
    await seedAgent(env, 'hotel4', ['romeo4']);
    await startIdentityRotation(env.db, env.clock, ENV, 'romeo4', { keyId: null });
    const rows0 = await rotationRows(env);
    const a2aRow = rows0.find((r) => r.kind === 'a2a_identity')!;
    const hotel4Row = (await env.db.select().from(devices).where(eq(devices.agentName, 'hotel4')))[0];
    await upsertBundleReport(env.db, env.clock, hotel4Row.balenaUuid, 2); // peer applied the delivered v2
    await upsertBundleReport(env.db, env.clock, romeo4, 2); // target applied v2
    // Break the gateway BEFORE the flip pass: confirm + revoke run in one
    // sweep, the delete 500s, and the row is left OPEN at awaiting_revoke.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && u.includes('/key/delete')) return respond(500, { error: 'delete outage' });
      if (method === 'GET' && u.includes('/key/list')) return respond(200, { keys: keyList });
      return respond(200, {});
    }));
    const flipPass = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(flipPass.flipped.length).toBe(1);
    expect(flipPass.targetConfirmed.length).toBe(0);
    const confirmPass = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(confirmPass.targetConfirmed.length).toBe(1);
    expect(confirmPass.revoked.length).toBe(0); // the delete 500 blocked it
    const midRows = await rotationRows(env);
    expect(midRows.find((r) => r.id === a2aRow.id)!.status).toBe('awaiting_revoke');
    expect(midRows.find((r) => r.id === a2aRow.id)!.gatewayError).toContain('delete outage');

    // A sweep that runs with NO env (the var lost between restarts) cannot
    // even attempt the revoke: the refusal is recorded and the row stays open.
    const stalledA2a = await advanceRotations(env.db, env.clock, undefined, { keyId: null });
    expect(stalledA2a.errors.length).toBe(1); // revoke refused: gateway not configured
    expect(stalledA2a.errors[0].error).toContain('gateway not configured');
    expect((await rotationRows(env)).find((r) => r.id === a2aRow.id)!.status).toBe('awaiting_revoke');

    // ── a2a retry WITH env completes (old token wiped) ──
    stubGateway(); // heal the gateway
    const healed = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(healed.revoked.length).toBe(1);
    expect((await rotationRows(env)).find((r) => r.id === a2aRow.id)!.status).toBe('completed');

    // ── model rotation: /key/delete refuses (500) → noteFailure + errors ──
    keyList = [{ key_alias: 'model-juliet4', key: 'sk-jul4-old', token: 'sk-jul4-old' }];
    const juliet4 = await seedAgent(env, 'juliet4', [], { modelKey: 'sk-jul4-old' });
    await startModelRotation(env.db, env.clock, ENV, 'juliet4', { keyId: null });
    // The gateway refuses before the flip pass — the model flow confirms and
    // revokes in ONE sweep, so the break must be in place beforehand.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && u.includes('/key/list')) return respond(200, { keys: keyList });
      if (method === 'POST' && u.includes('/key/delete')) return respond(500, { error: 'still down' });
      return respond(200, {});
    }));
    await upsertBundleReport(env.db, env.clock, juliet4, 2);
    const refused = await advanceRotations(env.db, env.clock, ENV, { keyId: null }); // flip + revoke refused
    expect(refused.errors.length).toBe(1);
    const modelRows = await rotationRows(env);
    const modelRow = modelRows.find((r) => r.kind === 'model_key')!;
    expect(modelRow.status).toBe('awaiting_revoke');
    expect(modelRow.gatewayError).toContain('still down');

    // ── rotationId narrows: the completed a2a row is not scanned again ──
    stubGateway();
    const narrowed = await advanceRotations(env.db, env.clock, ENV, { keyId: null, rotationId: modelRow.id });
    expect(narrowed.revoked.length).toBe(1);
    expect(narrowed.scanned).toBe(1);
    expect((await rotationRows(env)).find((r) => r.id === modelRow.id)!.status).toBe('completed');

    // ── crash-truncated rows: delivering + deviceId=null refuses; a target whose bundle LOST a2a.json refuses ──
    await env.db.insert(credentialRotations).values({
      kind: 'a2a_identity',
      deviceId: null,
      agentName: 'kilo4',
      oldAlias: 'vs-kilo4-a2a',
      newAlias: 'vs-kilo4-a2a-r1',
      newBundleVersion: null,
      status: 'delivering',
    } as never);
    const truncated = await advanceRotations(env.db, env.clock, ENV, { keyId: null });
    expect(truncated.errors.some((e) => e.error.includes('no target device'))).toBe(true);

    const delta4 = await seedAgent(env, 'delta4', []);
    await startIdentityRotation(env.db, env.clock, ENV, 'delta4', { keyId: null });
    const deltaRow = (await rotationRows(env)).find((r) => r.agentName === 'delta4')!;
    // Rip the a2a.json out of delta4's bundle before the flip can run.
    const deltaBlob = (await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, delta4)))[0];
    const bundleVal = deltaBlob.bundle as { files: Array<{ path: string; content: string; [k: string]: unknown }> };
    await env.db
      .update(identityBlobs)
      .set({
        bundle: { ...bundleVal, files: bundleVal.files.filter((f) => f.path !== 'config/a2a.json') },
      })
      .where(eq(identityBlobs.deviceId, delta4));
    const afterRip = (await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, delta4)))[0];
    expect(JSON.stringify(afterRip.bundle)).not.toContain('config/a2a.json'); // the rip landed
    const lost = await advanceRotations(env.db, env.clock, ENV, { keyId: null, forceRevoke: deltaRow.id });
    expect(lost.errors.some((e) => e.error.includes('lost its a2a.json'))).toBe(true);
  });
});
