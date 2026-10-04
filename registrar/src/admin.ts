import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { devices, identityBlobs, deliveryLog, deliverySlots, adminKeys } from './db/schema.js';
import { keyFingerprint, hashKey } from './db/key-crypto.js';
import { audit } from './audit.js';
import { AuthRateLimiter } from './rate-limit.js';
import { SessionManager, SESSION_COOKIE, CSRF_COOKIE, type AdminSession } from './session.js';
import { verifyAdminKey } from './admin-auth.js';
import { mintDeviceKey } from './keys.js';
import { rotateBundle, rearmSlot, parseConsoleFiles, EmptyBundleError, InvalidBundleError } from './rotate.js';
import {
  FIELD_NAMES,
  SECRET_FIELDS,
  InvalidExtraEnvError,
  renderCanonicalFiles,
  buildFormPreFill,
  type StructuredFields,
} from './structured-fields.js';
import { readSlot } from './slots.js';
import { mintAdminKey } from './keys.js';
import {
  mintMemoryKeys,
  MintConfigError,
  MintCallError,
  MEMORY_KEY_ENV_VARS,
  memoryKeyAlias,
} from './gateway-mint.js';
import { BALENA_UUID_SHORT_RE, BALENA_UUID_CANONICAL_RE, normalizeBalenaUuid } from '@vector-sigma/shared';
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

/**
 * Console UUID gate (fleet-ops-f57.10): balena device UUIDs arrive in
 * either the balena-native SHORT form (32 hex chars, no hyphens — what
 * balenaOS injects as BALENA_DEVICE_UUID and the balenaCloud dashboard
 * shows) or the canonical hyphenated form. Both are accepted; the value
 * is normalized to canonical lowercase via normalizeBalenaUuid before
 * the duplicate check and insert, so the PK comparison matches what
 * the API side stores.
 */
const UUID_RE = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deviceView(d: DbRow): html.DeviceRowView {
  return {
    balenaUuid: d.balenaUuid,
    agentName: d.agentName,
    status: d.status,
    createdAt: d.createdAt,
    notes: d.notes,
  };
}

/**
 * Harvest the structured-editor fields from a parsed form body (f57.11).
 * Absent fields stay undefined; blank trimmed values stay blank (the
 * renderer treats them as no-ops). Secrets are NEVER echoed back — the
 * form posts them once and this is the only place they are read.
 */
function readStructuredFields(body: Map<string, string>): StructuredFields {
  const out: StructuredFields = {};
  for (const name of FIELD_NAMES) {
    const raw = body.get(`structured_${name}`);
    if (raw !== undefined) out[name] = raw;
  }
  return out;
}

/**
 * Non-secret fields of a submitted form, for re-rendering the editor after
 * a bounced save (f57.11). Secret fields are dropped — a failed save must
 * never echo what was typed into a write-only field.
 */
function sanitizeSubmittedPreFill(submitted: StructuredFields): StructuredFields {
  const out: StructuredFields = {};
  for (const name of FIELD_NAMES) {
    if (SECRET_FIELDS.has(name)) continue;
    const raw = submitted[name];
    if (raw !== undefined) out[name] = raw;
  }
  return out;
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
  // Persona pre-fill picker (fleet-ops-zbq.2): advisory only. The select
  // has no name attribute and never submits; picking a persona loads its
  // library defaults into the four non-secret identity fields and fires
  // real 'input' events so the diff preview island below reflects the
  // fill without duplicating any logic. Secret fields are never touched;
  // the server-side save path is unchanged (structured fields ->
  // canonical files -> rotate, one code path).
  const personaData = document.getElementById('persona-library-data');
  const personaSelect = document.getElementById('persona-select');
  if (personaData && personaSelect) {
    let personas = [];
    try { personas = JSON.parse(personaData.textContent || '[]'); } catch (e) { personas = []; }
    const byName = (n) => document.getElementsByName(n)[0];
    const fill = (name, value) => {
      const el = byName(name);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: false }));
    };
    personaSelect.addEventListener('change', () => {
      const slug = personaSelect.value;
      if (!slug) return; // "— pick —" placeholder: no-op, never clears operator edits
      const persona = personas.find((p) => p && p.slug === slug);
      if (!persona) return;
      fill('structured_agent_name', persona.slug || '');
      fill('structured_model_route', persona.model_route || '');
      const extra = persona.extra_env && typeof persona.extra_env === 'object'
        ? Object.keys(persona.extra_env).map((k) => k + '=' + persona.extra_env[k]).join('\\n')
        : '';
      fill('structured_extra_env', extra);
      fill('structured_soul_contents', persona.soul_contents || '');
    });
  }
  const preview = document.getElementById('diff-preview');
  if (!preview) return;
  const out = document.getElementById('diff-out');
  const areas = document.querySelectorAll('textarea[data-path], input[data-path]');
  const show = () => {
    // Group by canonical path (f57.11): several structured fields share one
    // target file (four render into config/agent.env). The preview shows
    // the FINAL file set — one block per path, inputs concatenated in DOM
    // order (the same order the server renders them).
    const byPath = new Map();
    for (const area of areas) {
      if (area.value === '') continue;
      const p = area.dataset.path;
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(area.value);
    }
    const lines = [];
    for (const [p, parts] of byPath) {
      lines.push('--- ' + p);
      lines.push('+++ ' + p + ' (new)');
      for (const part of parts) {
        for (const line of part.split('\\n')) lines.push('+' + line);
      }
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

  // ---------- First-run admin-key bootstrap (fleet-ops-w5d) ----------
  //
  // /admin/setup exists ONLY while the admin_keys table is empty. It lets
  // the owner mint the first admin key from the browser (zero shell access
  // — the old flow needed a container terminal + a manual psql INSERT,
  // owner pain point 2026-09-29: "manual db inserts are dumb"). Once ANY
  // admin key exists the route 404s: there is no second bootstrap, no
  // unauthenticated mint after the first key, and the mint itself is
  // CSRF-protected (double-submit cookie, same shape as login), rate-
  // limited, and audited. The plaintext key is shown EXACTLY ONCE on the
  // confirmation page (never stored, never logged, never re-displayable —
  // same posture as the device-key mint flow f57.10).

  async function adminKeyCount(): Promise<number> {
    const rows = await db.select({ id: adminKeys.id }).from(adminKeys);
    return rows.length;
  }

  app.get('/admin/setup', async (request, reply) => {
    if ((await adminKeyCount()) > 0) {
      // 404-after-first-key: the route must not even reveal that a
      // bootstrap phase existed.
      return reply.status(404).type('text/html').send(notFoundPage());
    }
    const token = randomBytes(32).toString('base64url');
    reply.header('set-cookie', `${CSRF_COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict`);
    return securityHeaders(reply).type('text/html').send(html.setupPage(token));
  });

  app.post('/admin/setup', async (request, reply) => {
    // Order matters: the 404-after-first-key check runs BEFORE anything
    // else on the POST too — a stale setup form must never mint.
    if ((await adminKeyCount()) > 0) {
      return reply.status(404).type('text/html').send(notFoundPage());
    }
    const ip = request.ip;
    const locked = limiter.lockedRetryAfter(ip);
    if (locked !== null) {
      await audit(db, {
        deviceId: null,
        outcome: 'admin',
        reason: 'admin_setup_locked',
        keyId: null,
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply
        .status(429)
        .header('Retry-After', String(locked))
        .type('text/html')
        .send(html.setupPage('', 'Too many failed attempts. Try again later.', 'locked'));
    }
    const body = (request.body ?? new Map<string, string>()) as Map<string, string>;
    const cookieToken = cookieMap(request).get(CSRF_COOKIE);
    const presentedCsrf = body.get('_csrf');
    if (!tokensEqual(cookieToken, presentedCsrf)) {
      // Rate-limited for real: failed attempts on the bootstrap route are
      // the probe surface (there is no key to guess) — each one counts
      // toward the same lockout window the login limiter enforces.
      limiter.recordFailure(ip);
      return reply.status(403).type('text/html').send(html.setupPage('', 'Invalid request (CSRF).'));
    }
    const label = (body.get('label') ?? '').trim();
    if (label === '') {
      limiter.recordFailure(ip);
      return reply.status(400).type('text/html').send(html.setupPage(cookieToken ?? '', 'A label is required.'));
    }
    // Re-check emptiness inside the same window: two parallel POSTs must
    // not both mint. The select-then-insert race window is closed by the
    // unique id sequence — a duplicate first-key is still filtered by the
    // count check each request runs; the audit row records what actually
    // landed.
    if ((await adminKeyCount()) > 0) {
      return reply.status(404).type('text/html').send(notFoundPage());
    }
    const key = mintAdminKey();
    const rows = await db
      .insert(adminKeys)
      .values({ hash: await hashKey(key), label })
      .returning({ id: adminKeys.id });
    const keyId = Number(rows[0].id);
    await audit(db, {
      deviceId: null,
      outcome: 'admin',
      reason: 'first_admin_key_minted',
      keyId: null,
      sourceIp: ip,
      occurredAt: clock.now(),
    });
    // Mint a session too: the owner lands logged-in, exactly one key show,
    // no second round-trip through the login form with a fresh secret.
    sessions.create(reply, label);
    return securityHeaders(reply)
      .type('text/html')
      .send(html.setupResultPage(label, key, keyId));
  });

  // ---------- Session-gated admin-key management (fleet-ops-w5d) ----------
  //
  // Mint additional keys + revoke old ones from the console — the
  // rotation path that previously required mint+INSERT+DELETE by hand.
  // Same show-once semantics as the device-key mint: the plaintext is
  // rendered on the confirmation page only.

  app.get('/admin/admin-keys', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    const rows = await db.select().from(adminKeys).orderBy(desc(adminKeys.id));
    const view = rows.map((r) => ({
      id: Number(r.id),
      label: r.label,
      // No created_at column on admin_keys (schema pin) — the id orders
      // the list; the label is the operator-facing name.
    }));
    return securityHeaders(reply)
      .type('text/html')
      .send(html.adminKeysPage(view, session.csrfToken));
  });

  app.post('/admin/admin-keys', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const body = (request.body ?? new Map<string, string>()) as Map<string, string>;
    const label = (body.get('label') ?? '').trim();
    if (label === '') {
      const rows = await db.select().from(adminKeys).orderBy(desc(adminKeys.id));
      const view = rows.map((r) => ({ id: Number(r.id), label: r.label }));
      return reply
        .status(400)
        .type('text/html')
        .send(html.adminKeysPage(view, session.csrfToken, 'A label is required.'));
    }
    const key = mintAdminKey();
    const rows = await db
      .insert(adminKeys)
      .values({ hash: await hashKey(key), label })
      .returning({ id: adminKeys.id });
    const keyId = Number(rows[0].id);
    await audit(db, {
      deviceId: null,
      outcome: 'admin',
      reason: 'admin_key_minted',
      keyId: null,
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    return securityHeaders(reply)
      .type('text/html')
      .send(html.adminKeyMintedPage(label, key, keyId, session.csrfToken));
  });

  app.post('/admin/admin-keys/:id/revoke', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(404).type('text/html').send(notFoundPage());
    }
    const revoked = await db
      .delete(adminKeys)
      .where(eq(adminKeys.id, id))
      .returning({ id: adminKeys.id });
    if (revoked.length === 0) return reply.status(404).type('text/html').send(notFoundPage());
    await audit(db, {
      deviceId: null,
      outcome: 'admin',
      reason: 'admin_key_revoked',
      keyId: null,
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    return reply.redirect('/admin/admin-keys', 303);
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
    const canonicalUuid = normalizeBalenaUuid(balenaUuid);
    if ((await db.select().from(devices).where(eq(devices.balenaUuid, canonicalUuid))).length > 0) {
      return errorPage('A device with this UUID already exists.');
    }
    if ((await db.select().from(devices).where(eq(devices.agentName, agentName))).length > 0) {
      return errorPage('Agent name already in use.');
    }

    const key = mintDeviceKey();
    await db.insert(devices).values({
      balenaUuid: canonicalUuid,
      agentName,
      registrarKeyHash: await hashKey(key),
      status: 'pending',
      notes,
    });
    await audit(db, {
      deviceId: canonicalUuid,
      outcome: 'admin',
      reason: 'device_created',
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });
    return securityHeaders(reply)
      .type('text/html')
      .send(html.newDeviceResultPage(agentName, canonicalUuid, key, session.csrfToken));
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

  // fleet-ops-e5o.3: the memory-key mint action. One click per device:
  // mints the two route-restricted gateway memory keys (shared
  // team-scoped + private) with the SCOPED key-creator key — never the
  // master key — then merges BOTH into the device bundle's extra_env
  // (config/agent.env) via the same rotate path the structured editor
  // uses, so delivery rides the existing bundle plane. Key values are
  // shown ONCE (the keyOnce posture) and never stored in the registrar
  // DB — the bundle blob carries them onward to the device, 0600.
  app.post('/admin/devices/:uuid/mint-memory-keys', async (request, reply) => {
    const session = await requireSession(request);
    if (!session) return redirectToLogin(reply);
    if (!(await csrfGate(request, session))) return reply.status(403).type('text/html').send(csrfErrorPage());
    const uuid = (request.params as { uuid: string }).uuid;
    const loaded = await loadDevice(uuid);
    if (!loaded) return reply.status(404).type('text/html').send(notFoundPage());

    let minted: Awaited<ReturnType<typeof mintMemoryKeys>>;
    try {
      minted = await mintMemoryKeys(process.env, loaded.device.agentName);
    } catch (err) {
      // Config gap -> the pre-authorized fallback (manual owner mint),
      // never a silent master-key path. Gateway call failure -> surface
      // status + body for triage. Both render on the device page.
      const message =
        err instanceof MintConfigError
          ? err.message
          : err instanceof MintCallError
            ? `${err.message} (HTTP ${err.status ?? '—'}: ${(err.body ?? '').slice(0, 300)})`
            : 'Memory key mint failed unexpectedly.';
      return securityHeaders(reply)
        .type('text/html')
        .send(
          html.deviceDetailPage({
            ...loaded,
            csrfToken: session.csrfToken,
            messages: [{ kind: 'danger', text: message }],
          }),
        );
    }

    // Merge both keys into config/agent.env as extra_env lines — the
    // same canonical the structured editor's extra_env field renders,
    // so the wiring hook's env_from_file delivers them on next boot.
    // mergeEnvFile semantics come free via renderCanonicalFiles? No —
    // this is a DIRECT bundle merge: read current agent.env, upsert the
    // two KEY= lines, hand the whole file to rotateBundle as an update.
    const current = await loadCurrentFileContents(uuid);
    const agentEnv = current.get('config/agent.env') ?? '';
    const lines = agentEnv.split(/\r?\n/).filter((l) => l.trim() !== '');
    const wanted: Array<[string, string]> = [
      [MEMORY_KEY_ENV_VARS.shared, minted.shared.key],
      [MEMORY_KEY_ENV_VARS.private, minted.private.key],
    ];
    for (const [k, v] of wanted) {
      const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
      if (idx === -1) lines.push(`${k}=${v}`);
      else lines[idx] = `${k}=${v}`;
    }
    // FLEET_MEMORY_BASE_URL: only seed when the bundle doesn't already
    // carry one (an operator-set gateway URL wins, not clobbered).
    if (!lines.some((l) => l.startsWith('FLEET_MEMORY_BASE_URL='))) {
      const gwUrl = (process.env['GATEWAY_KEY_MINT_BASE_URL'] ?? '').replace(/\/+$/, '');
      if (gwUrl !== '') lines.push(`FLEET_MEMORY_BASE_URL=${gwUrl}`);
    }
    const nextAgentEnv = lines.join('\n') + (lines.length > 0 ? '\n' : '');

    // Keep EVERY existing bundle file except the one updated — an empty
    // keep set would drop the rest of the identity bundle (buildNextBundle
    // keeps only keep + updates; SOUL.md, a2a.json, secrets.env ride on
    // this set surviving).
    const keep = new Set<string>(
      (loaded.blob?.files ?? []).map((f) => f.path).filter((p) => p !== 'config/agent.env'),
    );
    await rotateBundle(db, clock, uuid, {
      kind: 'merge',
      keep,
      updates: new Map([['config/agent.env', nextAgentEnv]]),
      additions: [],
    }, { sourceIp: request.ip, reason: 'memory_keys_minted_console' });
    await audit(db, {
      deviceId: uuid,
      outcome: 'admin',
      reason: 'memory_keys_minted',
      sourceIp: request.ip,
      occurredAt: clock.now(),
    });

    const reloaded = await loadDevice(uuid);
    if (!reloaded) return reply.status(404).type('text/html').send(notFoundPage());
    return securityHeaders(reply)
      .type('text/html')
      .send(
        html.deviceDetailPage({
          ...reloaded,
          csrfToken: session.csrfToken,
          messages: [
            {
              kind: 'ok',
              text: `Memory keys minted (${memoryKeyAlias(loaded.device.agentName, 'shared')} + private) and merged into the bundle — delivered on the next device sync.`,
            },
          ],
          keyOnce: `GATEWAY_MEMORY_SHARED_KEY=${minted.shared.key}\nGATEWAY_MEMORY_PRIVATE_KEY=${minted.private.key}`,
        }),
      );
  });

  /**
   * Current bundle file contents by path (f57.11). Server-side only —
   * used for structured-field merge and non-secret pre-fill; contents
   * never render into any page.
   */
  async function loadCurrentFileContents(uuid: string): Promise<Map<string, string>> {
    const blobRows = await db
      .select({ bundle: identityBlobs.bundle })
      .from(identityBlobs)
      .where(eq(identityBlobs.deviceId, uuid));
    const bundleShape = blobRows[0]?.bundle as BlobBundleShape | undefined;
    const out = new Map<string, string>();
    for (const f of bundleShape?.files ?? []) out.set(f.path, f.content);
    return out;
  }

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
    // Non-secret pre-fill (f57.11): derive from the current bundle contents
    // server-side; secrets never render into the page.
    const currentFileContents = await loadCurrentFileContents(uuid);
    return securityHeaders(reply)
      .type('text/html')
      .send(
        html.bundleEditorPage({
          device: loaded.device,
          existing,
          version: loaded.blob?.version ?? null,
          csrfToken: session.csrfToken,
          preFill: buildFormPreFill(currentFileContents, loaded.device.agentName),
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

    // Harvested before the try: the bounced-save re-render needs the
    // operator's non-secret edits even when the render itself threw.
    const structured = readStructuredFields(body);

    try {
      // Structured fields (fleet-ops-f57.11): render to canonical files via
      // fixed templates, then merge into the SAME rotate input the raw file
      // rows feed — one code path, no drift. The renderer merges against
      // the CURRENT bundle contents (re-queried here, server-side only)
      // so blank fields keep existing values at FIELD level — several
      // fields share config/agent.env, and a save of one must not drop
      // the delivered lines of another. Existing content never reaches
      // the browser; only the merged result is stored. Inside the try so
      // extra_env validation errors bounce to the editor as 400s.
      const currentFileContents = await loadCurrentFileContents(uuid);
      const structuredFiles = renderCanonicalFiles(structured, currentFileContents);
      // A raw upload with the SAME canonical name REPLACES the rendered
      // section (uploaded file wins — owner ruling f57.11): drop any
      // rendered canonical whose path also carries actual raw CONTENT in
      // this submission. A blank existing-file row is "keep existing",
      // not an upload, and must NOT suppress the structured render.
      const rawTargets = new Set<string>();
      for (let i = 0; i < existingPaths.length; i++) {
        if (existingPaths[i].trim() !== '' && (existingContents[i] ?? '').trim() !== '') {
          rawTargets.add(existingPaths[i].trim());
        }
      }
      for (let i = 0; i < newPaths.length; i++) {
        if (newPaths[i].trim() !== '' && (newContents[i] ?? '').trim() !== '') {
          rawTargets.add(newPaths[i].trim());
        }
      }
      const effectiveStructured = structuredFiles.filter((f) => !rawTargets.has(f.path));

      const input = parseConsoleFiles({
        existing_paths: existingPaths,
        existing_contents: existingContents,
        new_paths: newPaths,
        new_contents: newContents,
        // Rendered canonicals join as updates: same-path merge semantics as
        // an existing-file content update.
        structured_updates: effectiveStructured,
      });

      await rotateBundle(db, clock, uuid, input, { sourceIp: request.ip, reason: 'bundle_rotated_console' });
      return reply.redirect(`/admin/devices/${uuid}`, 303);
    } catch (err) {
      // f57.11: extra_env validation errors carry operator-actionable
      // messages; keep them alongside the bundle-shape errors.
      const known = [EmptyBundleError, InvalidBundleError, InvalidExtraEnvError];
      const message = known.some((c) => err instanceof c) ? (err as Error).message : 'Save failed.';
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
            // Re-render keeps the operator's non-secret edits visible on a
            // bounced save; secrets never echo back.
            preFill: sanitizeSubmittedPreFill(structured),
          }),
        );
    }
  });
}

