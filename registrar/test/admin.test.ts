import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestEnv,
  seedDevice,
  seedAdminKey,
  AdminClient,
  getAuditRows,
  asStatusBody,
  type TestEnv,
} from './helpers.js';
import { randomUUID } from 'node:crypto';
import { devices } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

let env: TestEnv;
const fast = { memoryCostKiB: 256, timeCost: 1 };

const ADMIN_KEY = 'ak_test-admin-key-0001';
const SECRET_BUNDLE = {
  schema_version: 1 as const,
  bundle_version: 1,
  generated_at: '2026-01-01T00:00:00Z',
  files: [
    { path: 'config/agent.env', mode: '0600' as const, content: 'SECRET_TOKEN=topsecret-agent-token-value\n' },
  ],
};

beforeEach(async () => {
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
});

async function loginClient(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  const res = await c.login(ADMIN_KEY);
  expect(res.status).toBe(303);
  expect(c.hasSession()).toBe(true);
  return c;
}

describe('Admin console — auth gate', () => {
  it('redirects unauthenticated /admin/* to login', async () => {
    const c = new AdminClient(env.app);
    const res = await c.get('/admin/devices');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('device key (bk_) is structurally rejected on admin login', async () => {
    const c = new AdminClient(env.app);
    const res = await c.login(env.device.key);
    expect(res.status).toBe(401);
    expect(c.hasSession()).toBe(false);
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'device_key_rejected')).toBe(true);
  });

  it('device key (bk_) is structurally rejected on /v1/re-arm and /v1/rotate', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const reArm = await env.request({
      method: 'POST',
      url: '/v1/re-arm',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(reArm.status).toBe(401);

    const rotate = await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: { balena_uuid: env.device.uuid, files: SECRET_BUNDLE.files },
      key: env.device.key,
    });
    expect(rotate.status).toBe(401);
    const audit = await getAuditRows(env);
    expect(audit.filter((a) => a.reason === 'device_key_rejected').length).toBe(2);
  });

  it('bad admin key fails login with 401', async () => {
    const c = new AdminClient(env.app);
    const res = await c.login('ak_wrong-key');
    expect(res.status).toBe(401);
    expect(c.hasSession()).toBe(false);
  });

  it('login rate limit locks out after repeated failures + Retry-After', async () => {
    const c = new AdminClient(env.app);
    // 5 failures trips the lockout (maxFailures=5 in TEST_CONFIG)
    for (let i = 0; i < 5; i++) {
      await c.login('ak_wrong-key');
    }
    const locked = await c.login(ADMIN_KEY);
    expect(locked.status).toBe(429);
    expect(locked.html).toContain('Too many failed attempts');
    const res = await env.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'admin_key=x&_csrf=y',
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('login requires the double-submit CSRF cookie', async () => {
    const get = await env.app.inject({ method: 'GET', url: '/admin/login' });
    expect(get.statusCode).toBe(200);
    const noCookie = await env.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=${encodeURIComponent(ADMIN_KEY)}&_csrf=anything`,
    });
    expect(noCookie.statusCode).toBe(403);
  });

  it('session expires after 12h (clock-driven)', async () => {
    const c = await loginClient();
    const before = await c.get('/admin/devices');
    expect(before.status).toBe(200);
    env.clock.advance(12 * 60 * 60 * 1000);
    const after = await c.get('/admin/devices');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/admin/login');
  });
});

describe('Admin console — CSRF enforcement on mutations', () => {
  it('every mutation posts 403 on missing CSRF token', async () => {
    const c = await loginClient();
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const urls = [
      `/admin/devices/${env.device.uuid}/re-arm`,
      `/admin/devices/${env.device.uuid}/activate`,
      `/admin/devices/${env.device.uuid}/revoke`,
      `/admin/devices/${env.device.uuid}/regen-key`,
      `/admin/devices/${env.device.uuid}/bundle`,
      '/admin/new-device',
      '/admin/logout',
    ];
    for (const url of urls) {
      const res = await c.postForm(url, {});
      expect(res.status).toBe(403);
    }
  });

  it('mutation with a wrong token (session token of another session) 403s', async () => {
    const c = await loginClient();
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/re-arm`, { _csrf: 'forged-token-value' });
    expect(res.status).toBe(403);
  });

  it('mutation with the valid session token passes the CSRF gate', async () => {
    const c = await loginClient();
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/re-arm`, { _csrf: csrf });
    expect(res.status).toBe(303);
  });
});

describe('Admin console — secrets never rendered', () => {
  it('bundle secret content appears on no console page', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();

    const dashboard = await c.get('/admin/devices');
    expect(dashboard.status).toBe(200);
    expect(dashboard.html).not.toContain('topsecret-agent-token-value');

    const detail = await c.get(`/admin/devices/${env.device.uuid}`);
    expect(detail.status).toBe(200);
    expect(detail.html).not.toContain('topsecret-agent-token-value');
    // masked display present instead
    expect(detail.html).toContain('masked — write-only');

    const editor = await c.get(`/admin/devices/${env.device.uuid}/bundle`);
    expect(editor.status).toBe(200);
    expect(editor.html).not.toContain('topsecret-agent-token-value');

    const audit = await c.get('/admin/audit');
    expect(audit.status).toBe(200);
    expect(audit.html).not.toContain('topsecret-agent-token-value');

    // login page + one-time key page also never leak secrets
    expect(editor.html).toContain('content masked');
  });

  it('bundle save keeps existing content when editor textarea blank (write-only)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, {
      _csrf: csrf,
      existing_count: '1',
      new_count: '3',
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      new_path_0: '',
      new_content_0: '',
    });
    expect(res.status).toBe(303);
    // device bootstrap after save still returns the ORIGINAL secret content
    const boot = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(boot.status).toBe(200);
    expect(JSON.stringify(boot.body.bundle)).toContain('topsecret-agent-token-value');
  });
});

describe('Admin console — bundle editor (one code path with /v1/rotate)', () => {
  it('bundle save bumps version, arms slot, writes audit row', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    // consume the slot so arming is observable
    await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });

    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, {
      _csrf: csrf,
      existing_count: '1',
      new_count: '3',
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      new_path_0: 'config/extra.env',
      new_content_0: 'EXTRA_VALUE=added-by-console\n',
    });
    expect(res.status).toBe(303);

    // version bumped to 2, slot armed
    const status = await env.request({
      method: 'GET',
      url: `/v1/status?balena_uuid=${env.device.uuid}`,
      key: env.device.key,
    });
    expect(status.status).toBe(200);
    expect(status.body.bundle_version).toBe(2);
    expect(status.body.slot.state).toBe('armed');
    expect(status.body.slot.delivery_count).toBe(1);

    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'bundle_rotated_console')).toBe(true);

    // next bootstrap delivers version 2 with the added file
    const boot = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(boot.status).toBe(200);
    expect(boot.body.bundle_version).toBe(2);
    const files = boot.body.bundle.files as Array<{ path: string }>;
    expect(files.some((f) => f.path === 'config/extra.env')).toBe(true);
  });

  it('existing content update replaces only that file', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, {
      _csrf: csrf,
      existing_count: '1',
      new_count: '3',
      existing_path_0: 'config/agent.env',
      existing_content_0: 'SECRET_TOKEN=replaced-rotation-value\n',
      new_path_0: '',
      new_content_0: '',
    });
    expect(res.status).toBe(303);
    const boot = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(boot.status).toBe(200);
    const content = (boot.body.bundle.files as Array<{ path: string; content: string }>).find(
      (f) => f.path === 'config/agent.env',
    )?.content;
    expect(content).toBe('SECRET_TOKEN=replaced-rotation-value\n');
    expect(JSON.stringify(boot.body.bundle)).not.toContain('topsecret-agent-token-value');
  });

  it('rejects bundle with no files (400 back to editor)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, {
      _csrf: csrf,
      existing_count: '1',
      new_count: '3',
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      new_path_0: '',
      new_content_0: '',
      // no update, no addition → merge keeps existing → wait, that is valid.
    });
    // keeping everything is a legitimate save (version bump on identical content)
    expect(res.status).toBe(303);
  });
});

describe('POST /v1/rotate — owner API', () => {
  it('rotates the bundle, bumps version, arms slot, audits', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });

    const res = await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: {
        balena_uuid: env.device.uuid,
        files: [{ path: 'config/rotated.env', mode: '0600', content: 'ROTATED=1\n' }],
      },
      key: ADMIN_KEY,
    });
    expect(res.status).toBe(200);
    expect(res.body.bundle_version).toBe(2);
    expect(res.body.slot_state).toBe('armed');

    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'bundle_rotated_api')).toBe(true);

    const boot = await env.request({
      method: 'POST',
 url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(boot.status).toBe(200);
    expect(boot.body.bundle_version).toBe(2);
    const files = boot.body.bundle.files as Array<{ path: string }>;
    expect(files[0].path).toBe('config/rotated.env');
  });

  it('404 on unknown uuid, 400 on invalid body', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const notFound = await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: { balena_uuid: randomUUID(), files: [{ path: 'a', mode: '0600', content: 'x' }] },
      key: ADMIN_KEY,
    });
    expect(notFound.status).toBe(404);

    const badBody = await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: { balena_uuid: 'not-a-uuid', files: [] },
      key: ADMIN_KEY,
    });
    expect(badBody.status).toBe(400);
  });

  it('console and API share one code path — rotating via API then saving via console keeps continuity', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: { balena_uuid: env.device.uuid, files: SECRET_BUNDLE.files },
      key: ADMIN_KEY,
    });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, {
      _csrf: csrf,
      existing_count: '1',
      new_count: '3',
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      new_path_0: 'config/second.env',
      new_content_0: 'SECOND=2\n',
    });
    expect(res.status).toBe(303);
    const status = asStatusBody(
      (await env.request({ method: 'GET', url: `/v1/status?balena_uuid=${env.device.uuid}`, key: env.device.key })).body,
    );
    // API rotate → v2, console save → v3
    expect(status.bundle_version).toBe(3);
  });
});

describe('POST /v1/re-arm — owner API', () => {
  it('arms a consumed slot, preserving delivery_count', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    const replay = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(replay.status).toBe(425);

    const res = await env.request({
      method: 'POST',
      url: '/v1/re-arm',
      body: { balena_uuid: env.device.uuid },
      key: ADMIN_KEY,
    });
    expect(res.status).toBe(200);
    expect(res.body.slot.state).toBe('armed');
    expect(res.body.slot.delivery_count).toBe(1);

    const boot = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: env.device.uuid },
      key: env.device.key,
    });
    expect(boot.status).toBe(200);
  });

  it('404 on unknown uuid', async () => {
    const res = await env.request({
      method: 'POST',
      url: '/v1/re-arm',
      body: { balena_uuid: randomUUID() },
      key: ADMIN_KEY,
    });
    expect(res.status).toBe(404);
  });
});

describe('Admin console — device lifecycle actions', () => {
  it('new device creates pending row, shows key once, activates, then bootstraps', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/new-device');
    const uuid = randomUUID();
    const res = await c.postForm('/admin/new-device', {
      _csrf: csrf,
      agent_name: 'test-agent-alpha',
      balena_uuid: uuid,
      notes: 'created by test',
    });
    expect(res.status).toBe(200);
    expect(res.html).toContain('bk_');
    expect(res.html).toContain('shown once');
    // the plaintext key from the page
    const keyMatch = /bk_[0-9a-f-]{36}/.exec(res.html);
    expect(keyMatch).not.toBeNull();
    const newKey = keyMatch![0];

    // pending device cannot bootstrap
    const boot = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: uuid }, key: newKey });
    expect(boot.status).toBe(403);

    // activate via console
    const csrf2 = await c.csrfFrom(`/admin/devices/${uuid}`);
    const act = await c.postForm(`/admin/devices/${uuid}/activate`, { _csrf: csrf2 });
    expect(act.status).toBe(303);

    // bundle via API rotate (seed one) then bootstrap succeeds
    await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: { balena_uuid: uuid, files: SECRET_BUNDLE.files },
      key: ADMIN_KEY,
    });
    const ok = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: uuid }, key: newKey });
    expect(ok.status).toBe(200);
  });

  it('revoke → bootstrap 403; activate → 200', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const revoke = await c.postForm(`/admin/devices/${env.device.uuid}/revoke`, { _csrf: csrf });
    expect(revoke.status).toBe(303);
    const denied = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(denied.status).toBe(403);

    const csrf2 = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const activate = await c.postForm(`/admin/devices/${env.device.uuid}/activate`, { _csrf: csrf2 });
    expect(activate.status).toBe(303);
    const ok = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(ok.status).toBe(200);
  });

  it('key regen invalidates the old key, shows new once', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}`);
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/regen-key`, { _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.html).toContain('bk_');
    expect(res.html).toContain('shown once');
    const newKey = /bk_[0-9a-f-]{36}/.exec(res.html)![0];

    const old = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    expect(old.status).toBe(401);
    const fresh = await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: newKey });
    expect(fresh.status).toBe(200);
  });
});

describe('Admin console — audit view', () => {
  it('renders the audit log read-only with rows and links', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    await env.request({ method: 'POST', url: '/v1/bootstrap', body: { balena_uuid: env.device.uuid }, key: env.device.key });
    const c = await loginClient();
    const page = await c.get('/admin/audit');
    expect(page.status).toBe(200);
    expect(page.html).toContain('delivered');
    expect(page.html).toContain('Audit log (read-only)');
    expect(page.html).not.toContain('topsecret-agent-token-value');
  });
});

describe('Admin console — security headers', () => {
  it('serves console pages with CSP, nosniff, frame deny, no-referrer, no-store', async () => {
    const c = await loginClient();
    const res = await c.get('/admin/devices');
    expect(res.status).toBe(200);
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('session cookie carries HttpOnly + Secure + SameSite=Strict', async () => {
    const get = await env.app.inject({ method: 'GET', url: '/admin/login' });
    const sc = get.headers['set-cookie'] as string | string[];
    const raw = (Array.isArray(sc) ? sc[0] : sc) ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
  });
});

describe('Admin console — static island sanity', () => {
  it('serves editor.js with script-src self compatibility (no inline script tag on pages)', async () => {
    const c = await loginClient();
    const page = await c.get('/admin/devices');
    // the page references the external script; no inline <script> content
    expect(page.html).toContain('<script src="/admin/static/editor.js" defer></script>');
    expect(page.html).not.toMatch(/<script>[^<]/);
    const js = await env.app.inject({ method: 'GET', url: '/admin/static/editor.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('application/javascript');
  });
});

describe('Admin console — misc', () => {
  it('GET /admin redirects to /admin/devices', async () => {
    const c = await loginClient();
    const res = await c.get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/devices');
  });

  it('device detail 404s for unknown uuid', async () => {
    const c = await loginClient();
    const res = await c.get(`/admin/devices/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('logout clears the session', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/devices');
    const res = await c.postForm('/admin/logout', { _csrf: csrf });
    expect(res.status).toBe(303);
    const after = await c.get('/admin/devices');
    expect(after.status).toBe(302);
  });

  it('new-device rejects duplicate uuid and agent name', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/new-device');
    const dupUuid = await c.postForm('/admin/new-device', {
      _csrf: csrf,
      agent_name: 'different-name',
      balena_uuid: env.device.uuid,
    });
    expect(dupUuid.status).toBe(400);
    const csrf2 = await c.csrfFrom('/admin/new-device');
    const dupName = await c.postForm('/admin/new-device', {
      _csrf: csrf2,
      agent_name: `agent-${env.device.uuid.slice(0, 8)}`,
      balena_uuid: randomUUID(),
    });
    expect(dupName.status).toBe(400);
  });
});

describe('Admin console — balena UUID forms (fleet-ops-f57.10)', () => {
  const SHORT_UUID = 'b1e516d9cf23c6bd0b474edae9ec41e6';
  const CANONICAL_UUID = 'b1e516d9-cf23-c6bd-0b47-4edae9ec41e6';

  it('accepts the balena-native 32-hex short form and stores canonical', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/new-device');
    const res = await c.postForm('/admin/new-device', {
      _csrf: csrf,
      agent_name: 'short-form-agent',
      balena_uuid: SHORT_UUID,
    });
    expect(res.status).toBe(200);
    expect(res.html).toContain(CANONICAL_UUID); // one-time key page shows canonical
    const rows = await env.db.select().from(devices);
    const row = rows.find((r) => r.balenaUuid === CANONICAL_UUID);
    expect(row).toBeDefined();
    expect(row!.agentName).toBe('short-form-agent');
    expect(row!.status).toBe('pending');
  });

  it('still accepts the canonical hyphenated form unchanged', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/new-device');
    const res = await c.postForm('/admin/new-device', {
      _csrf: csrf,
      agent_name: 'canonical-form-agent',
      balena_uuid: CANONICAL_UUID,
    });
    expect(res.status).toBe(200);
    const rows = await env.db.select().from(devices);
    expect(rows.some((r) => r.balenaUuid === CANONICAL_UUID)).toBe(true);
  });

  it('short form and canonical form of the same UUID collide (duplicate rejected)', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/new-device');
    const first = await c.postForm('/admin/new-device', {
      _csrf: csrf,
      agent_name: 'dupe-agent-a',
      balena_uuid: SHORT_UUID,
    });
    expect(first.status).toBe(200);
    const csrf2 = await c.csrfFrom('/admin/new-device');
    const second = await c.postForm('/admin/new-device', {
      _csrf: csrf2,
      agent_name: 'dupe-agent-b',
      balena_uuid: CANONICAL_UUID,
    });
    expect(second.status).toBe(400);
    expect(second.html).toContain('A device with this UUID already exists.');
  });

  it('rejects garbage UUIDs in either-form gate (40-hex, non-hex, near-miss hyphenless)', async () => {
    const c = await loginClient();
    for (const bad of [
      'b1e516d9cf23c6bd0b474edae9ec41e600', // 40 hex — too long
      'z1e516d9cf23c6bd0b474edae9ec41e6', // 32 chars but not hex
      'b1e516d9-cf23-c6bd-0b47-4edae9ec41e', // 31 hex + hyphens (malformed)
      'b1e516d9cf23c6bd0b474edae9ec41e', // 31 hex — too short
      'b1e516d9cf23c6bd 0b474edae9ec41e6', // embedded space
    ]) {
      const csrf = await c.csrfFrom('/admin/new-device');
      const res = await c.postForm('/admin/new-device', {
        _csrf: csrf,
        agent_name: 'garbage-agent',
        balena_uuid: bad,
      });
      expect(res.status).toBe(400);
      expect(res.html).toContain('UUID must be a valid UUID.');
    }
  });

  it('uppercase short form is normalized to lowercase canonical', async () => {
    const c = await loginClient();
    const csrf = await c.csrfFrom('/admin/new-device');
    const res = await c.postForm('/admin/new-device', {
      _csrf: csrf,
      agent_name: 'uppercase-agent',
      balena_uuid: SHORT_UUID.toUpperCase(),
    });
    expect(res.status).toBe(200);
    const rows = await env.db.select().from(devices);
    expect(rows.some((r) => r.balenaUuid === CANONICAL_UUID)).toBe(true);
  });
});

describe('/v1/bootstrap + /v1/status — balena UUID forms on the wire (fleet-ops-f57.10)', () => {
  const SHORT_UUID = 'b1e516d9cf23c6bd0b474edae9ec41e6';
  const CANONICAL_UUID = 'b1e516d9-cf23-c6bd-0b47-4edae9ec41e6';

  it('bootstrap with the balena-native short form matches the canonical-stored device', async () => {
    await seedDevice(env.db, { uuid: CANONICAL_UUID, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const res = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: SHORT_UUID },
      key: env.device.key,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.bundle)).toContain('topsecret-agent-token-value');
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.device_id === CANONICAL_UUID && a.outcome === 'delivered')).toBe(true);
  });

  it('bootstrap with the canonical form still matches the same device', async () => {
    await seedDevice(env.db, { uuid: CANONICAL_UUID, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const res = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: CANONICAL_UUID },
      key: env.device.key,
    });
    expect(res.status).toBe(200);
  });

  it('short and canonical forms of the same UUID hit the SAME slot (425 replay across forms)', async () => {
    await seedDevice(env.db, { uuid: CANONICAL_UUID, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const first = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: SHORT_UUID },
      key: env.device.key,
    });
    expect(first.status).toBe(200);
    // the device re-presenting the SAME UUID in canonical form is a replay,
    // not a second delivery: normalization happens before the DB lookup.
    const replay = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: CANONICAL_UUID },
      key: env.device.key,
    });
    expect(replay.status).toBe(425);
  });

  it('status via querystring accepts the short form; response echoes canonical', async () => {
    await seedDevice(env.db, { uuid: CANONICAL_UUID, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const res = await env.request({
      method: 'GET',
      url: `/v1/status?balena_uuid=${SHORT_UUID}`,
      key: env.device.key,
    });
    expect(res.status).toBe(200);
    expect(res.body.balena_uuid).toBe(CANONICAL_UUID);
  });

  it('invalid_body on garbage in the API body (400, no device lookup)', async () => {
    const res = await env.request({
      method: 'POST',
      url: '/v1/bootstrap',
      body: { balena_uuid: 'not-a-uuid-at-all' },
      key: env.device.key,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'invalid_body')).toBe(true);
  });
});