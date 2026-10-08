/**
 * Mesh-enroll functional tests (fleet-ops-j7g.1 shape B).
 *
 * Exercises the enrollAgent decision table (MINT / OPEN / REFUSE),
 * the both-sides bundle merge, the machine-auth route contract
 * (mk_ class, hash verify, rate limit, audit rows, alias+merged-only
 * response), and the creator-key bootstrap — against pg-mem with the
 * REAL migrations and a fetch-mocked gateway, the gateway-mint.test.ts
 * pattern.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DB } from 'pg-mem';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { hashKey } from '../src/db/key-crypto.js';
import { identityBlobs, devices, meshEnrollKeys, gatewayCreatorKey, deliveryLog } from '../src/db/schema.js';
import type { IdentityBundle } from '@vector-sigma/shared';
import {
  createTestEnv,
  seedDevice,
  FakeClock,
  type TestEnv,
} from './helpers.js';
import {
  enrollAgent,
  bootstrapCreatorKey,
  MeshEnrollError,
  MeshMintRateLimiter,
  meshKeyAlias,
  MESH_CREATOR_KEY_ENV,
  MESH_GATEWAY_BASE_URL_ENV,
  MESH_MASTER_KEY_ENV,
  renderA2aJson,
  readA2aFromBundle,
  bundleIdentityKey,
  resolveMeshPeers,
} from '../src/mesh-enroll.js';

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

/** Route handlers consumed in call order (last repeats). */
let route: Array<(c: Call) => Response> = [];

beforeEach(() => {
  calls.length = 0;
  route = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      calls.push(c);
      const handler = route[Math.min(calls.length - 1, route.length - 1)];
      return handler(c);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CREATOR_ENV = {
  [MESH_CREATOR_KEY_ENV]: 'sk-creator-test',
  [MESH_GATEWAY_BASE_URL_ENV]: 'http://gateway:4000',
};

// lfk: the enrollee's OWN serve-form origin (optimus-prime's
// tailscale-served :9900 — the proxy-dial address the enroll
// writes). NEVER the mesh edge: an edge public_url loops
// proxy->edge->proxy (the live Defect B this lane fixes).
const SERVE_ORIGIN = 'https://vsigma.lan:9900';

function bundleWith(files: Array<{ path: string; content: string }>): IdentityBundle {
  return { schema_version: 1, bundle_version: 1, generated_at: '2026-01-01T00:00:00Z', files };
}

/** A minimal a2a.json file entry. */
function a2aFile(obj: Record<string, unknown>): { path: string; content: string } {
  return { path: 'config/a2a.json', content: JSON.stringify(obj, null, 2) + '\n' };
}

async function seedMeshAgent(
  db: NodePgDatabase,
  agentName: string,
  withIdentity: boolean,
): Promise<string> {
  const uuid = randomUUID();
  const key = `bk_${randomUUID()}`;
  const hash = await hashKey(key, { memoryCostKiB: 256, timeCost: 1, parallelism: 1 });
  const files = [
    { path: 'config/agent.env', content: `AGENT_NAME=${agentName}\n` },
    ...(withIdentity
      ? [a2aFile({ identity_key: `key-${agentName}`, trusted_peers: [], peer_tokens: {} })]
      : []),
  ];
  await seedDevice(db, { uuid, hash, agentName, bundle: bundleWith(files) });
  return uuid;
}

function gatewayHandlers(opts: {
  keyListStatus: number;
  keyListBody: unknown;
  userNewStatus?: number;
  keyGenStatus?: number;
  keyGenBody?: unknown;
  agentsStatus?: number;
}) {
  return [
    // 1: GET /key/list (alias probe)
    (c: Call) => {
      expect(c.url).toContain('/key/list');
      return respond(opts.keyListStatus, opts.keyListBody);
    },
    // 2: POST /user/new (idempotent)
    (c: Call) => respond(opts.userNewStatus ?? 409, { detail: { error: 'User already exists' } }),
    // 3: POST /key/generate (mint)
    (c: Call) => {
      expect(c.url).toContain('/key/generate');
      return respond(opts.keyGenStatus ?? 200, opts.keyGenBody ?? { key: 'sk-mesh-newkey' });
    },
    // 4: POST /v1/agents (row registration)
    (c: Call) => {
      expect(c.url).toContain('/v1/agents');
      return respond(opts.agentsStatus ?? 200, { agent_id: randomUUID() });
    },
  ];
}

describe('meshKeyAlias + a2a rendering helpers', () => {
  it('aliases are vs-<agent>-a2a', () => {
    expect(meshKeyAlias('optimus-prime')).toBe('vs-optimus-prime-a2a');
    expect(meshKeyAlias('primus')).toBe('vs-primus-a2a');
  });

  it('renderA2aJson merges identity/public_url/peers/tokens additively', () => {
    const current = { identity_key: 'old', trusted_peers: ['a'], peer_tokens: { a: 'ka' } };
    const next = renderA2aJson(current, {
      identityKey: 'new',
      publicUrl: 'https://edge:8443',
      addTrustedPeers: ['b', 'a'],
      addPeerTokens: { b: 'kb' },
    });
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(parsed.identity_key).toBe('new');
    expect(parsed.public_url).toBe('https://edge:8443');
    expect(parsed.trusted_peers).toEqual(['a', 'b']);
    expect(parsed.peer_tokens).toEqual({ a: 'ka', b: 'kb' });
  });

  it('bundleIdentityKey reads the a2a.json from a bundle file list', () => {
    const files = [a2aFile({ identity_key: 'k1' })];
    expect(bundleIdentityKey(files)).toBe('k1');
    expect(bundleIdentityKey([{ path: 'config/agent.env', content: 'X=1' }])).toBe('');
  });
});

describe('enrollAgent decision table', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('MINT: fresh alias -> sentinel mint + both-sides merge + register', async () => {
    const uuid = await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    const outcome = await enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
      keyId: 'fp-test',
      sourceIp: '127.0.0.1',
      originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
      publicUrl: SERVE_ORIGIN,
      clock: env.clock,
      mintLimiter: new MeshMintRateLimiter(env.clock),
    });

    expect(outcome.action).toBe('mint');
    expect(outcome.alias).toBe('vs-optimus-prime-a2a');
    expect(outcome.merged).toBe(true);

    // The minted payload shape is hardcoded server-side (sentinel):
    const gen = calls.find((c) => c.url.includes('/key/generate'));
    expect(gen).toBeDefined();
    expect(gen?.body?.allowed_routes).toEqual(['/a2a', '/a2a/*', '/v1/agents']);
    expect(gen?.body?.models).toBeUndefined();
    expect(gen?.body?.tpm).toBeUndefined();
    expect(gen?.body?.key_alias).toBe('vs-optimus-prime-a2a');

    // The registration row: per-caller identity, no stored secret
    const reg = calls.find((c) => c.url.includes('/v1/agents'));
    expect(reg?.body?.extra_headers).toEqual(['Authorization']);
    expect(JSON.stringify(reg?.body)).not.toContain('sk-mesh-newkey');

    // Target bundle now carries the identity + public_url
    const blobs = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
    const a2a = readA2aFromBundle((blobs[0].bundle as { files: Array<{ path: string; content: string }> }).files);
    expect(a2a?.identity_key).toBe('sk-mesh-newkey');
    expect(a2a?.public_url).toBe(SERVE_ORIGIN);
  });

  it('MINT merges the peer side too: primus gains the enrollee in peer_tokens + trusted_peers', async () => {
    const primusUuid = await seedMeshAgent(env.db, 'primus', true);
    const opUuid = await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    await enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
      keyId: null,
      sourceIp: null,
      originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
      publicUrl: SERVE_ORIGIN,
      clock: env.clock,
      mintLimiter: new MeshMintRateLimiter(env.clock),
    });

    // primus's bundle gained optimus-prime's minted key
    const blobs = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, primusUuid));
    const a2a = readA2aFromBundle((blobs[0].bundle as { files: Array<{ path: string; content: string }> }).files);
    expect((a2a?.peer_tokens as Record<string, string>)['optimus-prime']).toBe('sk-mesh-newkey');
    expect(a2a?.trusted_peers).toContain('optimus-prime');
    // and its own identity survived the merge
    expect(a2a?.identity_key).toBe('key-primus');

    // the target bundle gained primus's key too (inbound resolution)
    const opBlobs = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, opUuid));
    const opA2a = readA2aFromBundle((opBlobs[0].bundle as { files: Array<{ path: string; content: string }> }).files);
    expect((opA2a?.peer_tokens as Record<string, string>)['primus']).toBe('key-primus');
    expect(opA2a?.trusted_peers).toContain('primus');
  });

  it('OPEN: alias live + bundle carries identity -> verify + heal, NO mint', async () => {
    await seedMeshAgent(env.db, 'primus', true);
    route = gatewayHandlers({
      keyListStatus: 200,
      keyListBody: { keys: [{ key_alias: 'vs-primus-a2a' }] },
    });

    const outcome = await enrollAgent(env.db, CREATOR_ENV, 'primus', {
      keyId: null,
      sourceIp: null,
      originUrl: 'http://hermes:9900',
      publicUrl: SERVE_ORIGIN,
      clock: env.clock,
      mintLimiter: new MeshMintRateLimiter(env.clock),
    });

    expect(outcome.action).toBe('open');
    // NO /key/generate call fired (the sentinel is never re-minted)
    expect(calls.some((c) => c.url.includes('/key/generate'))).toBe(false);
  });

  it('REFUSE: alias live + bundle empty -> alias_live error, audit row, no mint', async () => {
    const uuid = await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({
      keyListStatus: 200,
      keyListBody: { keys: [{ key_alias: 'vs-optimus-prime-a2a' }] },
    });

    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
        keyId: null,
        sourceIp: null,
        originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
        publicUrl: SERVE_ORIGIN,
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'alias_live', status: 409 });

    expect(calls.some((c) => c.url.includes('/key/generate'))).toBe(false);
  });

  it('mint rate limit: a second mint within the window refuses', async () => {
    await seedMeshAgent(env.db, 'optimus-prime', false);
    const limiter = new MeshMintRateLimiter(env.clock);
    limiter.recordMint('optimus-prime'); // simulate the earlier mint
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
        keyId: null,
        sourceIp: null,
        originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
        publicUrl: SERVE_ORIGIN,
        clock: env.clock,
        mintLimiter: limiter,
      }),
    ).rejects.toMatchObject({ code: 'alias_live', status: 429 });
  });

  it('device_not_found and no_bundle refuse with audits', async () => {
    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'ghost', {
        keyId: null,
        sourceIp: null,
        originUrl: 'http://x:9900',
        publicUrl: SERVE_ORIGIN,
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'device_not_found' });

    // device row, no bundle
    const uuid = randomUUID();
    const key = `bk_${randomUUID()}`;
    const hash = await hashKey(key, { memoryCostKiB: 256, timeCost: 1, parallelism: 1 });
    await seedDevice(env.db, { uuid, hash, agentName: 'bundleless', bundle: null });
    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'bundleless', {
        keyId: null,
        sourceIp: null,
        originUrl: 'http://x:9900',
        publicUrl: SERVE_ORIGIN,
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'no_bundle' });
  });
});

describe('loop-form refusal (fleet-ops-lfk — Defect B, live-proven 2026-10-08)', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('REFUSES an edge-form public_url (the proxy->edge->proxy loop) BEFORE any mint or merge', async () => {
    const uuid = await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
        keyId: null,
        sourceIp: null,
        originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
        publicUrl: 'https://vector-sigma.tailb7207e.ts.net:8443',
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'loop_url' });

    // NOTHING minted, NOTHING merged — the bundle is untouched:
    const blobs = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
    const a2a = readA2aFromBundle((blobs[0].bundle as { files: Array<{ path: string; content: string }> }).files);
    expect(a2a).toBeNull();
    expect(calls.filter((c) => c.url.includes('/key/generate'))).toHaveLength(0);
  });

  it('REFUSES an edge-form origin_url the same way', async () => {
    await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
        keyId: null,
        sourceIp: null,
        originUrl: 'https://vector-sigma.tailb7207e.ts.net:8443/a2a/optimus-prime',
        publicUrl: SERVE_ORIGIN,
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'loop_url' });
  });

  it('REFUSES a foreign tailnet name (a peer\'s serve name as THIS enrollee\'s delivery address)', async () => {
    await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
        keyId: null,
        sourceIp: null,
        originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
        publicUrl: 'https://wheeljack.tailb7207e.ts.net:9900',
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'loop_url' });
  });

  it('REFUSES the gateway service itself (litellm) as an origin', async () => {
    await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    await expect(
      enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
        keyId: null,
        sourceIp: null,
        originUrl: 'http://litellm:4000/a2a/optimus-prime',
        publicUrl: SERVE_ORIGIN,
        clock: env.clock,
        mintLimiter: new MeshMintRateLimiter(env.clock),
      }),
    ).rejects.toMatchObject({ code: 'loop_url' });
  });

  it('ACCEPTS the enrollee\'s OWN serve form and the master agent\'s compose-internal origin (the two correct shapes)', async () => {
    const uuid = await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    const outcome = await enrollAgent(env.db, CREATOR_ENV, 'optimus-prime', {
      keyId: null,
      sourceIp: null,
      originUrl: `${SERVE_ORIGIN}/a2a/optimus-prime`,
      publicUrl: SERVE_ORIGIN,
      clock: env.clock,
      mintLimiter: new MeshMintRateLimiter(env.clock),
    });
    expect(outcome.action).toBe('mint');

    // the master agent (primus) enrolls compose-internal — allowed:
    await seedMeshAgent(env.db, 'primus', false);
    calls.length = 0; // reset the handler index (route picks by calls.length)
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });
    const master = await enrollAgent(env.db, CREATOR_ENV, 'primus', {
      keyId: null,
      sourceIp: null,
      originUrl: 'http://hermes:9900/a2a/primus',
      publicUrl: 'http://hermes:9900',
      clock: env.clock,
      mintLimiter: new MeshMintRateLimiter(env.clock),
    });
    expect(master.action).toBe('mint');
    expect(master.alias).toBe('vs-primus-a2a');
  });

});

describe('creator-key bootstrap (registrar-side design call)', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('fresh bootstrap: mints from the master key once and writes the marker hash', async () => {
    route = [
      // GET /key/list (alias probe): absent
      (c: Call) => {
        expect(c.url).toContain('/key/list');
        return respond(200, { keys: [] });
      },
      (c: Call) => respond(200, {}), // POST /user/new
      (c: Call) => respond(200, { key: 'sk-creator-bootstrapped' }), // POST /key/generate
    ];
    const key = await bootstrapCreatorKey(env.db, {
      [MESH_MASTER_KEY_ENV]: 'sk-master-test',
      [MESH_GATEWAY_BASE_URL_ENV]: 'http://gateway:4000',
    });
    expect(key).toBe('sk-creator-bootstrapped');
    // The master key was the credential on every call
    const authHeaders = (vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([, init]) => String((init?.headers as Record<string, string>)?.authorization),
    );
    expect(authHeaders.every((h) => h === 'Bearer sk-master-test')).toBe(true);
    // The creator route lock includes the mint surface + /key/list (the
    // liveness probe) + /v1/agents (the card-row registration)
    const gen = calls.find((c) => c.url.includes('/key/generate'));
    expect(gen?.body?.allowed_routes).toEqual([
      '/user/new',
      '/team/new',
      '/team/list',
      '/team/member_add',
      '/key/generate',
      '/key/list',
      '/v1/agents',
    ]);
    // marker row persisted (hash only)
    const markers = await env.db.select().from(gatewayCreatorKey);
    expect(markers).toHaveLength(1);
    expect(markers[0].keyHash).not.toBe('sk-creator-bootstrapped');
    expect(markers[0].alias).toBe('key-creator');
  });

  it('self-heal re-mint: marker exists + alias live -> delete + re-mint + update marker', async () => {
    await env.db.insert(gatewayCreatorKey).values({
      keyHash: 'argon2$old',
      alias: 'key-creator',
    });
    route = [
      // GET /key/list: alias live (token id present)
      (c: Call) => respond(200, { keys: [{ key_alias: 'key-creator', token: 'tok-old' }] }),
      // POST /key/delete (old alias)
      (c: Call) => {
        expect(c.url).toContain('/key/delete');
        return respond(200, {});
      },
      (c: Call) => respond(409, { detail: { error: 'User already exists' } }), // /user/new idempotent
      (c: Call) => respond(200, { key: 'sk-creator-reminted' }), // /key/generate
    ];
    const key = await bootstrapCreatorKey(env.db, {
      [MESH_MASTER_KEY_ENV]: 'sk-master-test',
      [MESH_GATEWAY_BASE_URL_ENV]: 'http://gateway:4000',
    });
    expect(key).toBe('sk-creator-reminted');
    // marker updated, still one row, hash not the plaintext
    const markers = await env.db.select().from(gatewayCreatorKey);
    expect(markers).toHaveLength(1);
    expect(markers[0].keyHash).not.toBe('sk-creator-reminted');
    expect(markers[0].keyHash).not.toBe('argon2$old');
  });

  it('refuses when neither env nor master key is set', async () => {
    await expect(bootstrapCreatorKey(env.db, {})).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('refuses a hand-minted alias with no marker (owner custody class)', async () => {
    route = [
      (c: Call) => respond(200, { keys: [{ key_alias: 'key-creator', token: 'tok-owner' }] }),
    ];
    await expect(
      bootstrapCreatorKey(env.db, {
        [MESH_MASTER_KEY_ENV]: 'sk-master-test',
        [MESH_GATEWAY_BASE_URL_ENV]: 'http://gateway:4000',
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(calls.some((c) => c.url.includes('/key/delete'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/key/generate'))).toBe(false);
  });
});

describe('POST /v1/mesh-enroll route (machine auth)', () => {
  let env: TestEnv;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    env = await createTestEnv();
    // The route resolves the creator key from process.env; pin it for
    // the route tests (the module-level tests pass env explicitly).
    for (const k of [MESH_CREATOR_KEY_ENV, MESH_GATEWAY_BASE_URL_ENV, MESH_MASTER_KEY_ENV]) {
      savedEnv[k] = process.env[k];
      process.env[k] = undefined;
    }
    process.env[MESH_CREATOR_KEY_ENV] = 'sk-creator-test';
    process.env[MESH_GATEWAY_BASE_URL_ENV] = 'http://gateway:4000';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function seedMachineKey(agentName = 'primus'): Promise<string> {
    const mk = `mk_${randomUUID()}`;
    await env.db.insert(meshEnrollKeys).values({
      hash: await hashKey(mk, { memoryCostKiB: 256, timeCost: 1, parallelism: 1 }),
      agentName,
    });
    return mk;
  }

  it('401 without a key; 401 on a device/admin key (class rejection)', async () => {
    const r1 = await env.request({ method: 'POST', url: '/v1/mesh-enroll', body: {}, key: null });
    expect(r1.status).toBe(401);
    const r2 = await env.request({
      method: 'POST',
      url: '/v1/mesh-enroll',
      body: { agent_name: 'x', origin_url: 'http://x:1', public_url: 'http://x:2' },
      key: env.device.key,
    });
    expect(r2.status).toBe(401);
  });

  it('200 with a valid mk_ key: alias + merged only, audit rows, lastUsed stamped', async () => {
    const mk = await seedMachineKey();
    await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    const res = await env.request({
      method: 'POST',
      url: '/v1/mesh-enroll',
      body: {
        agent_name: 'optimus-prime',
        origin_url: `${SERVE_ORIGIN}/a2a/optimus-prime`,
        public_url: SERVE_ORIGIN,
      },
      key: mk,
    });

    expect(res.status).toBe(200);
    // THE CONTRACT: alias + merged ONLY (with action + bundle_version
    // metadata) — never any key material.
    expect(Object.keys(res.body).sort()).toEqual(['action', 'alias', 'bundle_version', 'merged']);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-/);

    // lastUsedAt stamped on the machine-key row
    const rows = await env.db.select().from(meshEnrollKeys);
    expect(rows[0].lastUsedAt).not.toBeNull();
  });

  it('status probe: 200 with the agent name; 401 without auth', async () => {
    const mk = await seedMachineKey('primus');
    const ok = await env.request({ method: 'GET', url: '/v1/mesh-enroll/status', key: mk });
    expect(ok.status).toBe(200);
    expect(ok.body.agent).toBe('primus');
    const bad = await env.request({ method: 'GET', url: '/v1/mesh-enroll/status', key: null });
    expect(bad.status).toBe(401);
  });

  it('invalid body: 400 with an audit row', async () => {
    const mk = await seedMachineKey();
    const res = await env.request({
      method: 'POST',
      url: '/v1/mesh-enroll',
      body: { agent_name: 'bad name!', origin_url: 'http://x:1', public_url: 'http://x:2' },
      key: mk,
    });
    expect(res.status).toBe(400);
  });

  it('failures write delivery_log rows (probe visibility)', async () => {
    const mk = await seedMachineKey();
    await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 500, keyListBody: { error: 'gateway down' } });
    const res = await env.request({
      method: 'POST',
      url: '/v1/mesh-enroll',
      body: {
        agent_name: 'optimus-prime',
        origin_url: `${SERVE_ORIGIN}/a2a/optimus-prime`,
        public_url: SERVE_ORIGIN,
      },
      key: mk,
    });
    expect(res.status).toBe(502);
  });

  it('rate limit: repeated bad keys lock the IP out (429)', async () => {
    for (let i = 0; i < 5; i++) {
      await env.request({
        method: 'POST',
        url: '/v1/mesh-enroll',
        body: { agent_name: 'x', origin_url: 'http://x:1', public_url: 'http://x:2' },
        key: 'mk_wrong-key',
      });
    }
    const locked = await env.request({
      method: 'POST',
      url: '/v1/mesh-enroll',
      body: { agent_name: 'x', origin_url: 'http://x:1', public_url: 'http://x:2' },
      key: 'mk_wrong-key',
    });
    expect(locked.status).toBe(429);
    expect(locked.body.retry_after_seconds).toBeGreaterThan(0);
  });

  it('lfk: a loop-form POST answers 400 loop_url with an audit row (the live CLI defect shape)', async () => {
    const mk = await seedMachineKey();
    await seedMeshAgent(env.db, 'optimus-prime', false);
    route = gatewayHandlers({ keyListStatus: 200, keyListBody: { keys: [] } });

    const res = await env.request({
      method: 'POST',
      url: '/v1/mesh-enroll',
      body: {
        agent_name: 'optimus-prime',
        // the EXACT live defect shape: public_url = the mesh edge
        origin_url: 'https://optimus-prime.tailb7207e.ts.net:9900/a2a/optimus-prime',
        public_url: 'https://vector-sigma.tailb7207e.ts.net:8443',
      },
      key: mk,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'loop_url' });
    // failure audit row landed (the refusal is audited like every failure)
    const denied = await env.db.select().from(deliveryLog).where(eq(deliveryLog.outcome, 'denied'));
    expect(denied.length).toBeGreaterThan(0);
  });
});

describe('resolveMeshPeers', () => {
  it('lists other active devices with identities, excluding the target', async () => {
    const env = await createTestEnv();
    await seedMeshAgent(env.db, 'primus', true);
    await seedMeshAgent(env.db, 'optimus-prime', true);
    await seedMeshAgent(env.db, 'keyless', false);
    const peers = await resolveMeshPeers(env.db, 'optimus-prime');
    expect(peers.map((p) => p.agentName)).toEqual(['primus']);
    expect(peers[0].identityKey).toBe('key-primus');
  });
});