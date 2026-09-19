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

export type RotateInput =
  | { kind: 'replace'; files: Array<{ path: string; mode: '0600'; content: string }> }
  | { kind: 'merge'; keep: Set<string>; updates: Map<string, string>; additions: Array<{ path: string; mode: '0600'; content: string }> };

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
  let files: Array<{ path: string; mode: '0600'; content: string }> = [];

  if (input.kind === 'replace') {
    files = input.files.map((f) => ({ path: f.path, mode: '0600', content: f.content }));
  } else {
    const byPath = new Map<string, { path: string; mode: '0600'; content: string }>();
    for (const f of current?.files ?? []) {
      if (input.keep.has(f.path)) {
        byPath.set(f.path, { path: f.path, mode: '0600', content: f.content });
      }
    }
    for (const [path, content] of input.updates) {
      byPath.set(path, { path, mode: '0600', content });
    }
    for (const f of input.additions) {
      byPath.set(f.path, { path: f.path, mode: '0600', content: f.content });
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