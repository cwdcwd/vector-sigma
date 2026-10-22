/**
 * Console routes for the A2A mesh (src/admin.ts): the mesh-enroll machine-key pages (mint shown
 * once, list, revoke as the kill switch) and the console "Mesh enroll" action. The enrollAgent
 * core and the machine-auth route are covered in mesh-enroll-route.test.ts; this file covers the
 * console wiring around them, including the bootstrapped-master path (no GATEWAY_KEY_CREATOR_KEY),
 * which the console refused before registrar-v1.5.9.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IdentityBundle } from '@vector-sigma/shared';
import { hashKey } from '../src/db/key-crypto.js';
import { identityBlobs, meshEnrollKeys } from '../src/db/schema.js';
import { readA2aFromBundle } from '../src/mesh-enroll.js';
import { AdminClient, createTestEnv, getAuditRows, seedAdminKey, seedDevice, type TestEnv } from './helpers.js';

const ADMIN_KEY = 'ak_test-console-mesh-0001';
const fast = { memoryCostKiB: 256, timeCost: 1 };
const MESH_ENV = {
  GATEWAY_KEY_MINT_BASE_URL: 'http://gw-test:4000',
  VS_MESH_TAILNET_SUFFIX: '.synth-tailnet.ts.net',
  VS_MESH_EDGE_HOST: 'vsigma-master.synth-tailnet.ts.net',
};
const ENV_KEYS = [...Object.keys(MESH_ENV), 'GATEWAY_KEY_CREATOR_KEY', 'LITELLM_MASTER_KEY'];

let env: TestEnv;
const seen: Array<{ path: string; auth: string; alias?: string }> = [];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fresh gateway: no aliases exist; every mint succeeds and returns sk-<alias>. */
function stubFreshGateway(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      const auth = String((init?.headers as Record<string, string> | undefined)?.['authorization'] ?? '');
      const alias = (body?.['key_alias'] as string | undefined) ?? u.searchParams.get('key_alias') ?? undefined;
      seen.push({ path: u.pathname, auth, alias });
      if (u.pathname === '/key/list') return respond(200, { keys: [] });
      if (u.pathname === '/user/new') return respond(200, { user_id: 'u' });
      if (u.pathname === '/key/generate') return respond(200, { key: `sk-${alias}` });
      if (u.pathname === '/v1/agents') return respond(200, { agent_id: randomUUID() });
      return respond(404, {});
    }),
  );
}

async function loginClient(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  expect((await c.login(ADMIN_KEY)).status).toBe(303);
  return c;
}

async function seedAgent(agentName: string): Promise<string> {
  const uuid = randomUUID();
  const bundle: IdentityBundle = {
    schema_version: 1,
    bundle_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    files: [{ path: 'config/agent.env', mode: '0600', content: `AGENT_NAME=${agentName}\n` }],
  };
  await seedDevice(env.db, { uuid, hash: await hashKey(`bk_${uuid}`, fast), agentName, bundle });
  return uuid;
}

beforeEach(async () => {
  seen.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('mesh-enroll machine keys (console)', () => {
  it('pages need a session', async () => {
    const anon = new AdminClient(env.app);
    expect((await anon.get('/admin/mesh-enroll-keys')).status).toBe(302);
  });

  it('mint: the key is shown once, only its hash is stored, and the mint is audited', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/mesh-enroll-keys');
    const res = await c.postForm('/admin/mesh-enroll-keys', { _csrf: csrf, agent_name: 'primus' });
    expect(res.status).toBe(200);
    const key = res.html.match(/<div class="secret-once">([^<]+)<\/div>/)?.[1];
    expect(key).toMatch(/^mk_/);
    const rows = await env.db.select().from(meshEnrollKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentName).toBe('primus');
    expect(rows[0]!.hash).not.toContain(key!);
    expect((await getAuditRows(env)).some((r) => r.reason === 'mesh_enroll_key_minted')).toBe(true);
    // the list shows the row but never the key again
    const list = await c.get('/admin/mesh-enroll-keys');
    expect(list.html).toContain('primus');
    expect(list.html).not.toContain(key!);
  });

  it.each(['', ' ', '-dash-first', 'has space', 'semi;colon'])('mint refuses agent name %j with a 400 and no row', async (name) => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/mesh-enroll-keys');
    const res = await c.postForm('/admin/mesh-enroll-keys', { _csrf: csrf, agent_name: name });
    expect(res.status).toBe(400);
    expect(await env.db.select().from(meshEnrollKeys)).toHaveLength(0);
  });

  it('mint without the CSRF token is refused', async () => {
    const c = await loginClient();
    const res = await c.postForm('/admin/mesh-enroll-keys', { agent_name: 'primus' });
    expect(res.status).toBe(403);
    expect(await env.db.select().from(meshEnrollKeys)).toHaveLength(0);
  });

  it('revoke deletes the row (the kill switch) and is audited; unknown or malformed ids are 404', async () => {
    const c = await loginClient();
    let csrf = await c.csrfFrom('/admin/mesh-enroll-keys');
    await c.postForm('/admin/mesh-enroll-keys', { _csrf: csrf, agent_name: 'primus' });
    const id = Number((await env.db.select().from(meshEnrollKeys))[0]!.id);

    csrf = await c.csrfFrom('/admin/mesh-enroll-keys');
    expect((await c.postForm('/admin/mesh-enroll-keys/abc/revoke', { _csrf: csrf })).status).toBe(404);
    expect((await c.postForm('/admin/mesh-enroll-keys/0/revoke', { _csrf: csrf })).status).toBe(404);
    expect((await c.postForm(`/admin/mesh-enroll-keys/${id + 99}/revoke`, { _csrf: csrf })).status).toBe(404);

    const res = await c.postForm(`/admin/mesh-enroll-keys/${id}/revoke`, { _csrf: csrf });
    expect(res.status).toBe(303);
    expect(await env.db.select().from(meshEnrollKeys)).toHaveLength(0);
    expect((await getAuditRows(env)).some((r) => r.reason === 'mesh_enroll_key_revoked')).toBe(true);
  });
});

describe('console Mesh enroll action', () => {
  it('unknown device is a 404 with no gateway call', async () => {
    stubFreshGateway();
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/mesh-enroll-keys');
    const res = await c.postForm(`/admin/devices/${randomUUID()}/mesh-enroll`, { _csrf: csrf });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('defaults a device to its own tailnet serve origin and mints with the env creator key', async () => {
    Object.assign(process.env, MESH_ENV, { GATEWAY_KEY_CREATOR_KEY: 'sk-creator-env' });
    stubFreshGateway();
    const uuid = await seedAgent('optimus-prime');
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${uuid}`);
    const res = await c.postForm(`/admin/devices/${uuid}/mesh-enroll`, { _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.html).toContain('A2A mesh enrolled (mint): key alias vs-optimus-prime-a2a');
    expect(res.html).toContain('takes effect on each side when its agent container restarts');
    expect(seen.every((s) => s.auth === 'Bearer sk-creator-env')).toBe(true);
    const blob = (await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid)))[0]!;
    const a2a = readA2aFromBundle((blob.bundle as IdentityBundle).files);
    expect(a2a?.public_url).toBe('https://optimus-prime.synth-tailnet.ts.net:9900');
    expect(a2a?.identity_key).toBe('sk-vs-optimus-prime-a2a');
  });

  it('on a bootstrapped master (no creator key env) the console enroll bootstraps it from the master key, then never uses the master again', async () => {
    Object.assign(process.env, MESH_ENV, { LITELLM_MASTER_KEY: 'sk-master-fixture' });
    stubFreshGateway();
    const uuid = await seedAgent('optimus-prime');
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${uuid}`);
    const res = await c.postForm(`/admin/devices/${uuid}/mesh-enroll`, { _csrf: csrf });
    expect(res.html).not.toContain('not_configured');
    expect(res.html).toContain('A2A mesh enrolled (mint)');
    const firstEnrollCall = seen.findIndex((s) => s.auth === 'Bearer sk-key-creator');
    expect(firstEnrollCall).toBeGreaterThan(0);
    expect(seen.slice(0, firstEnrollCall).every((s) => s.auth === 'Bearer sk-master-fixture')).toBe(true);
    expect(seen.slice(firstEnrollCall).every((s) => s.auth === 'Bearer sk-key-creator')).toBe(true);
  });

  it('with neither a creator key nor the master key, the page names the missing setting and nothing is minted', async () => {
    Object.assign(process.env, MESH_ENV);
    stubFreshGateway();
    const uuid = await seedAgent('optimus-prime');
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${uuid}`);
    const res = await c.postForm(`/admin/devices/${uuid}/mesh-enroll`, { _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.html).toContain('Mesh enroll failed (not_configured)');
    expect(res.html).toContain('LITELLM_MASTER_KEY');
    expect(seen.filter((s) => s.path === '/key/generate')).toHaveLength(0);
  });

  it('an operator-supplied edge-form public_url is refused before any mint (the proxy loop)', async () => {
    Object.assign(process.env, MESH_ENV, { GATEWAY_KEY_CREATOR_KEY: 'sk-creator-env' });
    stubFreshGateway();
    const uuid = await seedAgent('optimus-prime');
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${uuid}`);
    const res = await c.postForm(`/admin/devices/${uuid}/mesh-enroll`, {
      _csrf: csrf,
      public_url: 'https://vsigma-master.synth-tailnet.ts.net:8443',
    });
    expect(res.html).toContain('Mesh enroll failed');
    expect(seen.filter((s) => s.path === '/key/generate')).toHaveLength(0);
  });
});
