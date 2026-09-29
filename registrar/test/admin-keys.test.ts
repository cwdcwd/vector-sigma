import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, seedAdminKey, AdminClient, getAuditRows, type TestEnv } from './helpers.js';
import { adminKeys } from '../src/db/schema.js';

/**
 * Admin-key UI (fleet-ops-w5d): the /admin/setup first-run bootstrap and
 * the session-gated /admin/admin-keys management.
 *
 * Contracts under test (bead fleet-ops-w5d):
 *   - /admin/setup reachable ONLY while admin_keys is empty; 404s (GET and
 *     POST) once any key exists — a stale setup form must never mint
 *   - the first-run mint is CSRF-protected (double-submit cookie) and
 *     rate-limited, writes an audit row (outcome=admin,
 *     reason=first_admin_key_minted), and shows the plaintext EXACTLY ONCE
 *   - the mint creates a session (owner lands logged-in)
 *   - session-gated key management: list, mint (show-once), revoke — all
 *     CSRF-gated, all audited
 */

const fast = { memoryCostKiB: 256, timeCost: 1 };
const SEED_KEY = 'ak_test-seed-admin-key-0001';

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({ hashParams: fast });
});

/** Drive the REAL setup flow like a browser: GET form, POST with the cookie. */
async function setupMint(label: string): Promise<{ status: number; html: string }> {
  const c = new AdminClient(env.app);
  const get = await c.get('/admin/setup');
  if (get.status !== 200) return { status: get.status, html: get.html };
  // The csrf value is embedded in the form AND the set-cookie; the client
  // jar already holds the cookie from the GET — harvest the input value.
  const m = /name="_csrf" value="([^"]+)"/.exec(get.html);
  const csrf = m ? m[1] : '';
  return c.postForm('/admin/setup', { label, _csrf: csrf });
}

describe('Admin-key UI — /admin/setup first-run bootstrap', () => {
  it('GET /admin/setup serves the mint form while admin_keys is empty', async () => {
    const c = new AdminClient(env.app);
    const res = await c.get('/admin/setup');
    expect(res.status).toBe(200);
    expect(res.html).toContain('First admin key');
    expect(res.html).toContain('Mint first admin key');
  });

  it('first-run mint works with zero shell access: key shown once, row written, audit row present, session created', async () => {
    const res = await setupMint('bootstrap');
    expect(res.status).toBe(200);
    // Plaintext key shown exactly once, in the secret-once block.
    const keyMatch = /<div class="secret-once">ak_[^<]+<\/div>/.exec(res.html);
    expect(keyMatch).not.toBeNull();
    expect(res.html).toContain('shown once, never stored');
    // The row exists with the label; the plaintext is NOT in the DB.
    const rows = await env.db.select().from(adminKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('bootstrap');
    expect(rows[0].hash).not.toContain('ak_');
    // Audit row.
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'first_admin_key_minted' && a.outcome === 'admin')).toBe(true);
    // The minted key actually authenticates the console (full-loop proof).
    const mintedKey = keyMatch ? keyMatch[0].replace(/<[^>]+>/g, '') : '';
    const c2 = new AdminClient(env.app);
    const login = await c2.login(mintedKey);
    expect(login.status).toBe(303);
    expect(c2.hasSession()).toBe(true);
  });

  it('setup route 404s (GET and POST) once any admin key exists', async () => {
    await seedAdminKey(env.db, SEED_KEY);
    const c = new AdminClient(env.app);
    const get = await c.get('/admin/setup');
    expect(get.status).toBe(404);
    // A stale form posting to the route must not mint either.
    const post = await c.postForm('/admin/setup', { label: 'sneaky', _csrf: 'whatever' });
    expect(post.status).toBe(404);
    const rows = await env.db.select().from(adminKeys);
    expect(rows).toHaveLength(1); // only the seed
  });

  it('setup POST requires the double-submit CSRF cookie', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/admin/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'label=x&_csrf=forged',
    });
    expect(res.statusCode).toBe(403);
    const rows = await env.db.select().from(adminKeys);
    expect(rows).toHaveLength(0); // nothing minted on a CSRF failure
  });

  it('setup POST with a missing label bounces with 400, nothing minted', async () => {
    const res = await setupMint('');
    expect(res.status).toBe(400);
    const rows = await env.db.select().from(adminKeys);
    expect(rows).toHaveLength(0);
  });

  it('setup mint is rate-limited after repeated CSRF failures (429 + Retry-After)', async () => {
    // 5 failed attempts trips the shared limiter (maxFailures=5).
    const c = new AdminClient(env.app);
    for (let i = 0; i < 5; i++) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/admin/setup',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'label=x&_csrf=forged',
      });
      expect(res.statusCode).toBe(403);
    }
    const get = await c.get('/admin/setup');
    expect(get.status).toBe(200); // GET is not gated
    const post = await setupMint('should-be-locked');
    expect(post.status).toBe(429);
    expect(post.html).toContain('Too many failed attempts');
    const rows = await env.db.select().from(adminKeys);
    expect(rows).toHaveLength(0); // locked out, nothing minted
  });
});

describe('Admin-key UI — session-gated /admin/admin-keys management', () => {
  it('unauthenticated access redirects to login', async () => {
    const c = new AdminClient(env.app);
    const list = await c.get('/admin/admin-keys');
    expect(list.status).toBe(302);
    expect(list.headers.location).toBe('/admin/login');
    const mint = await c.postForm('/admin/admin-keys', { label: 'x' });
    expect(mint.status).toBe(302);
  });

  it('second mint via session works: listed, shown once, audited', async () => {
    await seedAdminKey(env.db, SEED_KEY);
    const c = new AdminClient(env.app);
    await c.login(SEED_KEY);
    const list = await c.get('/admin/admin-keys');
    expect(list.status).toBe(200);
    expect(list.html).toContain('Admin keys');
    expect(list.html).toContain(SEED_KEY.slice(0, 0)); // placeholder no-op
    expect(list.html).toContain('test-admin'); // seed label rendered
    // Mint through the real form flow.
    const csrf = await c.csrfFrom('/admin/admin-keys');
    const minted = await c.postForm('/admin/admin-keys', { label: 'rotation-2026', _csrf: csrf });
    expect(minted.status).toBe(200);
    const keyMatch = /<div class="secret-once">ak_[^<]+<\/div>/.exec(minted.html);
    expect(keyMatch).not.toBeNull();
    expect(minted.html).toContain('rotation-2026');
    // The list now carries both rows.
    const list2 = await c.get('/admin/admin-keys');
    expect(list2.html).toContain('rotation-2026');
    expect(list2.html).toContain('test-admin');
    // Audit row for the mint.
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'admin_key_minted')).toBe(true);
    // The minted key authenticates (full-loop).
    const mintedKey = keyMatch ? keyMatch[0].replace(/<[^>]+>/g, '') : '';
    const c2 = new AdminClient(env.app);
    expect((await c2.login(mintedKey)).status).toBe(303);
  });

  it('session mint is CSRF-gated (403 without the token)', async () => {
    await seedAdminKey(env.db, SEED_KEY);
    const c = new AdminClient(env.app);
    await c.login(SEED_KEY);
    const res = await c.postForm('/admin/admin-keys', { label: 'no-csrf' });
    expect(res.status).toBe(403);
    const rows = await env.db.select().from(adminKeys);
    expect(rows).toHaveLength(1);
  });

  it('revoking an old key removes the row and writes an audit row (rotation path)', async () => {
    await seedAdminKey(env.db, SEED_KEY);
    const c = new AdminClient(env.app);
    await c.login(SEED_KEY);
    // Mint a second key, then revoke the FIRST row (id 1).
    const csrf = await c.csrfFrom('/admin/admin-keys');
    await c.postForm('/admin/admin-keys', { label: 'new-key', _csrf: csrf });
    const before = await env.db.select().from(adminKeys);
    expect(before).toHaveLength(2);
    const res = await c.postForm('/admin/admin-keys/1/revoke', { _csrf: csrf });
    expect(res.status).toBe(303);
    const after = await env.db.select().from(adminKeys);
    expect(after).toHaveLength(1);
    expect(after[0].label).toBe('new-key');
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'admin_key_revoked')).toBe(true);
    // The revoked key no longer authenticates.
    const c2 = new AdminClient(env.app);
    expect((await c2.login(SEED_KEY)).status).toBe(401);
  });

  it('revoke is CSRF-gated and unknown ids 404', async () => {
    await seedAdminKey(env.db, SEED_KEY);
    const c = new AdminClient(env.app);
    await c.login(SEED_KEY);
    const csrf = await c.csrfFrom('/admin/admin-keys');
    const noCsrf = await c.postForm('/admin/admin-keys/1/revoke', {});
    expect(noCsrf.status).toBe(403);
    const bogus = await c.postForm('/admin/admin-keys/999/revoke', { _csrf: csrf });
    expect(bogus.status).toBe(404);
    const malformed = await c.postForm('/admin/admin-keys/abc/revoke', { _csrf: csrf });
    expect(malformed.status).toBe(404);
  });
});