import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { deliveryLog } from './db/schema.js';
import type { Executor } from './slots.js';

export type AuditOutcome = 'delivered' | 'denied' | 'admin';

export interface AuditEntry {
  deviceId: string | null;
  outcome: AuditOutcome;
  reason?: string;
  keyId?: string | null;
  sourceIp?: string | null;
  occurredAt?: Date;
}

/**
 * Append one audit row. Every request outcome writes exactly one row;
 * denials carry a reason; secrets never reach this table.
 */
export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  const exec = db as unknown as NodePgDatabase;
  await exec.insert(deliveryLog).values({
    deviceId: entry.deviceId,
    outcome: entry.outcome,
    reason: entry.reason ?? null,
    keyId: entry.keyId ?? null,
    sourceIp: entry.sourceIp ?? null,
    occurredAt: entry.occurredAt ?? new Date(),
  });
}