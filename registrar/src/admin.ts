import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { devices, identityBlobs, deliveryLog, deliverySlots } from './db/schema.js';
import { keyFingerprint, hashKey } from './db/key-crypto.js';
import { audit } from './audit.js';
import { AuthRateLimiter } from './rate-limit.js';
import { SessionManager, SESSION_COOKIE, CSRF_COOKIE, type AdminSession } from './session.js';
import { verifyAdminKey } from './admin-auth.js';
import { mintDeviceKey } from './keys.js';
import { rotateBundle, rearmSlot, parseConsoleFiles, EmptyBundleError, InvalidBundleError } from './rotate.js';
import { readSlot } from './slots.js';
import type { Clock } from './clock.js';
import type { RegistrarConfig } from './config.js';
import * as html from './admin-html.js';

export interface AdminOptions {
  db: NodePgDatabase;
  config: RegistrarConfig;
  clock: Clock;
  limiter: AuthRateLimiter;
  /**
   * Session store shared with the app-level front door (fleet-ops-f57.9).
   * buildApp constructs exactly ONE SessionManager and hands it in: GET /
   * and the /admin/* routes must resolve cookies against the same
   * in-memory session set — two instances would silently disagree about
   * who is logged in.
   */
  sessions: SessionManager;
}

type DbRow = typeof devices.$inferSelect;

/** Security headers on every /admin response. */
function securityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header(
      'content-security-policy',
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    )
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store');
}

function tokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseFormBody(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      out.set(decodeURIComponent(part.replace(/\+/g, ' ')), '');
      continue;
    }
    const k = part.slice(0, eqIdx).replace(/\+/g, ' ');
    const v = part.slice(eqIdx + 1).replace(/\+/g, ' ');
    out.set(decodeURIComponent(k), decodeURIComponent(v));
  }
  return out;
}

/**
 * Parse the request Cookie header into name -> value. Exported for the
 * app-level front door (fleet-ops-f57.9), which resolves the admin
 * session cookie at GET / using the same parsing the console uses.
 */
export function cookieMap(request: FastifyRequest): Map<string, string> {
  const header = request.headers.cookie;
  const out = new Map<string, string>();
  if (!header) return out;
  for (const pair of String(header).split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deviceView(d: DbRow): html.DeviceRowView {
  return {
    balenaUuid: d.balenaUuid,
    agentName: d.agentName,
    status: d.status,
    createdAt: d.createdAt,
    notes: d.notes,
  };
}

interface BlobBundleShape {
  files: Array<{ path: string; content: string }>;
}

export function registerAdminRoutes(app: FastifyInstance, opts: AdminOptions): void {
  const { db } = opts;
  const clock = opts.clock;
  const limiter = opts.limiter;
  const sessions = opts.sessions;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, parseFormBody(String(body)));
  });

  app.get('/admin/static/editor.js', async (_req, reply) => {
    const script = `(() => {
  const preview = document.getElementById('diff-preview');
  if (!preview) return;
  const out = document.getElementById('diff-out');
  const areas = document.querySelectorAll('textarea[data-path]');
  const show = () => {
    const lines = [];
    for (const area of areas) {
      if (area.value === '') continue;
      lines.push('--- ' + area.dataset.path);
      lines.push('+++ ' + area.dataset.path + ' (new)');
      for (const line of area.value.split('\\n')) lines.push('+' + line);
    }
    if (lines.length === 0) { preview.classList.add('hidden'); return; }
    out.textContent = lines.join('\\n');
    preview.classList.remove('hidden');
  };
  for (const area of areas) area.addEventListener('input', show);
})();`;
    securityHeaders(reply).type('application/javascript').send(script);
  });

  // ---------- Login ----------

  app.get('/admin/login', async (request, reply) => {
    const existing = sessions.resolve(cookieMap(request).get(SESSION_COOKIE));
    if (existing) return reply.redirect('/admin/devices', 302);
    const token = randomBytes(32).toString('base64url');
    reply.header('set-cookie', `${CSRF_COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict`);
    return securityHeaders(reply).type('text/html').send(html.loginPage(token));
  });

  app.post('/admin/login', async (request, reply) => {
    const body = (request.body ?? new Map<string, string>()) as Map<string, string>;
    const ip = request.ip;

    const locked = limiter.lockedRetryAfter(ip);
    if (locked !== null) {
      await audit(db, {
        deviceId: null,
        outcome: 'admin',
        reason: 'admin_login_locked',
        keyId: null,
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply
        .status(429)
        .header('Retry-After', String(locked))
        .type('text/html')
        .send(html.loginPage('', 'Too many failed attempts. Try again later.', 'locked'));
    }

    const cookieToken = cookieMap(request).get(CSRF_COOKIE);
    const presentedCsrf = body.get('_csrf');
    if (!tokensEqual(cookieToken, presentedCsrf)) {
      return reply.status(403).type('text/html').send(html.loginPage('', 'Invalid request (CSRF).'));
    }

    const presentedKey = body.get('admin_key') ?? '';
    const auth = await verifyAdminKey(db, presentedKey, limiter, ip);
    if (!auth.ok) {
      if (auth.kind === 'locked') {
        return reply
          .status(429)
          .header('Retry-After', String(auth.locked))
          .type('text/html')
          .send(html.loginPage(cookieToken ?? '', 'Too many failed attempts. Try again later.', 'locked'));
      }
      await audit(db, {
        deviceId: null,
        outcome: 'admin',
        reason: auth.kind === 'device_key' ? 'device_key_rejected' : 'admin_login_failed',
        keyId: auth.kind === 'no_key' ? null : keyFingerprint(presentedKey),
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply.status(401).type('text/html').send(html.loginPage(cookieToken ?? '', 'Invalid admin key.'));
    }

    sessions.create(reply, auth.label);
    await audit(db, {
      deviceId: null,
      outcome: 'admin',
      reason: 'admin_login',
      keyId: keyFingerprint(presentedKey),
      sourceIp: ip,
      occurredAt: clock.now(),
    });
    return reply.redirect('/admin/devices', 303);
  });

  // ---------- Session gate ----------

  async function requireSession(request: FastifyRequest): Promise<AdminSession | null> {
    return sessions.resolve(cookieMap(request).get(SESSION_COOKIE));
  }

  function redirectToLogin(reply: FastifyReply): FastifyReply {
    return reply.redirect('/admin/login', 302);
  }

  function notFoundPage(): string {
    return html.page('Not found', '<h1>404 — device not found</h1>', { showNav: false });
  }

  function csrfErrorPage(): string {
    return html.page('CSRF', '<h1>403 — invalid CSRF token</h1><p>Go back, reload the page, and try again.</p>', {
      showNav: false,
    });
  }

  async function csrfGate(request: FastifyRequest, session: AdminSession): Promise<boolean> {
    const body = (request.body ?? new Map<string, string>()) as Map<string, string>;
    return sessions.verifyCsrf(session, body.get('_csrf'));
  }

  /** Load device + slot + bundle views for a detail-style page. */
  async function loadDevice(uuid: string) {
    const devRows = await db.select().from(devices).where(eq(devices.balenaUuid, uuid));
    if (devRows.length === 0) return null;
    const d = devRows[0];
    const slotSnap = await readSlot(db, uuid);
    const blobRows = await db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, uuid));
    const blob = blobRows.length > 0 ? blobRows[0] : null;
    const bundle = blob ? (blob.bundle as unknown as BlobBundleShape) : null;
    const blobView =
      blob && bundle
        ? {
            version: blob.version,
            fileCount: bundle.files.length,
            updatedAt: blob.updatedAt,
            files: bundle.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8') })),
          }
        : null;
    return {
      device: deviceView(d),
      slot: slotSnap
        ? { state: slotSnap.state, deliveryCount: slotSnap.deliveryCount, deliveredAt: slotSnap.deliveredAt }
        : null,
      blob: blobView,
    };
  }

  // ---------- Pages ----------

  app.get('/admin', async (_request, reply) => reply.redirect('/admin/devices', 302));

  app.get('/admin/devices', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    const deviceRows = await db.select().from(devices).orderBy(devices.createdAt);
    const slotRows = await db
      .select({ deviceId: deliverySlots.deviceId, state: deliverySlots.state, deliveryCount: deliverySlots.deliveryCount, deliveredAt: deliverySlots.deliveredAt })
      .from(deliverySlots);
    const blobRows = await db.select().from(identityBlobs);

    const slots = new Map<string, html.SlotRowView>();
    for (const s of slotRows) {
      slots.set(s.deviceId, { state: s.state, deliveryCount: s.deliveryCount, deliveredAt: s.deliveredAt });
    }
    const blobs = new Map<string, html.BlobRowView>();
    for (const b of blobRows) {
      const bundle = b.bundle as unknown as BlobBundleShape;
      blobs.set(b.deviceId, { version: b.version, fileCount: bundle.files.length, updatedAt: b.updatedAt });
    }
    return securityHeaders(reply)
      .type('text/html')
      .send(html.dashboardPage(deviceRows.map(deviceView), slots, blobs, session.csrfToken));
  });

  app.get('/admin/devices/:uuid', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    const uuid = (request.params as { uuid: string }).uuid;
    const loaded = await loadDevice(uuid);
    if (!loaded) return reply.status(404).type('text/html').send(notFoundPage());
    return securityHeaders(reply)
      .type('text/html')
      .send(html.deviceDetailPage({ ...loaded, csrfToken: session.csrfToken }));
  });

  app.get('/admin/audit', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    const rows = await db.select().from(deliveryLog).orderBy(desc(deliveryLog.id)).limit(200);
    const view = rows.map((r) => ({
      id: Number(r.id),
      device_id: r.deviceId,
      outcome: r.outcome,
      reason: r.reason,
      key_id: r.keyId,
      source_ip: r.sourceIp,
      occurred_at: r.occurredAt.toISOString(),
    }));
    return securityHeaders(reply).type('text/html').send(html.auditPage(view, session.csrfToken));
  });

  // ---------- Mutations (all CSRF-gated) ----------

  app.post('/admin/logout', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    sessions.destroy(reply, session.sid);
    return reply.redirect('/admin/login', 303);
  });

  app.get('/admin/new-device', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    return securityHeaders(reply).type('text/html').send(html.newDevicePage(session.csrfToken));
  });

  app.post('/admin/new-device', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const body = (request.body ?? new Map<string, string>()) as Map<string, string>;
    const agentName = (body.get('agent_name') ?? '').trim();
    const balenaUuid = (body.get('balena_uuid') ?? '').trim();
    const notes = body.get('notes')?.trim() || null;

    const errorPage = (msg: string): FastifyReply =>
      securityHeaders(reply).status(400).type('text/html').send(html.newDevicePage(session.csrfToken, msg));

    if (agentName === '' || balenaUuid === '') return errorPage('Agent name and UUID are required.');
    if (!UUID_RE.test(balenaUuid)) return errorPage('UUID must be a valid UUID.');
    if ((await db.select().from(devices).where(eq(devices.balenaUuid, balenaUuid))).length > 0) {
      return errorPage('A device with this UUID already exists.');
    }
    if ((await db.select().from(devices).where(eq(devices.agentName, agentName))).length > 0) {
      return errorPage('Agent name already in use.');
    }

    const key = mintDeviceKey();
    await db.insert(devices).values({
      balenaUuid,
      agentName,
      registrarKeyHash: await hashKey(key),
      status: 'pending',
      notes,
    });
    await audit(db, {
      deviceId: balenaUuid,
      outcome: 'admin',
      reason: 'device_created',
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    return securityHeaders(reply)
      .type('text/html')
      .send(html.newDeviceResultPage(agentName, balenaUuid, key, session.csrfToken));
  });

  app.post('/admin/devices/:uuid/re-arm', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const uuid = (request.params as { uuid: string }).uuid;
    const loaded = await loadDevice(uuid);
    if (!loaded) return reply.status(404).type('text/html').send(notFoundPage());
    await rearmSlot(db, uuid);
    await audit(db, {
      deviceId: uuid,
      outcome: 'admin',
      reason: 'slot_rearmed',
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    return reply.redirect(`/admin/devices/${uuid}`, 303);
  });

  async function deviceStatusAction(
    request: FastifyRequest,
    reply: FastifyReply,
    status: 'active' | 'revoked',
    reason: string,
  ): Promise<FastifyReply | void> {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const uuid = (request.params as { uuid: string }).uuid;
    const updated = await db
      .update(devices)
      .set({ status })
      .where(eq(devices.balenaUuid, uuid))
      .returning({ balenaUuid: devices.balenaUuid });
    if (updated.length === 0) return reply.status(404).type('text/html').send(notFoundPage());
    await audit(db, {
      deviceId: uuid,
      outcome: 'admin',
      reason,
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    return reply.redirect(`/admin/devices/${uuid}`, 303);
  }

  app.post('/admin/devices/:uuid/activate', async (request, reply) =>
    deviceStatusAction(request, reply, 'active', 'device_activated'));
  app.post('/admin/devices/:uuid/revoke', async (request, reply) =>
    deviceStatusAction(request, reply, 'revoked', 'device_revoked'));

  app.post('/admin/devices/:uuid/regen-key', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const uuid = (request.params as { uuid: string }).uuid;
    const key = mintDeviceKey();
    const updated = await db
      .update(devices)
      .set({ registrarKeyHash: await hashKey(key) })
      .where(eq(devices.balenaUuid, uuid))
      .returning({ balenaUuid: devices.balenaUuid });
    if (updated.length === 0) return reply.status(404).type('text/html').send(notFoundPage());
    await audit(db, {
      deviceId: uuid,
      outcome: 'admin',
      reason: 'device_key_regenerated',
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    const loaded = await loadDevice(uuid);
    if (!loaded) return reply.status(404).type('text/html').send(notFoundPage());
    return securityHeaders(reply)
      .type('text/html')
      .send(
        html.deviceDetailPage({
          ...loaded,
          csrfToken: session.csrfToken,
          messages: [{ kind: 'ok', text: 'Device key regenerated. The old key is now invalid.' }],
          keyOnce: key,
        }),
      );
  });

  // ---------- Bundle editor ----------

  app.get('/admin/devices/:uuid/bundle', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    const uuid = (request.params as { uuid: string }).uuid;
    const loaded = await loadDevice(uuid);
    if (!loaded) return reply.status(404).type('text/html').send(notFoundPage());
    const existing = loaded.blob
      ? loaded.blob.files.map((f) => ({ path: f.path, bytes: f.bytes }))
      : [];
    return securityHeaders(reply)
      .type('text/html')
      .send(
        html.bundleEditorPage({
          device: loaded.device,
          existing,
          version: loaded.blob?.version ?? null,
          csrfToken: session.csrfToken,
        }),
      );
  });

  app.post('/admin/devices/:uuid/bundle', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const uuid = (request.params as { uuid: string }).uuid;
    const loaded = await loadDevice(uuid);
    if (!loaded) return reply.status(404).type('text/html').send(notFoundPage());
    const body = (request.body ?? new Map<string, string>()) as Map<string, string>;

    const existingCount = Number(body.get('existing_count') ?? '0');
    const newCount = Number(body.get('new_count') ?? '0');
    const existingPaths: string[] = [];
    const existingContents: string[] = [];
    for (let i = 0; i < existingCount; i++) {
      existingPaths.push(body.get(`existing_path_${i}`) ?? '');
      existingContents.push(body.get(`existing_content_${i}`) ?? '');
    }
    const newPaths: string[] = [];
    const newContents: string[] = [];
    for (let i = 0; i < newCount; i++) {
      newPaths.push(body.get(`new_path_${i}`) ?? '');
      newContents.push(body.get(`new_content_${i}`) ?? '');
    }
    const input = parseConsoleFiles({
      existing_paths: existingPaths,
      existing_contents: existingContents,
      new_paths: newPaths,
      new_contents: newContents,
    });

    try {
      await rotateBundle(db, clock, uuid, input, { sourceIp: request.ip, reason: 'bundle_rotated_console' });
      return reply.redirect(`/admin/devices/${uuid}`, 303);
    } catch (err) {
      const message =
        err instanceof EmptyBundleError || err instanceof InvalidBundleError ? err.message : 'Save failed.';
      const existing = loaded.blob
        ? loaded.blob.files.map((f) => ({ path: f.path, bytes: f.bytes }))
        : [];
      return securityHeaders(reply)
        .status(400)
        .type('text/html')
        .send(
          html.bundleEditorPage({
            device: loaded.device,
            existing,
            version: loaded.blob?.version ?? null,
            csrfToken: session.csrfToken,
            error: message,
          }),
        );
    }
  });
}

