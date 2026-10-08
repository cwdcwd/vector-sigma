import { describe, it, expect, beforeEach } from 'vitest';
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
import { BundleFileSchema, BINARY_MAX_DECODED_BYTES } from '@vector-sigma/shared';
import { CANONICAL_PATHS } from '../src/structured-fields.js';

/**
 * fleet-ops-1py.5 — the per-device logo capability, end to end through the
 * REAL admin console:
 *
 *   1. Bundle contract: optional encoding:'base64' on BundleFileSchema,
 *      256KB decoded cap enforced at the schema layer.
 *   2. Console upload: POST /admin/devices/:uuid/logo (multipart, session +
 *      CSRF gated, PNG/JPG magic-byte validated, 256KB capped).
 *   3. Narrow read route: GET /admin/devices/:uuid/logo serves ONLY the
 *      canonical logo path, session-gated, ETag keyed to bundle_version.
 *   4. Carry-through (the 5a corruption class): every rotate/merge site
 *      preserves encoding — structured save, mint-merge shapes, REST
 *      /v1/rotate replace.
 */

let env: TestEnv;
const fast = { memoryCostKiB: 256, timeCost: 1 };
const ADMIN_KEY = 'ak_test-logo-key-0001';

beforeEach(async () => {
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
  await seedDevice(env.db, {
    uuid: env.device.uuid,
    hash: env.device.hash,
    bundle: {
      schema_version: 1,
      bundle_version: 1,
      generated_at: '2026-01-01T00:00:00Z',
      files: [{ path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=logo-host\n' }],
    },
  });
});

// -- tiny real PNG/JPG headers (magic bytes are what the handler checks) --
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_BYTES = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

/** Hand-rolled multipart body (light-my-request takes raw buffers fine). */
function multipart(
  parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; data?: Buffer }>,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----vstest${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp =
      p.filename !== undefined
        ? `form-data; name="${p.name}"; filename="${p.filename}"`
        : `form-data; name="${p.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n`));
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(p.data ?? Buffer.from(p.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function loginClient(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  const res = await c.login(ADMIN_KEY);
  expect(res.status).toBe(303);
  return c;
}

async function detailCsrf(c: AdminClient): Promise<string> {
  const page = await c.get(`/admin/devices/${env.device.uuid}`);
  expect(page.status).toBe(200);
  const m = /name="_csrf" value="([^"]+)"/.exec(page.html);
  if (!m) throw new Error('no csrf on detail page');
  return m[1];
}

async function postLogo(
  c: AdminClient,
  opts: { csrf?: string; data: Buffer; filename?: string },
): Promise<{ status: number; headers: Record<string, unknown> }> {
  const { payload, headers } = multipart([
    { name: '_csrf', value: opts.csrf ?? 'bogus' },
    {
      name: 'logo',
      filename: opts.filename ?? 'logo.png',
      contentType: 'image/png',
      data: opts.data,
    },
  ]);
  const res = await env.app.inject({
    method: 'POST',
    url: `/admin/devices/${env.device.uuid}/logo`,
    headers: { ...headers, cookie: c.cookieHeaderForTest() },
    payload,
  });
  return { status: res.statusCode, headers: res.headers };
}

/** Current bundle row (the stored shape the device consumes). */
async function currentBundle(): Promise<{ version: number; files: Array<Record<string, unknown>> }> {
  const rows = await env.db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, env.device.uuid));
  expect(rows.length).toBe(1);
  const bundle = rows[0].bundle as { files: Array<Record<string, unknown>> };
  return { version: rows[0].version, files: bundle.files };
}

describe('1py.5 — bundle contract (encoding field)', () => {
  it('accepts an optional encoding:"base64" and stays silent without it', () => {
    expect(BundleFileSchema.safeParse({ path: 'a.txt', mode: '0600', content: 'x' }).success).toBe(true);
    expect(
      BundleFileSchema.safeParse({
        path: 'assets/logo.png',
        mode: '0600',
        content: PNG_BYTES.toString('base64'),
        encoding: 'base64',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-base64 encoding value', () => {
    const r = BundleFileSchema.safeParse({ path: 'a.bin', mode: '0600', content: 'x', encoding: 'hex' });
    expect(r.success).toBe(false);
  });

  it('rejects base64 payloads decoding over the 256KB cap (schema layer)', () => {
    const big = Buffer.alloc(BINARY_MAX_DECODED_BYTES + 1, 0x41).toString('base64');
    const r = BundleFileSchema.safeParse({ path: 'big.bin', mode: '0600', content: big, encoding: 'base64' });
    expect(r.success).toBe(false);
  });

  it('accepts base64 payloads at exactly the cap', () => {
    const exact = Buffer.alloc(BINARY_MAX_DECODED_BYTES, 0x42).toString('base64');
    const r = BundleFileSchema.safeParse({ path: 'exact.bin', mode: '0600', content: exact, encoding: 'base64' });
    expect(r.success).toBe(true);
  });
});

describe('1py.5 — logo upload (console multipart)', () => {
  it('stores a PNG as a base64 bundle entry via the one rotate path', async () => {
    const c = await loginClient();
    const csrf = await detailCsrf(c);
    const before = await currentBundle();
    const res = await postLogo(c, { csrf, data: PNG_BYTES });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe(`/admin/devices/${env.device.uuid}`);
    const after = await currentBundle();
    expect(after.version).toBe(before.version + 1);
    const logo = after.files.find((f) => f['path'] === CANONICAL_PATHS.logo);
    expect(logo).toBeDefined();
    expect(logo!['encoding']).toBe('base64');
    expect(Buffer.from(String(logo!['content']), 'base64').equals(PNG_BYTES)).toBe(true);
    // The pre-existing text file carried through untouched:
    const env2 = after.files.find((f) => f['path'] === 'config/agent.env');
    expect(env2!['content']).toBe('AGENT_NAME=logo-host\n');
    expect(env2!['encoding']).toBeUndefined();
    const audit = await getAuditRows(env);
    expect(audit.some((a) => a.reason === 'device_logo_uploaded')).toBe(true);
  });

  it('accepts a JPG and replaces a previous PNG (single logo entry)', async () => {
    const c = await loginClient();
    const csrf = await detailCsrf(c);
    await postLogo(c, { csrf, data: PNG_BYTES });
    const res = await postLogo(c, { csrf, data: JPG_BYTES, filename: 'logo.jpg' });
    expect(res.status).toBe(303);
    const { files } = await currentBundle();
    const logos = files.filter((f) => f['path'] === CANONICAL_PATHS.logo);
    expect(logos.length).toBe(1);
    expect(Buffer.from(String(logos[0]!['content']), 'base64').equals(JPG_BYTES)).toBe(true);
  });

  it('rejects a non-PNG/JPG payload (magic bytes)', async () => {
    const c = await loginClient();
    const csrf = await detailCsrf(c);
    const res = await postLogo(c, { csrf, data: GIF_BYTES, filename: 'logo.gif' });
    expect(res.status).toBe(400);
    // Nothing stored, version unmoved.
    expect((await currentBundle()).version).toBe(1);
  });

  it('rejects an oversized upload (handler layer, 413)', async () => {
    const c = await loginClient();
    const csrf = await detailCsrf(c);
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(BINARY_MAX_DECODED_BYTES + 1, 0x41)]);
    const res = await postLogo(c, { csrf, data: big });
    expect([413, 400]).toContain(res.status);
    expect((await currentBundle()).version).toBe(1);
  });

  it('rejects a bad CSRF token (403), stores nothing', async () => {
    const c = await loginClient();
    const res = await postLogo(c, { csrf: 'wrong', data: PNG_BYTES });
    expect(res.status).toBe(403);
    expect((await currentBundle()).version).toBe(1);
  });

  it('redirects an unauthenticated upload to login', async () => {
    const { payload, headers } = multipart([
      { name: '_csrf', value: 'x' },
      { name: 'logo', filename: 'logo.png', contentType: 'image/png', data: PNG_BYTES },
    ]);
    const res = await env.app.inject({
      method: 'POST',
      url: `/admin/devices/${env.device.uuid}/logo`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/admin/login');
  });
});

describe('1py.5 — logo read route (narrow by design)', () => {
  it('serves the stored logo, image/png, ETag keyed to bundle version', async () => {
    const c = await loginClient();
    const csrf = await detailCsrf(c);
    await postLogo(c, { csrf, data: PNG_BYTES });
    const { version } = await currentBundle();
    const res = await env.app.inject({
      method: 'GET',
      url: `/admin/devices/${env.device.uuid}/logo`,
      headers: { cookie: c.cookieHeaderForTest() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['etag']).toBe(`"logo-v${version}"`);
    // rawPayload preserves bytes; .body would UTF-8-mangle the binary.
    expect(res.rawPayload.subarray(0, 8).equals(PNG_BYTES.subarray(0, 8))).toBe(true);
  });

  it('404s when the device has no logo entry', async () => {
    const c = await loginClient();
    const res = await c.get(`/admin/devices/${env.device.uuid}/logo`);
    expect(res.status).toBe(404);
  });

  it('redirects to login without a session', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/admin/devices/${env.device.uuid}/logo` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/admin/login');
  });

  it('404s for an unknown device', async () => {
    const c = await loginClient();
    const res = await c.get('/admin/devices/00000000-0000-0000-0000-000000000000/logo');
    expect(res.status).toBe(404);
  });
});

describe('1py.5 — encoding carry-through (the rotate corruption class)', () => {
  it('structured save after logo upload keeps the logo entry intact', async () => {
    const c = await loginClient();
    const csrf = await detailCsrf(c);
    await postLogo(c, { csrf, data: PNG_BYTES });

    // The REAL editor form posts an existing-file row for EVERY current
    // bundle file (server-rendered, admin.ts GET /bundle) — including the
    // logo, with blank content (keep). A structured save therefore rides
    // the same keep set a browser session would produce.
    const editorCsrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const save = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, {
      _csrf: editorCsrf,
      existing_count: 2,
      new_count: 0,
      existing_path_0: 'config/agent.env',
      existing_content_0: '',
      existing_path_1: CANONICAL_PATHS.logo,
      existing_content_1: '',
      structured_agent_name: 'renamed-agent',
    });
    expect(save.status).toBe(303);

    const { files } = await currentBundle();
    const logo = files.find((f) => f['path'] === CANONICAL_PATHS.logo);
    expect(logo).toBeDefined();
    expect(logo!['encoding']).toBe('base64');
    expect(Buffer.from(String(logo!['content']), 'base64').equals(PNG_BYTES)).toBe(true);
    const agentEnv = files.find((f) => f['path'] === 'config/agent.env');
    expect(agentEnv!['content']).toContain('AGENT_NAME=renamed-agent');
  });

  it('REST /v1/rotate replace carries encoding through to the stored bundle', async () => {
    // /v1/rotate is the OWNER API — the admin key authenticates it.
    const res = await env.request({
      method: 'POST',
      url: '/v1/rotate',
      key: ADMIN_KEY,
      body: {
        balena_uuid: env.device.uuid,
        files: [
          { path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=rot\n' },
          { path: CANONICAL_PATHS.logo, mode: '0600', content: PNG_BYTES.toString('base64'), encoding: 'base64' },
        ],
      },
    });
    expect(res.status).toBe(200);
    const { files } = await currentBundle();
    const logo = files.find((f) => f['path'] === CANONICAL_PATHS.logo);
    expect(logo!['encoding']).toBe('base64');
    expect(Buffer.from(String(logo!['content']), 'base64').equals(PNG_BYTES)).toBe(true);
  });

  it('oversize base64 rotate payload rejected by the schema layer (no version bump)', async () => {
    const big = Buffer.alloc(BINARY_MAX_DECODED_BYTES + 1, 0x41).toString('base64');
    const res = await env.request({
      method: 'POST',
      url: '/v1/rotate',
      key: ADMIN_KEY,
      body: {
        balena_uuid: env.device.uuid,
        files: [{ path: 'big.bin', mode: '0600', content: big, encoding: 'base64' }],
      },
    });
    expect(res.status).toBe(400);
    expect((await currentBundle()).version).toBe(1);
  });
});

describe('1py.5 — detail page logo card', () => {
  it('shows the upload form before any logo, avatar + form after', async () => {
    const c = await loginClient();
    const before = await c.get(`/admin/devices/${env.device.uuid}`);
    expect(before.status).toBe(200);
    expect(before.html).toContain('No logo yet — upload one to see it in the device list.');
    expect(before.html).toContain('enctype="multipart/form-data"');

    const csrf = await detailCsrf(c);
    await postLogo(c, { csrf, data: PNG_BYTES });
    const after = await c.get(`/admin/devices/${env.device.uuid}`);
    expect(after.html).toContain(`<img src="/admin/devices/${env.device.uuid}/logo"`);
    expect(after.html).not.toContain('No logo yet.');
  });
});