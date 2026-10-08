import { eq } from 'drizzle-orm';
import type { Executor, Tx } from './slots.js';
import { deliverySlots, devices, identityBlobs } from './db/schema.js';
import { ensureSlot } from './slots.js';
import { audit } from './audit.js';
import { BundleFileSchema, type IdentityBundle } from '@vector-sigma/shared';
import type { Clock } from './clock.js';

/**
 * Owner operations shared by the REST API (/v1/rotate, /v1/re-arm) and the
 * admin console — the "one code path" the spec demands: bundle saves from
 * the console and POST /v1/rotate cannot drift because they execute the
 * same core here.
 */

/**
 * A bundle file as the rotate plane carries it (fleet-ops-1py.5): encoding
 * rides along so a merge/replace never strips binary payloads back to their
 * base64 text. Every site that reconstructs a file MUST spread the source
 * entry (or copy encoding explicitly) — picked-keys `{path, mode, content}`
 * is the corruption class this lane closes.
 */
export type RotateFile = { path: string; mode: '0600'; content: string; encoding?: 'base64' };

export type RotateInput =
  | { kind: 'replace'; files: RotateFile[] }
  | { kind: 'merge'; keep: Set<string>; updates: Map<string, string>; additions: RotateFile[] };

export interface RotateResult {
  bundle: IdentityBundle;
  version: number;
  slotState: string;
  deliveryCount: number;
}

/** Parse and normalize console form fields into a rotate input. */
export function parseConsoleFiles(fields: {
  existing_paths: string[];
  existing_contents: string[];
  new_paths: string[];
  new_contents: string[];
  /**
   * Structured-editor rendered canonicals (f57.11): full-content updates
   * that join the same merge as existing-file content updates. The admin
   * route has already resolved raw-upload-vs-rendered precedence (raw
   * same-path upload wins), so this list carries only the effective
   * renders. Text-only by construction (structured-fields.ts renders no
   * binary) — encoding stays unset.
   */
  structured_updates?: Array<{ path: string; mode: '0600'; content: string }>;
}): RotateInput {
  const keep = new Set<string>();
  const updates = new Map<string, string>();
  for (let i = 0; i < fields.existing_paths.length; i++) {
    const path = fields.existing_paths[i];
    const content = fields.existing_contents[i] ?? '';
    if (content.trim() === '') {
      keep.add(path); // blank = keep existing secret
    } else {
      updates.set(path, content);
    }
  }
  // Rendered canonicals: update semantics (replace whole file), same map.
  for (const f of fields.structured_updates ?? []) {
    updates.set(f.path, f.content);
  }
  const additions: Array<{ path: string; mode: '0600'; content: string }> = [];
  for (let i = 0; i < fields.new_paths.length; i++) {
    const path = fields.new_paths[i];
    const content = fields.new_contents[i] ?? '';
    if (path.trim() !== '' && content.trim() !== '') {
      additions.push({ path, mode: '0600', content });
    }
  }
  return { kind: 'merge', keep, updates, additions };
}

/** Build the next bundle from an input and the current bundle. */
export function buildNextBundle(
  current: IdentityBundle | null,
  input: RotateInput,
  now: Date,
): { bundle: IdentityBundle; version: number } {
  const version = (current?.bundle_version ?? 0) + 1;
  let files: RotateFile[] = [];

  if (input.kind === 'replace') {
    // Spread, not picked keys: a replace input that already carries
    // encoding (REST /v1/rotate, 1py.5) keeps it through the rebuild —
    // with mode re-pinned to the plane's fixed literal (rotate owns
    // mode; only per-file DATA rides the spread).
    files = input.files.map((f) => ({ ...f, mode: '0600' as const }));
  } else {
    const byPath = new Map<string, RotateFile>();
    for (const f of current?.files ?? []) {
      if (input.keep.has(f.path)) {
        // 1py.5 carry-through: the kept entry is spread whole so a merge
        // (structured save, mint-memory-keys, console raw save) never
        // strips encoding off a kept binary file — the logo corruption
        // class this lane closes. Mode is re-pinned to the plane's fixed
        // literal: rotate OWNS mode (pre-1py.5 rebuilds normalized it —
        // the contract mesh-enroll's seeded blobs and any legacy row
        // rely on), while per-file data (encoding) rides the spread.
        byPath.set(f.path, { ...f, mode: '0600' as const });
      }
    }
    for (const [path, content] of input.updates) {
      byPath.set(path, { path, mode: '0600', content });
    }
    for (const f of input.additions) {
      byPath.set(f.path, { ...f, mode: '0600' as const });
    }
    files = [...byPath.values()];
  }

  if (files.length === 0) throw new EmptyBundleError();
  const parsed = BundleFileSchema.array().min(1).safeParse(files);
  if (!parsed.success) throw new InvalidBundleError(parsed.error.issues[0]?.message ?? 'invalid');

  const bundle: IdentityBundle = {
    schema_version: 1,
    bundle_version: version,
    generated_at: now.toISOString(),
    files,
  };
  return { bundle, version };
}

export class EmptyBundleError extends Error {
  constructor() {
    super('bundle must contain at least one file');
  }
}
export class InvalidBundleError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The single rotate core: validate → version bump → upsert blob → arm slot
 * → audit. Used by both POST /v1/rotate (replace) and console bundle save
 * (merge). Atomic in one transaction: the bundle write, the slot arming,
 * and the audit row land together or not at all.
 */
export async function rotateBundle(
  db: Executor,
  clock: Clock,
  deviceId: string,
  input: RotateInput,
  auditOpts?: { keyId?: string | null; sourceIp?: string | null; reason?: string },
): Promise<RotateResult> {
  const now = clock.now();

  return db.transaction(async (tx) => {
    const blobs = await tx.select().from(identityBlobs).where(eq(identityBlobs.deviceId, deviceId));
    const current: IdentityBundle | null = blobs.length > 0 ? (blobs[0].bundle as IdentityBundle) : null;
    const { bundle, version } = buildNextBundle(current, input, now);

    await tx
      .insert(identityBlobs)
      .values({ deviceId, bundle, version, updatedAt: now })
      .onConflictDoUpdate({
        target: identityBlobs.deviceId,
        set: { bundle, version, updatedAt: now },
      });

    const result = await armSlot(tx, deviceId);
    // Audit inside the transaction — atomic with the bundle write.
    await audit(tx, {
      deviceId,
      outcome: 'admin',
      reason: auditOpts?.reason ?? 'bundle_rotated',
      keyId: auditOpts?.keyId ?? null,
      sourceIp: auditOpts?.sourceIp ?? null,
      occurredAt: now,
    });

    return { bundle, version, slotState: result.state, deliveryCount: result.deliveryCount };
  });
}

/**
 * Explicit re-arm: flip a consumed slot back to armed, preserving the
 * delivery counter and prior delivered_at. Shared by POST /v1/re-arm and
 * the console re-arm action.
 */
export async function rearmSlot(db: Executor, deviceId: string): Promise<boolean> {
  const rows = await db
    .update(deliverySlots)
    .set({ state: 'armed' })
    .where(eq(deliverySlots.deviceId, deviceId))
    .returning({ deliveryCount: deliverySlots.deliveryCount });
  if (rows.length === 0) {
    // No slot row yet: create one (armed). Device must exist.
    const dev = await db.select().from(devices).where(eq(devices.balenaUuid, deviceId));
    if (dev.length === 0) return false;
    await ensureSlot(db, deviceId);
    return true;
  }
  return true;
}

/** Arm the slot inside an active transaction. */
async function armSlot(tx: Tx, deviceId: string): Promise<{ state: string; deliveryCount: number }> {
  const rows = await tx
    .update(deliverySlots)
    .set({ state: 'armed' })
    .where(eq(deliverySlots.deviceId, deviceId))
    .returning({ state: deliverySlots.state, deliveryCount: deliverySlots.deliveryCount });
  if (rows.length === 0) {
    await ensureSlot(tx, deviceId);
    return { state: 'armed', deliveryCount: 0 };
  }
  return { state: rows[0].state, deliveryCount: rows[0].deliveryCount };
}