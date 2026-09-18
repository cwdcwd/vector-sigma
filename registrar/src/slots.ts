import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { deliverySlots } from './db/schema.js';

/** Transaction executor type (whatever db.transaction hands the callback). */
export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];
export type Executor = NodePgDatabase | Tx;

export type SlotStateValue = 'armed' | 'consumed';

export interface SlotSnapshot {
  state: SlotStateValue;
  deliveryCount: number;
  deliveredAt: Date | null;
  /** delivered_at + auto_rearm_after, computed in Postgres; null when never delivered. */
  rearmsAt: Date | null;
}

/**
 * Delivery slot state machine.
 *
 * Stored states: armed | consumed.
 * Effective state: a consumed slot whose re-arm window has elapsed reads
 * (and delivers) as armed — auto-rearm without a write. Delivery itself
 * is a single conditional UPDATE, which is the atomicity gate: under
 * concurrent bootstrap calls exactly one request flips the slot.
 */

export async function readSlot(db: Executor, deviceId: string): Promise<SlotSnapshot | null> {
  const rows = await db
    .select({
      state: deliverySlots.state,
      deliveryCount: deliverySlots.deliveryCount,
      deliveredAt: deliverySlots.deliveredAt,
      rearmsAt: sql<Date | null>`${deliverySlots.deliveredAt} + ${deliverySlots.autoRearmAfter}`,
    })
    .from(deliverySlots)
    .where(eq(deliverySlots.deviceId, deviceId));
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    state: r.state as SlotStateValue,
    deliveryCount: r.deliveryCount,
    deliveredAt: r.deliveredAt,
    rearmsAt: r.rearmsAt,
  };
}

/** Create a slot row (armed) if the device has none. Idempotent. */
export async function ensureSlot(db: Executor, deviceId: string): Promise<void> {
  await db.insert(deliverySlots).values({ deviceId }).onConflictDoNothing();
}

/**
 * Attempt to atomically consume the slot AT `now`.
 * Returns the new delivered_at + delivery_count on success, or null when
 * the slot is consumed and still inside its re-arm window.
 */
export async function consumeSlot(
  tx: Tx,
  deviceId: string,
  now: Date,
): Promise<{ deliveredAt: Date; deliveryCount: number } | null> {
  const rows = await tx
    .update(deliverySlots)
    .set({
      state: 'consumed',
      deliveredAt: now,
      deliveryCount: sql`${deliverySlots.deliveryCount} + 1`,
    })
    .where(
      and(
        eq(deliverySlots.deviceId, deviceId),
        or(
          eq(deliverySlots.state, 'armed'),
          and(
            eq(deliverySlots.state, 'consumed'),
            lte(sql`${deliverySlots.deliveredAt} + ${deliverySlots.autoRearmAfter}`, now),
          ),
        ),
      ),
    )
    .returning({
      deliveredAt: deliverySlots.deliveredAt,
      deliveryCount: deliverySlots.deliveryCount,
    });
  if (rows.length === 0) return null;
  const row = rows[0];
  return { deliveredAt: row.deliveredAt ?? now, deliveryCount: row.deliveryCount };
}

/** Effective state a caller observes at `now` (auto-rearm applied).
 *  Fail-secure: consumed with unknown rearm time stays consumed,
 *  mirroring consumeSlot's SQL (NULL delivered_at never satisfies
 *  the re-arm comparison). */
export function effectiveState(snapshot: SlotSnapshot, now: Date): SlotStateValue {
  if (snapshot.state === 'armed') return 'armed';
  if (snapshot.rearmsAt === null) return 'consumed';
  return now.getTime() < snapshot.rearmsAt.getTime() ? 'consumed' : 'armed';
}

/** Seconds until the slot delivers again; null when it is available now. */
export function retryAfterSeconds(snapshot: SlotSnapshot, now: Date): number | null {
  if (effectiveState(snapshot, now) === 'armed') return null;
  const ms = (snapshot.rearmsAt?.getTime() ?? now.getTime()) - now.getTime();
  return Math.max(1, Math.ceil(ms / 1000));
}