import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  BootstrapRequestSchema,
  StatusRequestSchema,
  type DeviceStatus,
  type SlotState,
} from '@vector-sigma/shared';
import { identityBlobs } from './db/schema.js';
import { devices } from './db/schema.js';
import { meshEnrollKeys } from './db/schema.js';
import { extractBearer } from './auth.js';
import { verifyKey, keyFingerprint, hashKey } from './db/key-crypto.js';
import { mintMeshEnrollKey, isMeshEnrollKey, MESH_ENROLL_KEY_PREFIX } from './keys.js';
import { AuthRateLimiter } from './rate-limit.js';
import { systemClock, type Clock } from './clock.js';
import { consumeSlot, ensureSlot, readSlot, retryAfterSeconds, effectiveState } from './slots.js';
import { audit } from './audit.js';
import type { RegistrarConfig } from './config.js';
import { registerAdminRoutes, cookieMap } from './admin.js';
import { verifyAdminKey } from './admin-auth.js';
import { rotateBundle, rearmSlot } from './rotate.js';
import { RearmRequestSchema, RotateRequestSchema, MeshEnrollRequestSchema, A2aKeyReportSchema } from '@vector-sigma/shared';
import { registerDeviceKey, reportGuardStatus, resolveKeyPolicy, resyncMeshKeys, A2aKeyError } from './a2a-keys.js';
import { enrollAgent, createCreatorKeyEnv, MeshEnrollError, MeshMintRateLimiter } from './mesh-enroll.js';
import { SessionManager, SESSION_COOKIE } from './session.js';

export interface BuildOptions {
  db: NodePgDatabase;
  config: RegistrarConfig;
  clock?: Clock;
  limiter?: AuthRateLimiter;
}

/** One argon2id hash of throwaway entropy, to equalize timing on unknown UUIDs. */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashKey(`dummy-${randomUUID()}`);
  return dummyHashPromise;
}

interface DeviceRow {
  balenaUuid: string;
  registrarKeyHash: string;
  status: string;
}

type AuthResult =
  | { ok: true; row: DeviceRow }
  | {
      ok: false;
      status: 401 | 403;
      reason: string;
      /** true when the failure counts toward per-IP lockout. */
      keyFailure: boolean;
      /** FK-safe audit device_id: set only when the row provably exists. */
      auditDeviceId: string | null;
    };

/**
 * Two-factor device authentication: the Bearer key AND the claimed UUID
 * must both match the device row. Response bodies stay generic across
 * 401 reasons (no device-enumeration oracle); the distinction lives
 * only in the audit log.
 */
async function authenticate(
  db: NodePgDatabase,
  balenaUuid: string,
  presentedKey: string,
): Promise<AuthResult> {
  const rows = await db.select().from(devices).where(eq(devices.balenaUuid, balenaUuid));
  const row = rows[0] as DeviceRow | undefined;
  if (!row) {
    // Equalize timing with the known-UUID path, then deny.
    await verifyKey(await getDummyHash(), presentedKey).catch(() => false);
    return { ok: false, status: 401, reason: 'unknown_uuid', keyFailure: true, auditDeviceId: null };
  }
  const keyOk = await verifyKey(row.registrarKeyHash, presentedKey).catch(() => false);
  if (!keyOk) {
    return { ok: false, status: 401, reason: 'bad_key', keyFailure: true, auditDeviceId: balenaUuid };
  }
  if (row.status !== 'active') {
    return {
      ok: false,
      status: 403,
      reason: 'device_not_active',
      keyFailure: false,
      auditDeviceId: balenaUuid,
    };
  }
  return { ok: true, row };
}

function clientIp(request: FastifyRequest): string {
  return request.ip;
}

export function buildApp(opts: BuildOptions): FastifyInstance {
  const { db, config } = opts;
  const clock = opts.clock ?? systemClock;
  const limiter =
    opts.limiter ?? new AuthRateLimiter(clock, config.rateLimitWindowMs, config.rateLimitMaxFailures);

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'res.headers.authorization'],
        censor: '[REDACTED]',
      },
    },
  });

  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'unhandled error');
    reply.status(500).send({ error: 'internal_error' });
  });

  // Exactly ONE SessionManager for the whole app (fleet-ops-f57.9): the
  // /admin/* routes and the front door below must resolve sessions against
  // the same in-memory store — the store is per-instance, and a second
  // manager would silently disagree about who is logged in.
  const sessions = new SessionManager(config.sessionSecret, clock);

  /**
   * The creator key for every mint path (j7g.1 design call): env first, else
   * the registrar-side bootstrap from the composition master key, minted once
   * per process and shared by the machine-auth enroll and the console's
   * enroll / memory / model actions. A restart re-mints (self-heal). The
   * value never leaves this process's memory.
   */
  const creatorKeyEnv = createCreatorKeyEnv(db);

  // Admin console + owner endpoints share this limiter for admin-key auth.
  registerAdminRoutes(app, {
    db,
    config,
    clock,
    limiter,
    sessions,
    creatorKeyEnv,
  });

  /** Per-device mint rate limiter for the mesh-enroll action (j7g.1). */
  const mintLimiter = new MeshMintRateLimiter(clock);

  /**
   * Front door (fleet-ops-f57.9): GET / must never 404. A live admin
   * session goes straight to the device list; everyone else lands on the
   * login page. Same session resolution the /admin pages use — note the
   * session cookie is scoped Path=/admin, so real browsers take the
   * /admin/login hop (which re-redirects sessioned users to
   * /admin/devices); cookie-jar clients resolve directly here.
   */
  app.get('/', async (request, reply) => {
    const session = sessions.resolve(cookieMap(request).get(SESSION_COOKIE));
    return reply.redirect(session ? '/admin/devices' : '/admin/login', 302);
  });

  // Plain JSON 404 for everything else (fleet-ops-f57.9): the default
  // Fastify envelope ('Route GET:/ not found') reads as a broken service;
  // keep the API-wide { error } shape instead.
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: 'not_found' });
  });

  /** Rate-limit gate: returns seconds remaining, or null when the IP is free. */
  const rateGate = (request: FastifyRequest): number | null =>
    limiter.lockedRetryAfter(clientIp(request));

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/v1/bootstrap', async (request, reply) => {
    const ip = clientIp(request);
    const keyId = keyFingerprint(extractBearer(request));
    const now = () => clock.now();

    const locked = rateGate(request);
    if (locked !== null) {
      await audit(db, {
        deviceId: null,
        outcome: 'denied',
        reason: 'rate_limited',
        keyId,
        sourceIp: ip,
        occurredAt: now(),
      });
      return reply
        .status(429)
        .header('Retry-After', String(locked))
        .send({ error: 'rate_limited', retry_after_seconds: locked });
    }

    const parsed = BootstrapRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await audit(db, {
        deviceId: null,
        outcome: 'denied',
        reason: 'invalid_body',
        keyId,
        sourceIp: ip,
        occurredAt: now(),
      });
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const balenaUuid = parsed.data.balena_uuid;

    const presentedKey = extractBearer(request);
    if (presentedKey === null) {
      limiter.recordFailure(ip);
      await audit(db, {
        deviceId: null,
        outcome: 'denied',
        reason: 'missing_key',
        keyId: null,
        sourceIp: ip,
        occurredAt: now(),
      });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const auth = await authenticate(db, balenaUuid, presentedKey);
    if (!auth.ok) {
      if (auth.keyFailure) limiter.recordFailure(ip);
      await audit(db, {
        deviceId: auth.auditDeviceId,
        outcome: 'denied',
        reason: auth.reason,
        keyId,
        sourceIp: ip,
        occurredAt: now(),
      });
      if (auth.status === 403) return reply.status(403).send({ error: 'forbidden' });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const t = now();
    await ensureSlot(db, balenaUuid);

    const result = await db.transaction(async (tx) => {
      const consumed = await consumeSlot(tx, balenaUuid, t);
      if (!consumed) {
        const snap = await readSlot(tx, balenaUuid);
        const retry = snap ? retryAfterSeconds(snap, t) ?? 1 : 1;
        return { kind: 'early' as const, retry };
      }
      const blobs = await tx.select().from(identityBlobs).where(eq(identityBlobs.deviceId, balenaUuid));
      if (blobs.length === 0) return { kind: 'no_bundle' as const };
      // Audit inside the transaction: delivered and audited atomically.
      await audit(tx, {
        deviceId: balenaUuid,
        outcome: 'delivered',
        keyId,
        sourceIp: ip,
        occurredAt: t,
      });
      return {
        kind: 'ok' as const,
        deliveredAt: consumed.deliveredAt,
        bundle: blobs[0].bundle,
        bundleVersion: blobs[0].version,
      };
    });

    if (result.kind === 'early') {
      await audit(db, {
        deviceId: balenaUuid,
        outcome: 'denied',
        reason: 'slot_consumed',
        keyId,
        sourceIp: ip,
        occurredAt: now(),
      });
      return reply
        .status(425)
        .header('Retry-After', String(result.retry))
        .send({ error: 'too_early', retry_after_seconds: result.retry });
    }
    if (result.kind === 'no_bundle') {
      await audit(db, {
        deviceId: balenaUuid,
        outcome: 'denied',
        reason: 'no_bundle',
        keyId,
        sourceIp: ip,
        occurredAt: now(),
      });
      return reply.status(500).send({ error: 'internal_error' });
    }

    return reply.status(200).send({
      bundle: result.bundle,
      bundle_version: result.bundleVersion,
      delivered_at: result.deliveredAt.toISOString(),
    });
  });

  /**
   * Signed A2A identity: the registrant reports the agent's PUBLIC key (+ guard readiness).
   * Same device auth as bootstrap (Bearer REGISTRAR_KEY + balena_uuid), but it consumes no
   * delivery slot. The first key binds with the device credential's trust; a different key is a
   * conflict alarm, never a replacement (docs/a2a-signed-identity.md, Trust anchor).
   */
  app.post('/v1/a2a-key', async (request, reply) => {
    const ip = clientIp(request);
    const keyId = keyFingerprint(extractBearer(request));
    const now = () => clock.now();
    const locked = rateGate(request);
    if (locked !== null) {
      await audit(db, { deviceId: null, outcome: 'denied', reason: 'rate_limited', keyId, sourceIp: ip, occurredAt: now() });
      return reply.status(429).header('Retry-After', String(locked)).send({ error: 'rate_limited', retry_after_seconds: locked });
    }
    const parsed = A2aKeyReportSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await audit(db, { deviceId: null, outcome: 'denied', reason: 'invalid_body', keyId, sourceIp: ip, occurredAt: now() });
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const presentedKey = extractBearer(request);
    if (presentedKey === null) {
      limiter.recordFailure(ip);
      await audit(db, { deviceId: null, outcome: 'denied', reason: 'missing_key', keyId: null, sourceIp: ip, occurredAt: now() });
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const auth = await authenticate(db, parsed.data.balena_uuid, presentedKey);
    if (!auth.ok) {
      if (auth.keyFailure) limiter.recordFailure(ip);
      await audit(db, { deviceId: auth.auditDeviceId, outcome: 'denied', reason: auth.reason, keyId, sourceIp: ip, occurredAt: now() });
      if (auth.status === 403) return reply.status(403).send({ error: 'forbidden' });
      return reply.status(401).send({ error: 'unauthorized' });
    }
    try {
      const result = await registerDeviceKey(db, clock, parsed.data.balena_uuid, parsed.data.ed25519,
        resolveKeyPolicy(process.env), { keyId, sourceIp: ip });
      if (parsed.data.guard_status !== undefined || parsed.data.bundle_version !== undefined) {
        await reportGuardStatus(db, clock, parsed.data.balena_uuid,
          (parsed.data.guard_status ?? null) as Record<string, unknown> | null, parsed.data.bundle_version ?? null);
      }
      return reply.status(200).send({ status: result.status, fingerprint: result.fingerprint });
    } catch (err) {
      if (err instanceof A2aKeyError) return reply.status(err.status).send({ error: err.code });
      request.log.error({ err }, 'a2a key report failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  app.get('/v1/status', async (request, reply) => {
    const ip = clientIp(request);
    const keyId = keyFingerprint(extractBearer(request));

    const locked = rateGate(request);
    if (locked !== null) {
      await audit(db, {
        deviceId: null,
        outcome: 'denied',
        reason: 'rate_limited',
        keyId,
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply
        .status(429)
        .header('Retry-After', String(locked))
        .send({ error: 'rate_limited', retry_after_seconds: locked });
    }

    // Body preferred; querystring tolerated for HTTP clients that refuse GET bodies.
    const parsed = StatusRequestSchema.safeParse(request.body ?? request.query ?? {});
    if (!parsed.success) {
      await audit(db, {
        deviceId: null,
        outcome: 'denied',
        reason: 'invalid_body',
        keyId,
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const balenaUuid = parsed.data.balena_uuid;

    const presentedKey = extractBearer(request);
    if (presentedKey === null) {
      limiter.recordFailure(ip);
      await audit(db, {
        deviceId: null,
        outcome: 'denied',
        reason: 'missing_key',
        keyId: null,
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const auth = await authenticateForStatus(db, balenaUuid, presentedKey);
    if (!auth.ok) {
      if (auth.keyFailure) limiter.recordFailure(ip);
      await audit(db, {
        deviceId: auth.auditDeviceId,
        outcome: 'denied',
        reason: auth.reason,
        keyId,
        sourceIp: ip,
        occurredAt: clock.now(),
      });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const t = clock.now();
    const snap = await readSlot(db, balenaUuid);
    const blobs = await db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, balenaUuid));

    const state: SlotState = snap ? effectiveState(snap, t) : 'armed';
    return reply.status(200).send({
      balena_uuid: balenaUuid,
      device_status: auth.row.status as DeviceStatus,
      slot: {
        state,
        delivery_count: snap?.deliveryCount ?? 0,
        delivered_at: snap?.deliveredAt ? snap.deliveredAt.toISOString() : null,
      },
      bundle_version: blobs.length > 0 ? blobs[0].version : null,
    });
  });

  /** Admin-key auth for owner endpoints; audits and never leaks which factor failed. */
  async function adminGate(
    request: FastifyRequest,
  ): Promise<{ ok: true; keyId: string | null } | { ok: false; status: 401 | 429; reason: string; locked: number | null }> {
    const presentedKey = extractBearer(request);
    const auth = await verifyAdminKey(db, presentedKey, limiter, clientIp(request));
    if (auth.ok) {
      return { ok: true, keyId: keyFingerprint(presentedKey) };
    }
    if (auth.kind === 'locked') {
      await audit(db, {
        deviceId: null,
        outcome: 'admin',
        reason: 'rate_limited',
        keyId: keyFingerprint(presentedKey),
        sourceIp: clientIp(request),
        occurredAt: clock.now(),
      });
      return { ok: false, status: 429, reason: 'rate_limited', locked: auth.locked ?? 1 };
    }
    await audit(db, {
      deviceId: null,
      outcome: 'admin',
      reason: auth.kind === 'device_key' ? 'device_key_rejected' : 'admin_auth_failed',
      keyId: keyFingerprint(presentedKey),
      sourceIp: clientIp(request),
      occurredAt: clock.now(),
    });
    return { ok: false, status: 401, reason: 'unauthorized', locked: null };
  }

  app.post('/v1/re-arm', async (request, reply) => {
    const gate = await adminGate(request);
    if (!gate.ok) {
      if (gate.status === 429) {
        return reply
          .status(429)
          .header('Retry-After', String(gate.locked))
          .send({ error: 'rate_limited', retry_after_seconds: gate.locked });
      }
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const parsed = RearmRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const { balena_uuid: uuid } = parsed.data;

    const devRows = await db.select().from(devices).where(eq(devices.balenaUuid, uuid));
    if (devRows.length === 0) return reply.status(404).send({ error: 'not_found' });

    await rearmSlot(db, uuid);
    const snap = await readSlot(db, uuid);
    await audit(db, {
      deviceId: uuid,
      outcome: 'admin',
      reason: 'slot_rearmed',
      keyId: gate.keyId,
      sourceIp: clientIp(request),
      occurredAt: clock.now(),
    });
    return reply.status(200).send({
      balena_uuid: uuid,
      slot: {
        state: snap?.state ?? 'armed',
        delivery_count: snap?.deliveryCount ?? 0,
        delivered_at: snap?.deliveredAt ? snap.deliveredAt.toISOString() : null,
      },
    });
  });

  /**
 * Machine-auth for the mesh-enroll action (fleet-ops-j7g.1): a
 * PRIMUS-SCOPED key class, distinct from device keys (bk_) and admin
 * keys (ak_) at the prefix, so a device or admin key can never
 * authenticate the enroll surface (structural separation, the keys.ts
 * contract). Rows live in mesh_enroll_keys with argon2id hashes only —
 * the owner kill switch is deleting the row, which revokes instantly.
 * Mirrors the device-API auth pattern: Bearer + hash verify + per-IP
 * limiter + audit; a per-DEVICE (per-agent) success counter guards the
 * mint surface from runaway callers.
 */
async function meshEnrollGate(
  db: NodePgDatabase,
  request: FastifyRequest,
  limiter: AuthRateLimiter,
  clock: Clock,
): Promise<
  | { ok: true; keyId: string; agentName: string }
  | { ok: false; status: 401 | 403 | 429; reason: string; locked: number | null }
> {
  const ip = request.ip;
  const presentedKey = extractBearer(request);
  if (presentedKey === null) {
    return { ok: false, status: 401, reason: 'missing_key', locked: null };
  }
  if (limiter.lockedRetryAfter(ip) !== null) {
    return { ok: false, status: 429, reason: 'rate_limited', locked: limiter.lockedRetryAfter(ip) };
  }
  // Structural rejection: device keys and admin keys never enter the
  // hash-verify path of this surface.
  if (isMeshEnrollKey(presentedKey) === false) {
    limiter.recordFailure(ip);
    return { ok: false, status: 401, reason: 'bad_key_class', locked: null };
  }
  const rows = await db.select().from(meshEnrollKeys);
  let matched: { agentName: string } | null = null;
  for (const row of rows) {
    const ok = await verifyKey(row.hash, presentedKey).catch(() => false);
    if (ok) {
      matched = { agentName: row.agentName };
      break;
    }
  }
  if (matched === null) {
    limiter.recordFailure(ip);
    return { ok: false, status: 401, reason: 'bad_key', locked: null };
  }
  await db
    .update(meshEnrollKeys)
    .set({ lastUsedAt: clock.now() })
    .where(eq(meshEnrollKeys.agentName, matched.agentName));
  const fp = keyFingerprint(presentedKey) ?? 'unknown';
  return { ok: true, keyId: fp, agentName: matched.agentName };
}

app.post('/v1/mesh-enroll', async (request, reply) => {
  const gate = await meshEnrollGate(db, request, limiter, clock);
  if (!gate.ok) {
    if (gate.status === 429) {
      return reply
        .status(429)
        .header('Retry-After', String(gate.locked ?? 1))
        .send({ error: 'rate_limited', retry_after_seconds: gate.locked ?? 1 });
    }
    return reply.status(gate.status).send({ error: 'unauthorized' });
  }
  const keyId = gate.keyId;
  const ip = request.ip;

  const parsed = MeshEnrollRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    await audit(db, {
      deviceId: null,
      outcome: 'denied',
      reason: 'mesh_enroll_invalid_body',
      keyId,
      sourceIp: ip,
      occurredAt: clock.now(),
    });
    return reply.status(400).send({ error: 'invalid_request' });
  }
  const { agent_name: agentName, origin_url: originUrl, public_url: publicUrl } = parsed.data;

  // Resolve the creator key: env first, then the shared registrar-side bootstrap.
  let env: Record<string, string | undefined>;
  try {
    env = await creatorKeyEnv();
  } catch (err) {
    const reason = err instanceof MeshEnrollError ? err.code : 'mesh_enroll_bootstrap_failed';
    await audit(db, {
      deviceId: null,
      outcome: 'denied',
      reason: `mesh_enroll_bootstrap:${reason}`,
      keyId,
      sourceIp: ip,
      occurredAt: clock.now(),
    });
    return reply.status(err instanceof MeshEnrollError ? err.status : 500).send({
      error: 'not_configured',
      reason: err instanceof Error ? err.message : 'creator key bootstrap failed',
    });
  }

  let outcome;
  try {
    outcome = await enrollAgent(db, env, agentName, {
      keyId,
      sourceIp: ip,
      originUrl,
      publicUrl,
      clock,
      mintLimiter,
    });
  } catch (err) {
    if (err instanceof MeshEnrollError) {
      return reply.status(err.status).send({ error: err.code, reason: err.message });
    }
    request.log.error({ err }, 'mesh enroll failed');
    return reply.status(500).send({ error: 'internal_error' });
  }

  // Signed identity: a new mesh member gets its peers' public keys (and they get its key).
  // Best effort: the enroll already succeeded; a failed resync is re-run by the next key event.
  await resyncMeshKeys(db, clock).catch((err) => request.log.error({ err }, 'a2a key resync after enroll failed'));

  // The API returns alias + merged ONLY — key material never crosses
  // to the caller (shape B's own constraint, kept verbatim).
  return reply.status(200).send({
    alias: outcome.alias,
    action: outcome.action,
    merged: outcome.merged,
    bundle_version: outcome.bundleVersion,
  });
});

app.get('/v1/mesh-enroll/status', async (request, reply) => {
  const gate = await meshEnrollGate(db, request, limiter, clock);
  if (!gate.ok) {
    if (gate.status === 429) {
      return reply
        .status(429)
        .header('Retry-After', String(gate.locked ?? 1))
        .send({ error: 'rate_limited', retry_after_seconds: gate.locked ?? 1 });
    }
    return reply.status(gate.status).send({ error: 'unauthorized' });
  }
  // A cheap liveness probe for the CLI: no mint, no merge, no rate cost
  // beyond the gate itself.
  return reply.status(200).send({ ok: true, agent: gate.agentName });
});

app.post('/v1/rotate', async (request, reply) => {
    const gate = await adminGate(request);
    if (!gate.ok) {
      if (gate.status === 429) {
        return reply
          .status(429)
          .header('Retry-After', String(gate.locked))
          .send({ error: 'rate_limited', retry_after_seconds: gate.locked });
      }
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const parsed = RotateRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const { balena_uuid: uuid, files } = parsed.data;

    const devRows = await db.select().from(devices).where(eq(devices.balenaUuid, uuid));
    if (devRows.length === 0) return reply.status(404).send({ error: 'not_found' });

    const result = await rotateBundle(
      db,
      clock,
      uuid,
      // 1py.5: spread the validated entry whole — encoding rides along
      // (picked keys here was the same stripping class the rotate core
      // just lost).
      { kind: 'replace', files: files.map((f) => ({ ...f })) },
      { keyId: gate.keyId, sourceIp: clientIp(request), reason: 'bundle_rotated_api' },
    );
    return reply.status(200).send({
      balena_uuid: uuid,
      bundle_version: result.version,
      slot_state: result.slotState,
      delivery_count: result.deliveryCount,
    });
  });

  return app;
}

/**
 * Status variant of the two-factor check: key and UUID must match, but
 * the device row status is reported (200), not enforced — the registrant
 * uses it to distinguish pending/revoked. Only auth failures 401 here.
 */
async function authenticateForStatus(
  db: NodePgDatabase,
  balenaUuid: string,
  presentedKey: string,
): Promise<
  | { ok: true; row: DeviceRow }
  | { ok: false; reason: string; keyFailure: boolean; auditDeviceId: string | null }
> {
  const rows = await db.select().from(devices).where(eq(devices.balenaUuid, balenaUuid));
  const row = rows[0] as DeviceRow | undefined;
  if (!row) {
    await verifyKey(await getDummyHash(), presentedKey).catch(() => false);
    return { ok: false, reason: 'unknown_uuid', keyFailure: true, auditDeviceId: null };
  }
  const keyOk = await verifyKey(row.registrarKeyHash, presentedKey).catch(() => false);
  if (!keyOk) {
    return { ok: false, reason: 'bad_key', keyFailure: true, auditDeviceId: balenaUuid };
  }
  return { ok: true, row };
}