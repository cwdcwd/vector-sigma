/**
 * Signed A2A identity: the registrar side (docs/a2a-signed-identity.md).
 *
 * Each agent generates an Ed25519 key pair on its own data volume; the registrant reports the
 * PUBLIC key here on its authenticated poll. The registrar distributes public keys only:
 * every enrolled agent's config/a2a.json gains `peer_keys` ({peer: ed25519}) for its trusted
 * peers with an active key, plus the fleet `strict` switch. The device's a2a-guard verifies
 * inbound signatures against peer_keys and hot-reloads the live a2a.json, so revocation and the
 * strict flip land without a container recreate.
 *
 * Trust anchor (stated, not overstated): the first key a device reports is bound with the same
 * trust as the device itself — its per-device REGISTRAR_KEY, which already yields the whole
 * bundle. A DIFFERENT key reported later never replaces the active one: it is recorded as a
 * conflict (an owner alarm, audited) until the owner approves or rejects it in the console.
 * VS_A2A_KEY_APPROVAL=always holds even the first key as `pending` until the owner approves it.
 *
 * Strict mode is an owner switch, refused until every enrolled device REPORTS readiness
 * (guard running, signed sender, current bundle applied). In strict bundles the raw peer mesh
 * keys (peer_tokens) are no longer delivered for keyed peers; turning strict off restores them.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BundleFile } from '@vector-sigma/shared';
import { a2aPublicKeys, devices, identityBlobs, meshSettings } from './db/schema.js';
import { audit } from './audit.js';
import { rotateBundle } from './rotate.js';
import { readA2aFromBundle, bundleIdentityKey } from './mesh-enroll.js';
import type { Clock } from './clock.js';

const A2A_PATH = 'config/a2a.json';
/** Ed25519 public key, raw 32 bytes, base64url without padding (the guard's wire format). */
const ED25519_B64URL = /^[A-Za-z0-9_-]{43}$/;
/**
 * A guard status older than this does not count as running. The registrant reports on every
 * watcher cycle (WATCH_INTERVAL_MS), so this must stay comfortably above that cadence; a fleet
 * polling slower can raise it with VS_A2A_READY_MAX_AGE_MS (milliseconds).
 */
export const READY_MAX_AGE_MS = 15 * 60 * 1000;

function readyMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.VS_A2A_READY_MAX_AGE_MS);
  return Number.isFinite(v) && v > 0 ? v : READY_MAX_AGE_MS;
}

export class A2aKeyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type KeyPolicy = 'first-use' | 'always';

export function resolveKeyPolicy(env: Record<string, string | undefined>): KeyPolicy {
  return (env.VS_A2A_KEY_APPROVAL ?? '').trim().toLowerCase() === 'always' ? 'always' : 'first-use';
}

/** The guard's fingerprint: first 16 hex of sha256(raw key). Throws on a malformed key. */
export function keyFingerprint(ed25519: string): string {
  if (!ED25519_B64URL.test(ed25519)) {
    throw new A2aKeyError('ed25519 must be a 32-byte key, base64url without padding', 'invalid_key', 400);
  }
  const raw = Buffer.from(ed25519, 'base64url');
  if (raw.length !== 32) throw new A2aKeyError('ed25519 must decode to 32 bytes', 'invalid_key', 400);
  // Canonical encoding only: a 43-char form also admits low-bit variants of the same 32 bytes,
  // which would compare unequal as strings and fire a false conflict alarm. The guard always
  // emits the canonical form.
  if (raw.toString('base64url') !== ed25519) {
    throw new A2aKeyError('ed25519 must be canonically encoded', 'invalid_key', 400);
  }
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export type RegisterResult = { status: 'active' | 'pending' | 'conflict' | 'unchanged'; fingerprint: string };

/**
 * Record the key a device reported. First key: active (or pending under the `always` policy).
 * Same key again: unchanged. A different key: a conflict alarm, never a replacement.
 */
export async function registerDeviceKey(
  db: NodePgDatabase,
  clock: Clock,
  deviceId: string,
  ed25519: string,
  policy: KeyPolicy,
  opts: { keyId?: string | null; sourceIp?: string | null } = {},
): Promise<RegisterResult> {
  const fp = keyFingerprint(ed25519);
  const now = clock.now();
  const result = await db.transaction(async (tx) => {
    const rows = await tx.select().from(a2aPublicKeys).where(eq(a2aPublicKeys.deviceId, deviceId));
    const row = rows[0];
    if (!row) {
      const status = policy === 'always' ? 'pending' : 'active';
      await tx.insert(a2aPublicKeys).values({
        deviceId, ed25519, fingerprint: fp, status, createdAt: now, updatedAt: now,
      });
      await audit(tx, {
        deviceId, outcome: 'admin', reason: `a2a_key_${status === 'active' ? 'registered' : 'pending'}:${fp}`,
        keyId: opts.keyId ?? null, sourceIp: opts.sourceIp ?? null, occurredAt: now,
      });
      return { status, fingerprint: fp } as RegisterResult;
    }
    if (row.ed25519 === ed25519) return { status: 'unchanged', fingerprint: fp } as RegisterResult;
    if (row.conflictEd25519 === ed25519) return { status: 'conflict', fingerprint: fp } as RegisterResult;
    await tx
      .update(a2aPublicKeys)
      .set({ conflictEd25519: ed25519, conflictFingerprint: fp, conflictAt: now, updatedAt: now })
      .where(eq(a2aPublicKeys.deviceId, deviceId));
    await audit(tx, {
      deviceId, outcome: 'denied', reason: `a2a_key_conflict:active=${row.fingerprint},reported=${fp}`,
      keyId: opts.keyId ?? null, sourceIp: opts.sourceIp ?? null, occurredAt: now,
    });
    return { status: 'conflict', fingerprint: fp } as RegisterResult;
  });
  if (result.status === 'active') await resyncMeshKeys(db, clock);
  return result;
}

/** Store the guard's status.json + the bundle version the device has applied (readiness). */
export async function reportGuardStatus(
  db: NodePgDatabase,
  clock: Clock,
  deviceId: string,
  guardStatus: Record<string, unknown> | null,
  bundleVersion: number | null,
): Promise<void> {
  await db
    .update(a2aPublicKeys)
    .set({
      guardStatus: guardStatus ?? null,
      reportedBundleVersion: bundleVersion,
      reportedAt: clock.now(),
    })
    .where(eq(a2aPublicKeys.deviceId, deviceId));
}

export async function getStrict(db: NodePgDatabase): Promise<boolean> {
  const rows = await db.select().from(meshSettings).where(eq(meshSettings.id, 1));
  return rows[0]?.strict ?? false;
}

export interface DeviceReadiness {
  deviceId: string;
  agentName: string;
  fingerprint: string | null;
  keyStatus: 'active' | 'pending' | 'none';
  conflictFingerprint: string | null;
  guardRunning: boolean;
  signedSender: boolean;
  appliedCurrent: boolean;
  ready: boolean;
}

interface EnrolledRow {
  deviceId: string;
  agentName: string;
  files: BundleFile[];
  version: number;
}

/** Active devices whose bundle carries an A2A identity (the mesh members). */
async function enrolledDevices(db: NodePgDatabase): Promise<EnrolledRow[]> {
  const rows = await db
    .select({ deviceId: devices.balenaUuid, agentName: devices.agentName, bundle: identityBlobs.bundle, version: identityBlobs.version })
    .from(devices)
    .innerJoin(identityBlobs, eq(identityBlobs.deviceId, devices.balenaUuid))
    .where(eq(devices.status, 'active'));
  return rows
    .map((r) => ({ deviceId: r.deviceId, agentName: r.agentName,
      files: ((r.bundle as { files?: BundleFile[] }).files ?? []) as BundleFile[], version: r.version }))
    .filter((r) => bundleIdentityKey(r.files) !== '');
}

/** Per-device readiness for the strict switch (docs/a2a-signed-identity.md, Strict mode). */
export async function readiness(db: NodePgDatabase, clock: Clock): Promise<DeviceReadiness[]> {
  const enrolled = await enrolledDevices(db);
  const keyRows = await db.select().from(a2aPublicKeys);
  const byDevice = new Map(keyRows.map((k) => [k.deviceId, k]));
  const now = clock.now().getTime();
  return enrolled.map((d) => {
    const k = byDevice.get(d.deviceId);
    const st = (k?.guardStatus ?? null) as Record<string, unknown> | null;
    const fresh = k?.reportedAt ? now - new Date(k.reportedAt).getTime() <= readyMaxAgeMs() : false;
    const guardRunning = fresh && st?.running === true;
    const outbound = Array.isArray(st?.outbound_peers) ? (st?.outbound_peers as unknown[]) : [];
    const signedSender = guardRunning && outbound.length > 0;
    const appliedCurrent = k?.reportedBundleVersion === d.version;
    const keyStatus = (k?.status as 'active' | 'pending' | undefined) ?? 'none';
    return {
      deviceId: d.deviceId,
      agentName: d.agentName,
      fingerprint: k?.fingerprint ?? null,
      keyStatus,
      conflictFingerprint: k?.conflictFingerprint ?? null,
      guardRunning,
      signedSender,
      appliedCurrent,
      ready: keyStatus === 'active' && !k?.conflictFingerprint && guardRunning && signedSender && appliedCurrent,
    };
  });
}

/**
 * Turn strict mode on or off. ON is refused (409) unless every enrolled device reports ready;
 * OFF is always allowed (the live rollback). Re-renders every enrolled bundle.
 */
export async function setStrict(
  db: NodePgDatabase,
  clock: Clock,
  on: boolean,
  opts: { keyId?: string | null; sourceIp?: string | null } = {},
): Promise<{ strict: boolean; rotated: number }> {
  if (on) {
    const r = await readiness(db, clock);
    const notReady = r.filter((d) => !d.ready);
    if (r.length === 0 || notReady.length > 0) {
      throw new A2aKeyError('strict mode needs every enrolled device to report ready', 'not_ready', 409,
        notReady.map((d) => d.agentName));
    }
  }
  const now = clock.now();
  await db
    .insert(meshSettings)
    .values({ id: 1, strict: on, updatedAt: now })
    .onConflictDoUpdate({ target: meshSettings.id, set: { strict: on, updatedAt: now } });
  await audit(db, {
    deviceId: null, outcome: 'admin', reason: `a2a_strict_${on ? 'on' : 'off'}`,
    keyId: opts.keyId ?? null, sourceIp: opts.sourceIp ?? null, occurredAt: now,
  });
  return { strict: on, rotated: await resyncMeshKeys(db, clock) };
}

/** Owner action: activate a pending first key, or swap a conflicting key in. Resyncs peers. */
export async function approveDeviceKey(db: NodePgDatabase, clock: Clock, deviceId: string): Promise<string> {
  const rows = await db.select().from(a2aPublicKeys).where(eq(a2aPublicKeys.deviceId, deviceId));
  const row = rows[0];
  if (!row) throw new A2aKeyError('no key reported for this device', 'no_key', 404);
  const now = clock.now();
  const swap = row.conflictEd25519 !== null && row.conflictEd25519 !== undefined;
  const ed25519 = swap ? row.conflictEd25519! : row.ed25519;
  const fp = swap ? row.conflictFingerprint! : row.fingerprint;
  await db
    .update(a2aPublicKeys)
    .set({ ed25519, fingerprint: fp, status: 'active', conflictEd25519: null, conflictFingerprint: null,
      conflictAt: null, updatedAt: now })
    .where(eq(a2aPublicKeys.deviceId, deviceId));
  await audit(db, { deviceId, outcome: 'admin', reason: `a2a_key_approved:${fp}`, occurredAt: now });
  await resyncMeshKeys(db, clock);
  return fp;
}

/** Owner action: drop the conflicting key only (the active key stays). */
export async function rejectConflict(db: NodePgDatabase, clock: Clock, deviceId: string): Promise<void> {
  const now = clock.now();
  await db
    .update(a2aPublicKeys)
    .set({ conflictEd25519: null, conflictFingerprint: null, conflictAt: null, updatedAt: now })
    .where(eq(a2aPublicKeys.deviceId, deviceId));
  await audit(db, { deviceId, outcome: 'admin', reason: 'a2a_key_conflict_rejected', occurredAt: now });
}

/** Owner action: revoke the device's key entirely. Peers stop accepting it on their next reload. */
export async function revokeDeviceKey(db: NodePgDatabase, clock: Clock, deviceId: string): Promise<void> {
  const now = clock.now();
  await db.delete(a2aPublicKeys).where(eq(a2aPublicKeys.deviceId, deviceId));
  await audit(db, { deviceId, outcome: 'admin', reason: 'a2a_key_revoked', occurredAt: now });
  await resyncMeshKeys(db, clock);
}

/**
 * Render peer_keys + strict into every enrolled bundle (and, in strict mode, drop the raw
 * peer_tokens of keyed peers; restore them when strict is off). Rotates only bundles whose
 * a2a.json actually changes. Returns the number of bundles rotated.
 */
export async function resyncMeshKeys(db: NodePgDatabase, clock: Clock): Promise<number> {
  const strict = await getStrict(db);
  const enrolled = await enrolledDevices(db);
  const keyRows = await db.select().from(a2aPublicKeys);
  const activeKey = new Map<string, string>();
  const deviceName = new Map(enrolled.map((d) => [d.deviceId, d.agentName]));
  for (const k of keyRows) {
    const name = deviceName.get(k.deviceId);
    if (name && k.status === 'active') activeKey.set(name, k.ed25519);
  }
  const identityKey = new Map(enrolled.map((d) => [d.agentName, bundleIdentityKey(d.files)]));
  let rotated = 0;
  for (const d of enrolled) {
    const a2a = readA2aFromBundle(d.files);
    if (!a2a) continue;
    const trusted = Array.isArray(a2a.trusted_peers)
      ? (a2a.trusted_peers as unknown[]).filter((p): p is string => typeof p === 'string' && p !== d.agentName)
      : [];
    const peerKeys: Record<string, string> = {};
    for (const p of trusted) {
      const k = activeKey.get(p);
      if (k) peerKeys[p] = k;
    }
    const next: Record<string, unknown> = { ...a2a };
    const tokens: Record<string, string> = {
      ...((a2a.peer_tokens as Record<string, string> | undefined) ?? {}),
    };
    if (Object.keys(peerKeys).length > 0) {
      next.peer_keys = peerKeys;
      next.strict = strict;
    } else {
      delete next.peer_keys;
      delete next.strict;
    }
    for (const p of trusted) {
      if (strict && peerKeys[p]) {
        delete tokens[p]; // strict: keyed peers authenticate by signature; no raw mesh key on this device
      } else if (!strict && !tokens[p] && identityKey.get(p)) {
        // dual: the legacy inbound path needs the raw key. Never re-distribute under strict, so
        // revoking a key while strict does not hand the revoked peer's legacy credential back out.
        tokens[p] = identityKey.get(p)!;
      }
    }
    if (Object.keys(tokens).length > 0) next.peer_tokens = tokens;
    else delete next.peer_tokens;
    const rendered = JSON.stringify(next, null, 2) + '\n';
    const current = d.files.find((f) => f.path === A2A_PATH)?.content ?? '';
    if (rendered === current) continue;
    const keep = new Set(d.files.map((f) => f.path).filter((p) => p !== A2A_PATH));
    await rotateBundle(db, clock, d.deviceId, {
      kind: 'merge', keep, updates: new Map([[A2A_PATH, rendered]]), additions: [],
    }, { reason: 'a2a_keys_resync' });
    rotated++;
  }
  return rotated;
}
