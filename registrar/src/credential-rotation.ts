/**
 * Safe fleet credential rotation (fleet-ops-1py.24 — issue #81).
 *
 * Two tracked flows, both writing the rotation registry
 * (schema.credentialRotations) and enforcing the deliver-then-revoke order
 * the fleet runs on:
 *
 *   a2a_identity — rotating an agent's A2A identity (mesh) key.
 *     1. START: mint the new key under a VERSIONED alias
 *        (`vs-<agent>-a2a-r<n>`; the old alias stays live at the gateway
 *        through the whole overlap window), then deliver to EVERY
 *        referencing peer (not just to the target): the peer's a2a.json
 *        gains the NEW token as the canonical `peer_tokens[<agent>]`
 *        entry PLUS the OLD one as the additive `peer_tokens_overlap`
 *        entry — a receiver accepts both keys through the window (the
 *        guard env already carries same-name token pairs in dual mode, so
 *        this is a precedent'd runtime shape). The TARGET's bundle is NOT
 *        touched yet: it keeps presenting the old (still-live) key while
 *        peers converge.
 *     2. SWEEP: once every peer has reported the stage-1 bundle APPLIED
 *        (bundleReports — the device confirmation channel), the target's
 *        bundle flips to the new identity key.
 *     3. SWEEP: once the TARGET confirms the flipped bundle applied, the
 *        OLD key is revoked at the gateway and the overlap entries are
 *        cleaned from every peer bundle; the registry row closes and its
 *        cleartext columns are wiped.
 *     Zero failed A2A sends by construction: at every step, every
 *     in-rotation receiver accepts both the key the target still presents
 *     and the one it will present after its next restart.
 *
 *   model_key — rotating an agent's gateway model key.
 *     1. START: mint under a versioned alias (`model-<agent>-r<n>`) and
 *        merge the new key into the target's bundle (GATEWAY_API_KEY).
 *        The device never sees a failing model-call window because the
 *        old key stays live at the gateway until step 2.
 *     2. SWEEP: the target confirms the carried bundle applied
 *        (bundleReports; devices whose report lane lacks the applied
 *        version get the console's owner-asserted force revoke), then the
 *        OLD key is revoked BY ALIAS — its row token is re-read through
 *        the /key/list oracle exactly like the enroll bootstrap does, so
 *        no plaintext ever rounds-trips through the registrar.
 *
 * Rotation observability (issue #81): per rotation, per device, the
 * console /admin/rotations page shows state, the applied versions, and
 * the revocation timestamp.
 *
 * SAFETY: no live credential operation happens unprompted — every gateway
 * write is downstream of an explicit console action (start / reconcile /
 * force-revoke) or of a device's OWN applied-version report confirming
 * the new credential is resident. The audit table carries the actuator
 * log; the registry rows are the recovery state.
 */
import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { audit } from './audit.js';
import type { Clock } from './clock.js';
import type { Executor } from './slots.js';
import {
  resolveGatewayConfig,
  gatewayCall,
  type GatewayConfig,
} from './gateway-mint.js';
import {
  findModelKeyToken,
  ensureUserForAgent,
  mintModelKeyForAlias,
} from './gateway-mint.js';
import {
  bundleIdentityKey,
  readA2aFromBundle,
  renderA2aJson,
  meshKeyAlias,
  findKeyRow,
  mintMeshKeyForAlias,
} from './mesh-enroll.js';
import { rotateBundle } from './rotate.js';
import {
  bundleReports,
  credentialRotations,
  devices,
  identityBlobs,
} from './db/schema.js';
import {
  findOpenRotationByAgent,
  countPriorRotations,
  appliedBundleVersion,
} from './rotation-state.js';

/** Error surface for console routes: code → HTTP status mapping there. */
export class RotationError extends Error {
  constructor(
    public code: 'no_bundle' | 'rotation_in_flight' | 'alias_live' | 'config' | 'gateway',
    message: string,
    public status = 409,
  ) {
    super(message);
    this.name = 'RotationError';
  }
}

/** Options threaded into audits (the console's admin key + caller IP). */
export interface RotationOptions {
  keyId?: string | null;
  sourceIp?: string | null;
}

type RotationPayload = {
  /** Stage-1 peer ledger: which peer got which bundle version. */
  peers?: Array<{ agent: string; uuid: string; version: number }>;
};
type RotationRecord = typeof credentialRotations.$inferSelect;

function peersOf(row: RotationRecord): RotationPayload['peers'] {
  const payload = (row.payload ?? null) as RotationPayload | null;
  const peers = Array.isArray(payload?.peers) ? payload.peers : [];
  return peers as NonNullable<RotationPayload['peers']>;
}

/* --------------------------------------------------------------------------
 * Report channel (routes) — the applied-version confirmations land here
 * ------------------------------------------------------------------------ */

/** Upsert the device's applied bundle version (registrant + guard reports). */
export async function upsertBundleReport(
  db: Executor,
  clock: Clock,
  deviceId: string,
  appliedVersion: number,
): Promise<void> {
  await db
    .insert(bundleReports)
    .values({ deviceId, appliedVersion, reportedAt: clock.now() })
    .onConflictDoUpdate({
      target: bundleReports.deviceId,
      set: { appliedVersion, reportedAt: clock.now() },
    });
}

/* --------------------------------------------------------------------------
 * a2a_identity rotation — start
 * ------------------------------------------------------------------------ */

/**
 * Start a tracked a2a_identity rotation for `agentName`: mint the new mesh
 * key under a versioned alias and deliver new+old overlap to every
 * referencing peer. The target's bundle is untouched until the sweep flips
 * it (it keeps presenting the still-live old key through the window).
 */
export async function startIdentityRotation(
  db: NodePgDatabase,
  clock: Clock,
  env: Record<string, string | undefined>,
  agentName: string,
  opts: RotationOptions = {},
): Promise<{ rotationId: number; newAlias: string; peers: number }> {
  const loaded = await loadRotationTarget(db, agentName);
  if (loaded.bundle === null || loaded.oldToken === null || loaded.oldToken === '') {
    await auditDenied(db, loaded.device.balenaUuid, 'rotation_no_mesh_identity', opts);
    throw new RotationError(
      'no_bundle',
      `agent '${agentName}' carries no a2a.json with an identity_key — run the mesh enroll to mint one first`,
    );
  }
  const open = await findOpenRotationByAgent(db, agentName, 'a2a_identity');
  if (open !== null) {
    await auditDenied(db, loaded.device.balenaUuid, 'rotation_in_flight', opts);
    throw new RotationError(
      'rotation_in_flight',
      `an a2a_identity rotation (#${open.id}, ${open.status}) is already open for '${agentName}' — complete it first`,
    );
  }

  // Mint gate: the creator credential lives only in the registrar service
  // (the env is the console's creatorKeyEnv — MintConfigError surfaces the
  // manual fallback message, the same posture as the enroll).
  const cfg = resolveGatewayConfig(env);
  const priorRotations = await countPriorRotations(db, agentName, 'a2a_identity');
  const newAlias = await freshMeshAlias(cfg, agentName, priorRotations + 1);
  const minted = await mintMeshKeyForAlias(cfg, agentName, newAlias);

  const peerSet = await referencingPeerDevices(db, agentName, loaded.device.balenaUuid);
  const peerLedger: RotationPayload['peers'] = [];
  const oldToken = loaded.oldToken;
  // The peer scan already read each peer's bundle + rendered a2a json —
  // deliver straight from it (one query per peer total, no re-read race).
  for (const peer of peerSet) {
    // Canonical = the NEW token (freshly-rendering peers bootstrap right);
    // overlap = the OLD one (already-applied peers keep accepting the key
    // the target still presents). Both planes are covered either way.
    const next = renderA2aJson(peer.a2a, {
      addPeerTokens: { [agentName]: minted.key },
      addPeerTokensOverlap: { [agentName]: oldToken },
    });
    const { version } = await rotateBundle(
      db,
      clock,
      peer.uuid,
      mergeSpecForA2aReplace(peer.files, next),
      {
        keyId: opts.keyId ?? null,
        sourceIp: opts.sourceIp ?? null,
        reason: `identity_rotation_overlap:${agentName}`,
      },
    );
    peerLedger.push({ agent: peer.agent, uuid: peer.uuid, version });
  }

  const row = (
    await db
      .insert(credentialRotations)
      .values({
        kind: 'a2a_identity',
        deviceId: loaded.device.balenaUuid,
        agentName,
        oldAlias: meshKeyAlias(agentName),
        newAlias,
        oldToken,
        newToken: minted.key,
        newBundleVersion: null, // set at the flip
        payload: { peers: peerLedger },
        status: 'delivering',
      })
      .returning({ id: credentialRotations.id })
  )[0];

  await audit(db, {
    deviceId: loaded.device.balenaUuid,
    outcome: 'admin',
    reason: 'identity_rotation_started',
    keyId: opts.keyId ?? null,
    sourceIp: opts.sourceIp ?? null,
    occurredAt: clock.now(),
  });
  return { rotationId: row.id, newAlias, peers: peerLedger.length };
}

/* --------------------------------------------------------------------------
 * model_key rotation — start
 * ------------------------------------------------------------------------ */

/**
 * Start a tracked model_key rotation: mint under a versioned alias and
 * merge the new key into the target's bundle (GATEWAY_API_KEY). The old
 * key stays live at the gateway until the sweep confirms the target
 * applied (deliver-then-revoke); the registrar never learns the old
 * plaintext — the revoke resolves it by alias through the list oracle.
 */
export async function startModelRotation(
  db: NodePgDatabase,
  clock: Clock,
  env: Record<string, string | undefined>,
  agentName: string,
  opts: RotationOptions = {},
): Promise<{ rotationId: number; newAlias: string; newBundleVersion: number }> {
  const loaded = await loadRotationTarget(db, agentName);
  const currentKey = bundledEnvValue(loaded.files, 'GATEWAY_API_KEY');
  if (loaded.bundle === null || currentKey === '') {
    await auditDenied(db, loaded.device.balenaUuid, 'rotation_no_model_key', opts);
    throw new RotationError(
      'no_bundle',
      `agent '${agentName}'s bundle carries no GATEWAY_API_KEY — use the provision action to mint the first key`,
    );
  }
  const open = await findOpenRotationByAgent(db, agentName, 'model_key');
  if (open !== null) {
    await auditDenied(db, loaded.device.balenaUuid, 'rotation_in_flight', opts);
    throw new RotationError(
      'rotation_in_flight',
      `a model_key rotation (#${open.id}, ${open.status}) is already open for '${agentName}' — complete it first`,
    );
  }

  const cfg = resolveGatewayConfig(env);
  await ensureUserForAgent(cfg, agentName);
  const priorRotations = await countPriorRotations(db, agentName, 'model_key');
  const newAlias = await freshModelAlias(cfg, agentName, priorRotations + 1);
  const newKey = await mintModelKeyForAlias(cfg, agentName, newAlias);

  const { version } = await rotateBundle(
    db,
    clock,
    loaded.device.balenaUuid,
    mergeSpecForEnvUpdate(loaded.files, 'GATEWAY_API_KEY', newKey),
    {
      keyId: opts.keyId ?? null,
      sourceIp: opts.sourceIp ?? null,
      reason: `model_key_rotation_merged:${agentName}`,
    },
  );

  const row = (
    await db
      .insert(credentialRotations)
      .values({
        kind: 'model_key',
        deviceId: loaded.device.balenaUuid,
        agentName,
        oldAlias: await currentModelAlias(db, agentName),
        newAlias,
        oldToken: null,
        newToken: null,
        newBundleVersion: version,
        payload: {},
        status: 'delivering',
      })
      .returning({ id: credentialRotations.id })
  )[0];

  await audit(db, {
    deviceId: loaded.device.balenaUuid,
    outcome: 'admin',
    reason: 'model_key_rotation_started',
    keyId: opts.keyId ?? null,
    sourceIp: opts.sourceIp ?? null,
    occurredAt: clock.now(),
  });
  return { rotationId: row.id, newAlias, newBundleVersion: version };
}

/* --------------------------------------------------------------------------
 * The sweep — advanceRotations
 * ------------------------------------------------------------------------ */

export interface SweepOutcome {
  id?: number;
  scanned: number;
  flipped: Array<{ id: number; agent: string }>;
  targetConfirmed: Array<{ id: number; agent: string }>;
  revoked: Array<{ id: number; agent: string }>;
  cleaned: Array<{ id: number; agent: string; peers: number }>;
  errors: Array<{ id: number; error: string }>;
}

/**
 * Advance every open rotation whose confirmations have arrived. Never
 * re-delivers: stage-1 renders land exactly once, in the start call.
 * Runs from the device report paths (a2a-key report, bundle-applied
 * report) and from the console's explicit reconcile action — never from
 * GETs. `rotationId` narrows the sweep to one row (the console's
 * reconcile/`forceRevoke` path; `rotationId` is ignored when it does not
 * name an OPEN row).
 */
export async function advanceRotations(
  db: NodePgDatabase,
  clock: Clock,
  env: Record<string, string | undefined> | undefined,
  opts: RotationOptions & { rotationId?: number; forceRevoke?: number } = {},
): Promise<SweepOutcome> {
  const outcome: SweepOutcome = {
    scanned: 0,
    flipped: [],
    targetConfirmed: [],
    revoked: [],
    cleaned: [],
    errors: [],
  };
  const rows = await db
    .select()
    .from(credentialRotations)
    .where(inArray(credentialRotations.status, openStatuses))
    .orderBy(credentialRotations.id);
  for (const rowRaw of rows) {
    const row = rowRaw as RotationRecord;
    if (opts.forceRevoke !== undefined && row.id !== opts.forceRevoke) continue;
    if (opts.rotationId !== undefined && row.id !== opts.rotationId) continue;
    outcome.scanned += 1;
    try {
      if (row.kind === 'a2a_identity') {
        if (row.status === 'delivering') {
          const confirmed =
            opts.forceRevoke !== undefined ? true : await peersConfirmed(db, row);
          if (confirmed) await flipTarget(db, clock, row, outcome, opts);
        }
        if (row.status === 'awaiting_target') {
          const confirmed =
            opts.forceRevoke !== undefined ? true : await rotationTargetConfirmed(db, row);
          if (confirmed) {
            await db
              .update(credentialRotations)
              .set({ status: 'awaiting_revoke', targetConfirmedAt: clock.now(), updatedAt: clock.now() })
              .where(eq(credentialRotations.id, row.id));
            row.status = 'awaiting_revoke';
            outcome.targetConfirmed.push({ id: row.id, agent: row.agentName });
          }
        }
        if (row.status === 'awaiting_revoke') {
          const revoked = await revokeMeshKey(db, clock, env, row, opts);
          if (revoked) {
            const peers = await cleanupPeerOverlap(db, clock, row, opts);
            await db
              .update(credentialRotations)
              .set({
                status: 'completed',
                oldToken: null,
                newToken: null,
                revokedAt: clock.now(),
                completedAt: clock.now(),
                updatedAt: clock.now(),
                gatewayError: null,
              })
              .where(eq(credentialRotations.id, row.id));
            outcome.revoked.push({ id: row.id, agent: row.agentName });
            outcome.cleaned.push({ id: row.id, agent: row.agentName, peers });
          } else if (row.gatewayError !== null && row.gatewayError !== '') {
            // The refusal is visible to the console (retried next sweep).
            outcome.errors.push({ id: row.id, error: row.gatewayError });
          }
        }
      } else if (row.kind === 'model_key') {
        if (row.status === 'delivering') {
          const confirmed =
            opts.forceRevoke !== undefined ? true : await rotationTargetConfirmed(db, row);
          if (confirmed) {
            await db
              .update(credentialRotations)
              .set({
                status: 'awaiting_revoke',
                targetConfirmedAt: clock.now(),
                updatedAt: clock.now(),
              })
              .where(eq(credentialRotations.id, row.id));
            row.status = 'awaiting_revoke';
            outcome.targetConfirmed.push({ id: row.id, agent: row.agentName });
          }
        }
        if (row.status === 'awaiting_revoke') {
          const revoked = await revokeModelKey(db, clock, env, row, opts);
          if (revoked) {
            await db
              .update(credentialRotations)
              .set({
                status: 'completed',
                revokedAt: clock.now(),
                completedAt: clock.now(),
                updatedAt: clock.now(),
                gatewayError: null,
              })
              .where(eq(credentialRotations.id, row.id));
            outcome.revoked.push({ id: row.id, agent: row.agentName });
          } else if (row.gatewayError !== null && row.gatewayError !== '') {
            outcome.errors.push({ id: row.id, error: row.gatewayError });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome.errors.push({ id: row.id, error: message });
      // The row STAYS in its current state for a later sweep (idempotent);
      // note the failure so the console shows why it has not advanced.
      await noteFailure(db, clock, row, message);
    }
  }
  return outcome;
}

const openStatuses = ['delivering', 'awaiting_target', 'awaiting_revoke'] as const;

/* --------------------------------------------------------------------------
 * sweep internals
 * ------------------------------------------------------------------------ */

async function peersConfirmed(db: NodePgDatabase, row: RotationRecord): Promise<boolean> {
  const peers = peersOf(row) ?? [];
  if (peers.length === 0) return true;
  for (const peer of peers) {
    const applied = await appliedBundleVersion(db, peer.uuid);
    if (applied === null || applied < peer.version) return false;
  }
  return true;
}

/** The TARGET's own confirmation (its bundle version ≥ the flip version). */
async function rotationTargetConfirmed(db: NodePgDatabase, row: RotationRecord): Promise<boolean> {
  if (row.deviceId === null || row.newBundleVersion === null) return false;
  const applied = await appliedBundleVersion(db, row.deviceId);
  return applied !== null && applied >= row.newBundleVersion;
}

/** Flip the target's bundle to the NEW identity key (all peers confirmed). */
async function flipTarget(
  db: NodePgDatabase,
  clock: Clock,
  row: RotationRecord,
  outcome: SweepOutcome,
  opts: RotationOptions,
): Promise<void> {
  if (row.deviceId === null) {
    throw new RotationError('no_bundle', `rotation #${row.id} has no target device`, 409);
  }
  const { files } = await loadBundle(db, row.deviceId);
  const a2a = readA2aFromBundle(files as never);
  if (a2a === null) {
    throw new RotationError('no_bundle', `rotation #${row.id}: target bundle lost its a2a.json`);
  }
  const next = renderA2aJson(a2a, { identityKey: row.newToken ?? '' });
  const { version } = await rotateBundle(
    db,
    clock,
    row.deviceId,
    mergeSpecForA2aReplace(files, next),
    {
      keyId: opts.keyId ?? null,
      sourceIp: opts.sourceIp ?? null,
      reason: `identity_rotation_flip:${row.agentName}`,
    },
  );
  await db
    .update(credentialRotations)
    .set({
      status: 'awaiting_target',
      newBundleVersion: version,
      flipAt: clock.now(),
      updatedAt: clock.now(),
    })
    .where(eq(credentialRotations.id, row.id));
  row.newBundleVersion = version;
  outcome.flipped.push({ id: row.id, agent: row.agentName });
}

/** Revoke the OLD mesh identity key at the gateway, by token. */
async function revokeMeshKey(
  db: NodePgDatabase,
  clock: Clock,
  env: Record<string, string | undefined> | undefined,
  row: RotationRecord,
  opts: RotationOptions,
): Promise<boolean> {
  if (env === undefined) {
    await noteFailure(db, clock, row, 'gateway not configured (no creator key) — revoke retried on the next sweep');
    return false;
  }
  const cfg = resolveGatewayConfig(env);
  if (row.oldToken === null || row.oldToken === '') {
    throw new RotationError('gateway', `rotation #${row.id} lost its old token before revocation`, 500);
  }
  const res = await gatewayCall(cfg, 'POST', '/key/delete', { keys: [row.oldToken] });
  if (res.status === 200 || res.status === 404) {
    await audit(db, {
      deviceId: row.deviceId,
      outcome: 'admin',
      reason: `identity_rotation_revoked:${row.agentName}`,
      keyId: opts.keyId ?? null,
      sourceIp: opts.sourceIp ?? null,
      occurredAt: clock.now(),
    });
    return true;
  }
  await noteFailure(db, clock, row, `gateway /key/delete HTTP ${res.status}: ${(res.raw ?? '').slice(0, 240)}`);
  return false;
}

/** Revoke the OLD model key BY ALIAS via the list oracle (no plaintext). */
async function revokeModelKey(
  db: NodePgDatabase,
  clock: Clock,
  env: Record<string, string | undefined> | undefined,
  row: RotationRecord,
  opts: RotationOptions,
): Promise<boolean> {
  if (env === undefined) {
    await noteFailure(db, clock, row, 'gateway not configured (no creator key) — revoke retried on the next sweep');
    return false;
  }
  const cfg = resolveGatewayConfig(env);
  const token = await findModelKeyToken(cfg, row.oldAlias);
  if (token === null) {
    // The old alias is not live anymore — revoked elsewhere (or never
    // minted); revocation is the goal state, not the mechanism.
    await audit(db, {
      deviceId: row.deviceId,
      outcome: 'admin',
      reason: `model_key_rotation_revoked_absent:${row.agentName} (${row.oldAlias} not live)`,
      keyId: opts.keyId ?? null,
      sourceIp: opts.sourceIp ?? null,
      occurredAt: clock.now(),
    });
    return true;
  }
  const res = await gatewayCall(cfg, 'POST', '/key/delete', { keys: [token] });
  if (res.status === 200 || res.status === 404) {
    await audit(db, {
      deviceId: row.deviceId,
      outcome: 'admin',
      reason: `model_key_rotation_revoked:${row.agentName} (${row.oldAlias})`,
      keyId: opts.keyId ?? null,
      sourceIp: opts.sourceIp ?? null,
      occurredAt: clock.now(),
    });
    return true;
  }
  await noteFailure(db, clock, row, `gateway /key/delete HTTP ${res.status}: ${(res.raw ?? '').slice(0, 240)}`);
  return false;
}

/** Retire the overlap entries from every delivered peer bundle. */
async function cleanupPeerOverlap(
  db: NodePgDatabase,
  clock: Clock,
  row: RotationRecord,
  opts: RotationOptions,
): Promise<number> {
  let cleaned = 0;
  for (const peer of peersOf(row) ?? []) {
    const { files } = await loadBundle(db, peer.uuid);
    const a2a = readA2aFromBundle(files as never);
    if (a2a === null) continue;
    const overlap = (a2a as Record<string, unknown>).peer_tokens_overlap;
    if (
      overlap === null ||
      typeof overlap !== 'object' ||
      (overlap as Record<string, unknown>)[row.agentName] === undefined
    ) {
      continue; // overlap already gone — no version bump for no-ops
    }
    const next = renderA2aJson(a2a, { dropPeerTokensOverlap: [row.agentName] });
    const { version } = await rotateBundle(
      db,
      clock,
      peer.uuid,
      mergeSpecForA2aReplace(files, next),
      {
        keyId: opts.keyId ?? null,
        sourceIp: opts.sourceIp ?? null,
        reason: `identity_rotation_cleanup:${row.agentName}`,
      },
    );
    cleaned += 1;
  }
  return cleaned;
}

async function noteFailure(
  db: NodePgDatabase,
  clock: Clock,
  row: RotationRecord,
  message: string,
): Promise<void> {
  row.gatewayError = message.slice(0, 500);
  await db
    .update(credentialRotations)
    .set({ gatewayError: row.gatewayError, updatedAt: clock.now() })
    .where(eq(credentialRotations.id, row.id));
}

async function auditDenied(
  db: NodePgDatabase,
  deviceId: string | null,
  reason: string,
  opts: RotationOptions,
): Promise<void> {
  await audit(db, {
    deviceId,
    outcome: 'denied',
    reason,
    keyId: opts.keyId ?? null,
    sourceIp: opts.sourceIp ?? null,
  });
}

/* --------------------------------------------------------------------------
 * shared helpers
 * ------------------------------------------------------------------------ */

interface BundleFileLike {
  path: string;
  content: string;
  mode?: string;
  encoding?: string;
}

interface LoadedTarget {
  device: typeof devices.$inferSelect;
  bundle: { files: BundleFileLike[] } | null;
  files: BundleFileLike[];
  oldToken: string;
}

/** Resolve the enrolled device + current bundle for a named agent. */
async function loadRotationTarget(db: NodePgDatabase, agentName: string): Promise<LoadedTarget> {
  const targetRows = await db
    .select()
    .from(devices)
    .where(eq(devices.agentName, agentName));
  const device = targetRows.length > 0 ? targetRows[0] : null;
  if (!device) {
    throw new RotationError('no_bundle', `no enrolled device for agent '${agentName}'`, 404);
  }
  const blobRows = await db
    .select()
    .from(identityBlobs)
    .where(eq(identityBlobs.deviceId, device.balenaUuid));
  const bundle = blobRows.length > 0 ? (blobRows[0].bundle as { files: BundleFileLike[] } | null) : null;
  const files = bundle?.files ?? [];
  return { device, bundle, files, oldToken: bundleIdentityKey(files as never) };
}

async function loadBundle(
  db: NodePgDatabase,
  deviceId: string | null,
): Promise<{ files: BundleFileLike[]; blobVersion: number }> {
  if (deviceId === null) throw new RotationError('no_bundle', 'rotation has no target device', 409);
  const blobRows = await db
    .select()
    .from(identityBlobs)
    .where(eq(identityBlobs.deviceId, deviceId));
  if (blobRows.length === 0 || blobRows[0].bundle === null) {
    throw new RotationError('no_bundle', `device ${deviceId} has no bundle`, 409);
  }
  const bundle = blobRows[0].bundle as { files: BundleFileLike[] };
  return { files: bundle.files, blobVersion: blobRows[0].version };
}

/** Every OTHER enrolled device whose bundle references the agent. */
export async function referencingPeerDevices(
  db: NodePgDatabase,
  agentName: string,
  excludeDeviceId: string,
): Promise<Array<{ agent: string; uuid: string; files: BundleFileLike[]; a2a: Record<string, unknown> }>> {
  const rows = await db
    .select({ agent: devices.agentName, uuid: devices.balenaUuid, blob: identityBlobs.bundle })
    .from(devices)
    .innerJoin(identityBlobs, eq(identityBlobs.deviceId, devices.balenaUuid));
  const peers: Array<{ agent: string; uuid: string; files: BundleFileLike[]; a2a: Record<string, unknown> }> = [];
  for (const r of rows) {
    if (r.uuid === excludeDeviceId) continue;
    const bundle = r.blob as { files: BundleFileLike[] } | null;
    if (bundle === null) continue;
    const a2a = readA2aFromBundle(bundle.files as never);
    if (a2a === null) continue;
    const tokens = (a2a as Record<string, unknown>).peer_tokens;
    const trusted = (a2a as Record<string, unknown>).trusted_peers;
    const references =
      (typeof tokens === 'object' &&
        tokens !== null &&
        (tokens as Record<string, unknown>)[agentName] !== undefined) ||
      (Array.isArray(trusted) && trusted.includes(agentName));
    if (references) peers.push({ agent: r.agent, uuid: r.uuid, files: bundle.files, a2a: a2a as Record<string, unknown> });
  }
  return peers;
}

/** Merge spec that replaces a2a.json content and keeps everything else. */
function mergeSpecForA2aReplace(
  files: BundleFileLike[],
  nextA2a: string,
): {
  kind: 'merge';
  keep: Set<string>;
  updates: Map<string, string>;
  additions: never[];
} {
  return {
    kind: 'merge',
    keep: new Set(
      files.map((f) => f.path).filter((p) => p !== 'config/a2a.json'),
    ),
    updates: new Map([['config/a2a.json', nextA2a]] as never),
    additions: [],
  };
}

/** Read a KEY= value from the bundle's config/agent.env ('' when absent). */
export function bundledEnvValue(files: BundleFileLike[], key: string): string {
  const env = files.find((f) => f.path === 'config/agent.env');
  if (!env) return '';
  const content = env.encoding === 'base64' ? Buffer.from(env.content, 'base64').toString('utf8') : env.content;
  for (const line of content.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim();
  }
  return '';
}

/** Merge spec that updates exactly one env line, keeping every other file. */
function mergeSpecForEnvUpdate(
  files: BundleFileLike[],
  key: string,
  value: string,
): {
  kind: 'merge';
  keep: Set<string>;
  updates: Map<string, string>;
  additions: never[];
} {
  const env = files.find((f) => f.path === 'config/agent.env');
  const content = env
    ? env.encoding === 'base64'
      ? Buffer.from(env.content, 'base64').toString('utf8')
      : env.content
    : '';
  const prefix = `${key}=`;
  let replaced = false;
  const lines = content.split('\n').filter((l) => l !== '');
  const outLines = lines.map((l) => {
    if (l.startsWith(`${key}=`)) {
      replaced = true;
      return prefix + value;
    }
    return l;
  });
  if (!replaced) outLines.push(prefix + value);
  const nextEnv = `${outLines.join('\n')}\n`;
  return {
    kind: 'merge',
    keep: new Set(files.map((f) => f.path).filter((p) => p !== 'config/agent.env')),
    updates: new Map([['config/agent.env', nextEnv]] as never),
    additions: [],
  };
}

/**
 * The alias an agent's model key LIVES under right now: the newest
 * rotation's target alias (any status — a rotation in flight already owns
 * the future), else the base `model-<agent>` alias.
 */
async function currentModelAlias(db: NodePgDatabase, agentName: string): Promise<string> {
  const rows = await db
    .select()
    .from(credentialRotations)
    .where(eq(credentialRotations.agentName, agentName));
  let newest: RotationRecord | null = null;
  for (const r of rows) {
    if ((r as RotationRecord).kind !== 'model_key') continue;
    if (newest === null || (r as RotationRecord).id > newest.id) newest = r as RotationRecord;
  }
  return newest !== null ? newest.newAlias : `model-${agentName}`;
}

/**
 * Next free versioned mesh alias: `vs-<agent>-a2a-r<n>`, probing upward
 * when a suffix is already live at the gateway (never orphan, never reuse).
 */
async function freshMeshAlias(
  cfg: GatewayConfig,
  agentName: string,
  startN: number,
): Promise<string> {
  for (let n = startN; n < startN + 20; n++) {
    const candidate = `vs-${agentName}-a2a-r${n}`;
    // findKeyRow throws on transport failure (propagate), null on absent.
    const live = await findKeyRow(cfg, candidate);
    if (live === null) return candidate;
  }
  throw new RotationError('alias_live', `no free rotation alias for '${agentName}' after 20 probes`, 409);
}

/** Next free versioned model alias: `model-<agent>-r<n>`. */
async function freshModelAlias(
  cfg: GatewayConfig,
  agentName: string,
  startN: number,
): Promise<string> {
  for (let n = startN; n < startN + 20; n++) {
    const candidate = `model-${agentName}-r${n}`;
    const live = await findModelKeyToken(cfg, candidate);
    if (live === null) return candidate;
  }
  throw new RotationError('alias_live', `no free rotation alias for '${agentName}' after 20 probes`, 409);
}