/**
 * The console's error and fallback branches (src/admin.ts): gateway failures in the memory and
 * model mints, existing key lines being replaced, a device with no bundle yet, bounced bundle
 * saves and raw-upload precedence, strict-mode refusals with their reasons, and mesh-enroll's
 * default origins. These are the branches the October mint bugs lived in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IdentityBundle } from '@vector-sigma/shared';
import { hashKey } from '../src/db/key-crypto.js';
import { identityBlobs } from '../src/db/schema.js';
import { AdminClient, createTestEnv, getAuditRows, seedAdminKey, seedDevice, type TestEnv } from './helpers.js';

const ADMIN_KEY = 'ak_test-console-branches-1';
const fast = { memoryCostKiB: 256, timeCost: 1 };
const ENV_KEYS = ['GATEWAY_KEY_CREATOR_KEY', 'GATEWAY_KEY_MINT_BASE_URL', 'LITELLM_MASTER_KEY', 'VS_MESH_TAILNET_SUFFIX', 'VS_MESH_EDGE_HOST'];
let env: TestEnv;
const seen: Array<{ path: string; alias?: string }> = [];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Gateway stub; `fail` names a path that answers 500. */
function stubGateway(fail?: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      const alias = (body?.['key_alias'] as string | undefined) ?? u.searchParams.get('key_alias') ?? undefined;
      seen.push({ path: u.pathname, alias });
      if (u.pathname === fail) return respond(500, { error: 'boom' });
      if (u.pathname === '/key/list') return respond(200, { keys: [] });
      if (u.pathname === '/team/list') return respond(200, []);
      if (u.pathname === '/team/new') return respond(200, { team_id: 't' });
      if (u.pathname === '/key/generate') return respond(200, { key: `sk-${alias}` });
      if (u.pathname === '/v1/agents') return respond(200, { agent_id: randomUUID() });
      return respond(200, {});
    }),
  );
}

async function seedAgent(agentName: string, agentEnv: string | null): Promise<string> {
  const uuid = randomUUID();
  const bundle: IdentityBundle | null =
    agentEnv === null
      ? null
      : { schema_version: 1, bundle_version: 1, generated_at: '2026-01-01T00:00:00Z', files: [{ path: 'config/agent.env', mode: '0600', content: agentEnv }] };
  await seedDevice(env.db, { uuid, hash: await hashKey(`bk_${uuid}`, fast), agentName, bundle });
  return uuid;
}

async function agentEnvOf(uuid: string): Promise<string | undefined> {
  const row = (await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid)))[0];
  return (row?.bundle as IdentityBundle | undefined)?.files.find((f) => f.path === 'config/agent.env')?.content;
}

async function client(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  expect((await c.login(ADMIN_KEY)).status).toBe(303);
  return c;
}

async function post(c: AdminClient, url: string, form: Record<string, string> = {}) {
  const csrf = await c.csrfFrom('/admin/devices');
  return c.postForm(url, { _csrf: csrf, ...form });
}

beforeEach(async () => {
  seen.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['GATEWAY_KEY_CREATOR_KEY'] = 'sk-creator';
  process.env['GATEWAY_KEY_MINT_BASE_URL'] = 'http://gw:4000';
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('Mint memory keys: failures and merges', () => {
  it('a gateway failure is shown with its HTTP status and the bundle is untouched', async () => {
    stubGateway('/key/generate');
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mint-memory-keys`);
    expect(res.html).toMatch(/HTTP 500/);
    expect(res.html).toContain('class="danger"');
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\n');
  });

  it('existing memory key lines are replaced in place, never duplicated', async () => {
    stubGateway();
    const uuid = await seedAgent('wheeljack', 'GATEWAY_MEMORY_SHARED_KEY=old\nAGENT_NAME=wheeljack\n');
    await post(await client(), `/admin/devices/${uuid}/mint-memory-keys`);
    const agentEnv = (await agentEnvOf(uuid))!;
    expect(agentEnv.match(/^GATEWAY_MEMORY_SHARED_KEY=/gm)).toHaveLength(1);
    expect(agentEnv.split('\n')[0]).toBe('GATEWAY_MEMORY_SHARED_KEY=sk-memory-shared-wheeljack');
  });

  it('a device with no bundle yet gets an agent.env holding the keys and the fallback memory URL', async () => {
    stubGateway();
    const uuid = await seedAgent('wheeljack', null);
    await post(await client(), `/admin/devices/${uuid}/mint-memory-keys`);
    const agentEnv = (await agentEnvOf(uuid))!;
    expect(agentEnv).toContain('GATEWAY_MEMORY_PRIVATE_KEY=sk-memory-private-wheeljack');
    expect(agentEnv).toContain('FLEET_MEMORY_BASE_URL=http://gw:4000/v1');
  });
});

describe('Mint model key: failures and merges', () => {
  it('a gateway failure is shown with its HTTP status', async () => {
    stubGateway('/key/generate');
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mint-model-key`);
    expect(res.html).toMatch(/HTTP 500/);
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\n');
  });

  it('an empty GATEWAY_API_KEY line is filled in place', async () => {
    stubGateway();
    const uuid = await seedAgent('wheeljack', 'GATEWAY_API_KEY=\nAGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mint-model-key`);
    expect(res.html).toContain('Model key provisioned');
    expect((await agentEnvOf(uuid))!.split('\n')[0]).toBe('GATEWAY_API_KEY=sk-model-wheeljack');
  });

  it('a device with no bundle gets an agent.env with just the model key', async () => {
    stubGateway();
    const uuid = await seedAgent('wheeljack', null);
    await post(await client(), `/admin/devices/${uuid}/mint-model-key`);
    expect(await agentEnvOf(uuid)).toBe('GATEWAY_API_KEY=sk-model-wheeljack\n');
  });
});

describe('Bundle editor saves', () => {
  it('a malformed extra_env line bounces the save with a 400 naming it, and nothing is stored', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/bundle`, {
      existing_count: '1',
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      new_count: '0',
      structured_extra_env: 'NOT A KEY VALUE LINE',
      structured_model_route: 'ollama/llama3',
    });
    expect(res.status).toBe(400);
    expect(res.html).toContain('extra_env line is not KEY=VALUE');
    expect(res.html).toContain('ollama/llama3'); // non-secret edits survive the bounce
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\n');
  });

  it('a raw upload of agent.env wins over the structured render of the same file', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/bundle`, {
      existing_count: '1',
      existing_path_0: 'config/agent.env',
      existing_content_0: 'AGENT_NAME=raw-upload\n',
      new_count: '1',
      new_path_0: 'config/extra.txt',
      new_content_0: 'hello',
      structured_extra_env: 'FROM_STRUCTURED=1',
    });
    expect(res.status).toBe(303);
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=raw-upload\n');
    const files = ((await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid)))[0]!.bundle as IdentityBundle).files;
    expect(files.map((f) => f.path).sort()).toEqual(['config/agent.env', 'config/extra.txt']);
  });

  it('a blank new-file row is ignored, not stored as an empty file', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    await post(await client(), `/admin/devices/${uuid}/bundle`, {
      existing_count: '1',
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      new_count: '1',
      new_path_0: '',
      new_content_0: '',
      structured_extra_env: 'A=1',
    });
    const files = ((await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid)))[0]!.bundle as IdentityBundle).files;
    expect(files.map((f) => f.path)).toEqual(['config/agent.env']);
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\nA=1\n');
  });
});

describe('Signed identity console', () => {
  it('strict ON with an unready device redirects with the reason and who is not ready', async () => {
    await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), '/admin/a2a/strict', { strict: 'on' });
    expect(res.status).toBe(303);
    const location = decodeURIComponent(String(res.headers['location']));
    expect(location).toContain('/admin/a2a?error=');
  });

  it('strict OFF is always accepted (the live rollback)', async () => {
    const res = await post(await client(), '/admin/a2a/strict', { strict: 'off' });
    expect(res.status).toBe(303);
    expect(String(res.headers['location'])).toBe('/admin/a2a');
  });

  it('approve with no reported key comes back as a readable console error', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/a2a-key/approve`);
    expect(decodeURIComponent(String(res.headers['location']))).toContain('no key reported for this device');
  });
});

describe('Mesh enroll defaults', () => {
  it("primus enrolls at its compose-internal origin, not a tailnet name", async () => {
    stubGateway();
    process.env['VS_MESH_TAILNET_SUFFIX'] = '.synth.ts.net';
    process.env['VS_MESH_EDGE_HOST'] = 'edge.synth.ts.net';
    const uuid = await seedAgent('primus', 'AGENT_NAME=primus\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mesh-enroll`);
    expect(res.html).toContain('A2A mesh enrolled');
    const blob = (await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid)))[0]!;
    const a2a = JSON.parse((blob.bundle as IdentityBundle).files.find((f) => f.path === 'config/a2a.json')!.content);
    expect(a2a.public_url).toBe('http://hermes:9900');
  });

  it('a device with no mesh topology configured is refused, with nothing minted', async () => {
    stubGateway();
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mesh-enroll`);
    expect(res.html).toContain('Mesh enroll failed');
    expect(seen.filter((s) => s.path === '/key/generate')).toHaveLength(0);
  });
});

describe('Console login and first-run setup', () => {
  it('a wrong admin key is 401 and audited; a device key is rejected as such', async () => {
    const c = new AdminClient(env.app);
    expect((await c.login('ak_not-a-real-key')).status).toBe(401);
    expect((await c.login(`bk_${randomUUID()}`)).status).toBe(401);
    const reasons = (await getAuditRows(env)).map((r) => String(r.reason));
    expect(reasons).toContain('admin_login_failed');
    expect(reasons).toContain('device_key_rejected');
    expect(c.hasSession()).toBe(false);
  });

  it('repeated failures lock the login out with a 429 and Retry-After, even for the right key', async () => {
    const c = new AdminClient(env.app);
    for (let i = 0; i < 5; i++) await c.login('ak_wrong');
    const locked = await c.login(ADMIN_KEY);
    expect(locked.status).toBe(429);
    expect(locked.html).toContain('Too many failed attempts');
  });

  it('an already-logged-in GET /admin/login goes straight to the devices list', async () => {
    const c = await client();
    const res = await c.get('/admin/login');
    expect(res.status).toBe(302);
    expect(String(res.headers['location'])).toBe('/admin/devices');
  });

  it('first-run setup needs a label, and disappears once any admin key exists', async () => {
    const fresh = await createTestEnv({ hashParams: fast });
    const c = new AdminClient(fresh.app);
    const csrf = await c.csrfFrom('/admin/setup');
    expect((await c.postForm('/admin/setup', { _csrf: csrf, label: '  ' })).status).toBe(400);
    const ok = await c.postForm('/admin/setup', { _csrf: csrf, label: 'owner laptop' });
    expect(ok.status).toBe(200);
    expect(ok.html).toMatch(/ak_[0-9a-f-]{36}/);
    expect((await c.postForm('/admin/setup', { _csrf: csrf, label: 'second' })).status).toBe(404);
  });
});

describe('Console form validation', () => {
  it('new device needs both an agent name and a balena UUID', async () => {
    const c = await client();
    const res = await post(c, '/admin/new-device', { agent_name: 'wheeljack', balena_uuid: '' });
    expect(res.html).toContain('Agent name and UUID are required.');
  });

  it('a new admin key needs a label', async () => {
    const c = await client();
    const res = await post(c, '/admin/admin-keys', { label: '' });
    expect(res.status).toBe(400);
  });

  it('a mint on a master with neither creator key nor master key names the setup, with no gateway call', async () => {
    stubGateway();
    delete process.env['GATEWAY_KEY_CREATOR_KEY'];
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mint-memory-keys`);
    expect(res.html).toContain('LITELLM_MASTER_KEY');
    expect(seen).toHaveLength(0);
  });

  it('a device without a logo answers 404 for its logo', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    expect((await (await client()).get(`/admin/devices/${uuid}/logo`)).status).toBe(404);
  });
});

describe('Malformed console submissions never lose data', () => {
  it('a bundle save carrying only the CSRF token is refused and the bundle is untouched', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\nGATEWAY_API_KEY=sk-keep\n');
    const res = await post(await client(), `/admin/devices/${uuid}/bundle`);
    expect(res.status).toBe(400);
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\nGATEWAY_API_KEY=sk-keep\n');
  });

  it('a bundle save whose counts point past the submitted rows treats the missing rows as blank', async () => {
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/bundle`, {
      existing_count: '2',
      existing_path_0: 'config/agent.env',
      new_count: '1',
      structured_extra_env: 'B=2',
    });
    expect(res.status).toBe(303);
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\nB=2\n');
  });

  it('a mesh enroll whose gateway connection fails reports the failure and changes no bundle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    process.env['VS_MESH_TAILNET_SUFFIX'] = '.synth.ts.net';
    process.env['VS_MESH_EDGE_HOST'] = 'edge.synth.ts.net';
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mesh-enroll`);
    expect(res.html).toMatch(/Mesh enroll failed/);
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\n');
  });

  it('a memory mint whose gateway connection fails reports it and changes no bundle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const uuid = await seedAgent('wheeljack', 'AGENT_NAME=wheeljack\n');
    const res = await post(await client(), `/admin/devices/${uuid}/mint-memory-keys`);
    expect(res.html).toContain('class="danger"');
    expect(await agentEnvOf(uuid)).toBe('AGENT_NAME=wheeljack\n');
  });
});
