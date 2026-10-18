import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestEnv,
  seedDevice,
  seedAdminKey,
  AdminClient,
  getAuditRows,
  type TestEnv,
} from './helpers.js';
import { identityBlobs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { IdentityBundle } from '@vector-sigma/shared';

/**
 * POST /admin/devices/:uuid/mint-model-key — route contract (fleet-ops-1py.46).
 *
 * Exercises the console action end-to-end against pg-mem with a
 * fetch-mocked gateway (the gateway-mint.test.ts pattern): auth + CSRF
 * gating, the MINT path (probe -> user row -> key/generate -> bundle
 * merge -> keyOnce shown once), the OPEN path (bundle is the truth, no
 * rotation), the REFUSE path (alias live + empty bundle), and the
 * not-configured fallback. No real gateway, no real key material — the
 * minted "keys" below are synthetic test fixtures.
 */

let env: TestEnv;
const fast = { memoryCostKiB: 256, timeCost: 1 };

const ADMIN_KEY = 'ak_test-admin-key-0002';
const AGENT = 'wheeljack';

const CREATOR_KEY_TEST = 'sk-creator-test-fixture';
const MINT_BASE_TEST = 'http://gw-test:4000';

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
let route: Array<(c: Call) => Response> = [];

function setCreatorEnv(): void {
  process.env['GATEWAY_KEY_CREATOR_KEY'] = CREATOR_KEY_TEST;
  process.env['GATEWAY_KEY_MINT_BASE_URL'] = MINT_BASE_TEST;
}

function clearCreatorEnv(): void {
  delete process.env['GATEWAY_KEY_CREATOR_KEY'];
  delete process.env['GATEWAY_KEY_MINT_BASE_URL'];
}

beforeEach(async () => {
  calls.length = 0;
  route = [];
  clearCreatorEnv();
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
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
});

afterEach(() => {
  clearCreatorEnv();
  vi.unstubAllGlobals();
});

function bundleWith(agentEnv: string): IdentityBundle {
  return {
    schema_version: 1,
    bundle_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    files: [{ path: 'config/agent.env', mode: '0600', content: agentEnv }],
  };
}

/** Handlers for the MINT flow: probe absent -> user/new -> generate. */
const mintHandlers = () => [
  () => respond(200, { keys: [] }), // GET /key/list — alias absent
  () => respond(200, { user_id: 'agent-wheeljack' }), // POST /user/new
  () => respond(200, { key: 'sk-model-test-1' }), // POST /key/generate
];

async function loginClient(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  const res = await c.login(ADMIN_KEY);
  expect(res.status).toBe(303);
  expect(c.hasSession()).toBe(true);
  return c;
}

async function currentBundle(uuid: string): Promise<IdentityBundle | undefined> {
  const rows = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
  return rows[0]?.bundle as IdentityBundle | undefined;
}

/** Replace the bundle row wholesale (seedDevice with bundle:null leaves none). */
async function putBundle(uuid: string, bundle: IdentityBundle): Promise<void> {
  await env.db.delete(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
  await env.db.insert(identityBlobs).values({ deviceId: uuid, bundle, version: 1 });
}

describe('mint-model-key route', () => {
  beforeEach(async () => {
    // bundle: null — the suite seeds/updates bundle state per test
    // (seedDevice treats undefined as "insert the optional row" and dies
    // on the NOT NULL constraint).
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, agentName: AGENT, bundle: null });
  });

  it('unauthenticated POST redirects to login', async () => {
    const c = new AdminClient(env.app);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, {});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
    expect(calls.length).toBe(0);
  });

  it('missing CSRF token 403s', async () => {
    const c = await loginClient();
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, {});
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it('unknown device 404s (after session + CSRF gates)', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm('/admin/devices/00000000-0000-0000-0000-000000000000/mint-model-key', {
      _csrf: csrf,
    });
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it('config gap renders the fallback message and makes NO gateway call', async () => {
    setCreatorEnv();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.html).toContain('GATEWAY_KEY_CREATOR_KEY');
    expect(res.html).toContain('class="danger"');
    expect(calls.length).toBe(0);
  });

  it('MINT: fresh alias -> key minted, merged into agent.env, shown once, audited', async () => {
    setCreatorEnv();
    route = mintHandlers();
    // a bundle the device already carries: AGENT_NAME must survive the merge
    await putBundle(env.device.uuid, bundleWith('AGENT_NAME=wheeljack\n'));
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });

    expect(res.status).toBe(200);
    // the minted value appears EXACTLY once (keyOnce), never in a message
    expect(res.html.split('sk-model-test-1').length - 1).toBe(1);
    expect(res.html).toContain('Model key provisioned (model-wheeljack)');
    expect(res.html).toContain('delivered on the next device sync');

    // gateway wire: probe -> user row -> generate (exact payload)
    const strip = (u: string) => u.replace(MINT_BASE_TEST, '');
    expect(calls.map((x) => strip(x.url).split('?')[0])).toEqual([
      '/key/list',
      '/user/new',
      '/key/generate',
    ]);
    expect(calls[2].body).toMatchObject({
      key_alias: 'model-wheeljack',
      user_id: 'agent-wheeljack',
      metadata: { purpose: 'agent-model', agent: AGENT },
    });
    expect(calls[2].body && Array.isArray(calls[2].body['allowed_routes'])).toBe(true);

    // bundle merge: the new line landed, the rest of agent.env survived
    const bundle = await currentBundle(env.device.uuid);
    const agentEnv = bundle?.files.find((f) => f.path === 'config/agent.env')?.content ?? '';
    expect(agentEnv).toContain('GATEWAY_API_KEY=sk-model-test-1');
    expect(agentEnv).toContain('AGENT_NAME=wheeljack');

    // audited
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'model_key_minted')).toBe(true);
  });

  it('MINT into an EXISTING bundle preserves sibling files (SOUL.md, secrets.env)', async () => {
    setCreatorEnv();
    route = mintHandlers();
    await putBundle(env.device.uuid, {
      schema_version: 1,
      bundle_version: 1,
      generated_at: '2026-01-01T00:00:00Z',
      files: [
        { path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=wheeljack\n' },
        { path: 'SOUL.md', mode: '0600', content: '# soul\n' },
        { path: 'config/secrets.env', mode: '0600', content: 'SLACK_BOT_TOKEN=x\n' },
      ],
    });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });
    expect(res.status).toBe(200);

    const bundle = await currentBundle(env.device.uuid);
    const paths = (bundle?.files ?? []).map((f) => f.path);
    expect(paths).toContain('SOUL.md');
    expect(paths).toContain('config/secrets.env');
    expect(bundle?.files.find((f) => f.path === 'config/secrets.env')?.content).toBe('SLACK_BOT_TOKEN=x\n');
  });

  it('OPEN: alias live + bundle already carries the key -> no mint, no rotation', async () => {
    setCreatorEnv();
    route = [() => respond(200, { keys: [{ key_alias: 'model-wheeljack' }] })];
    await putBundle(env.device.uuid, bundleWith('AGENT_NAME=wheeljack\nGATEWAY_API_KEY=pre-existing\n'));
    const before = await currentBundle(env.device.uuid);

    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });

    expect(res.status).toBe(200);
    expect(res.html).toContain('already provisioned');
    expect(res.html).toContain('nothing changed');
    // the probe is the ONLY network call; nothing re-minted
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/key/list');
    // bundle untouched
    const after = await currentBundle(env.device.uuid);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // audited as the no-op verification
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'model_key_open')).toBe(true);
    expect(audit.some((a) => a.reason === 'model_key_minted')).toBe(false);
  });

  it('refuses with the recovery step: alias live + empty bundle (no mint, no rotation)', async () => {
    setCreatorEnv();
    route = [
      () => respond(200, { keys: [{ key_alias: 'model-wheeljack' }] }),
      () => respond(200, { key: 'sk-should-never-mint' }),
    ];
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });

    expect(res.status).toBe(200);
    expect(res.html).toContain('revoke the alias');
    expect(res.html).toContain('model-wheeljack');
    // no mint went through; the empty bundle is untouched
    expect(calls.some((x) => x.url.includes('/key/generate'))).toBe(false);
    expect(await currentBundle(env.device.uuid)).toBeUndefined();
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'model_key_minted')).toBe(false);
  });

  it('device without a bundle yet can mint (the first bundle file is created)', async () => {
    setCreatorEnv();
    route = mintHandlers();
    await env.db.delete(identityBlobs).where(eq(identityBlobs.deviceId, env.device.uuid));
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });

    expect(res.status).toBe(200);
    expect(res.html).toContain('Model key provisioned (model-wheeljack)');
    const bundle = await currentBundle(env.device.uuid);
    const agentEnv = bundle?.files.find((f) => f.path === 'config/agent.env')?.content ?? '';
    expect(agentEnv).toBe('GATEWAY_API_KEY=sk-model-test-1\n');
  });

  it('a gateway failure renders status + body for triage (not a 500)', async () => {
    setCreatorEnv();
    route = [
      () => respond(200, { keys: [] }),
      () => respond(200, { user_id: 'agent-wheeljack' }),
      () => respond(502, 'upstream dead'),
    ];
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/mint-model-key`, { _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.html).toContain('class="danger"');
    expect(res.html).toContain('502');
    expect(await currentBundle(env.device.uuid)).toBeUndefined();
  });
});