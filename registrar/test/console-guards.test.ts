/**
 * Every console route's guards, as one table: no session -> login redirect; a state-changing
 * POST without the CSRF token -> 403 and no change; a per-device route for an unknown device
 * -> 404. A new route that forgets one of these fails here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AdminClient, createTestEnv, getAuditRows, seedAdminKey, type TestEnv } from './helpers.js';

const ADMIN_KEY = 'ak_test-console-guards-01';
let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({ hashParams: { memoryCostKiB: 256, timeCost: 1 } });
  await seedAdminKey(env.db, ADMIN_KEY);
});

async function loggedIn(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  expect((await c.login(ADMIN_KEY)).status).toBe(303);
  return c;
}

const DEVICE_POSTS = [
  'activate',
  'revoke',
  're-arm',
  'regen-key',
  'bundle',
  'mesh-enroll',
  'mint-memory-keys',
  'mint-model-key',
  'a2a-key/approve',
  'a2a-key/reject-conflict',
  'a2a-key/revoke',
];
const OTHER_POSTS = [
  '/admin/a2a/strict',
  '/admin/admin-keys',
  '/admin/admin-keys/1/revoke',
  '/admin/mesh-enroll-keys',
  '/admin/mesh-enroll-keys/1/revoke',
  '/admin/new-device',
  '/admin/logout',
];
const GETS = ['/admin/devices', '/admin/audit', '/admin/a2a', '/admin/admin-keys', '/admin/mesh-enroll-keys', '/admin/new-device'];
const DEVICE_GETS = ['', '/bundle'];

describe('console guards', () => {
  it.each([...GETS, ...DEVICE_GETS.map((p) => `/admin/devices/${randomUUID()}${p}`)])('GET %s without a session redirects to login', async (url) => {
    const res = await new AdminClient(env.app).get(url);
    expect(res.status).toBe(302);
    expect(String(res.headers['location'])).toContain('/admin/login');
  });

  it.each([...OTHER_POSTS, ...DEVICE_POSTS.map((p) => `/admin/devices/${env?.device.uuid ?? 'x'}/${p}`)])(
    'POST %s without a session redirects to login',
    async (url) => {
      const res = await new AdminClient(env.app).postForm(url.replace('/x/', `/${env.device.uuid}/`), {});
      expect(res.status).toBe(302);
    },
  );

  it.each([...OTHER_POSTS, ...DEVICE_POSTS.map((p) => `DEVICE/${p}`)])('POST %s without the CSRF token is 403 and changes nothing', async (route) => {
    const c = await loggedIn();
    const url = route.startsWith('DEVICE/') ? `/admin/devices/${env.device.uuid}/${route.slice(7)}` : route;
    const auditBefore = (await getAuditRows(env)).length;
    const res = await c.postForm(url, { strict: 'on', agent_name: 'x', label: 'x' });
    expect(res.status).toBe(403);
    expect((await getAuditRows(env)).length).toBe(auditBefore);
  });

  it.each([...DEVICE_POSTS, ...DEVICE_GETS.map((p) => `GET${p}`)])('%s for an unknown device is 404', async (route) => {
    const c = await loggedIn();
    const uuid = randomUUID();
    if (route.startsWith('GET')) {
      expect((await c.get(`/admin/devices/${uuid}${route.slice(3)}`)).status).toBe(404);
      return;
    }
    const csrf = await c.csrfFrom('/admin/devices');
    const res = await c.postForm(`/admin/devices/${uuid}/${route}`, { _csrf: csrf });
    expect([404, 303]).toContain(res.status);
    if (res.status === 303) expect(String(res.headers['location'])).toMatch(/error=/); // a2a-key verbs report via the console
  });
});
