import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bundleReports, credentialRotations } from './db/schema.js';

/** Rotation kinds carried by the registry. */
export type RotationKind = 'a2a_identity' | 'model_key';

/**
 * Rotation lifecycle states (fleet-ops-1py.24):
 *   delivering → awaiting_target → awaiting_revoke → completed
 */
export type RotationStatus = 'delivering' | 'awaiting_target' | 'awaiting_revoke' | 'completed';

const OPEN_STATUSES: RotationStatus[] = ['delivering', 'awaiting_target', 'awaiting_revoke'];

/** The OPEN statuses (console visibility: rows that still need advancing). */
export const OPEN_ROTATION_STATUSES: readonly string[] = OPEN_STATUSES;

/** The OPEN rotation for one agent+kind, newest first; null when none. */
export async function findOpenRotationByAgent(
  db: NodePgDatabase,
  agentName: string,
  kind: RotationKind = 'a2a_identity',
): Promise<typeof credentialRotations.$inferSelect | null> {
  const rows = await db
    .select()
    .from(credentialRotations)
    .where(
      and(
        eq(credentialRotations.agentName, agentName),
        eq(credentialRotations.kind, kind),
        inArray(credentialRotations.status, OPEN_STATUSES),
      ),
    )
    .orderBy(desc(credentialRotations.id));
  return rows.length > 0 ? rows[0] : null;
}

/** Count of prior rotations for one agent+kind — drives versioned alias suffixes. */
export async function countPriorRotations(
  db: NodePgDatabase,
  agentName: string,
  kind: RotationKind,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(credentialRotations)
    .where(
      and(eq(credentialRotations.agentName, agentName), eq(credentialRotations.kind, kind)),
    );
  return Number(rows.length > 0 ? rows[0].n : 0);
}

/**
 * The device-confirmed applied bundle version — the deliver-then-revoke
 * confirmation channel (registrant /v1/bundle-applied + the guard-status
 * report's bundle_version mirror). Lower bound 0 when never reported.
 */
export async function appliedBundleVersion(
  db: NodePgDatabase,
  deviceId: string,
): Promise<number | null> {
  const rows = await db
    .select()
    .from(bundleReports)
    .where(eq(bundleReports.deviceId, deviceId));
  return rows.length > 0 ? rows[0].appliedVersion : null;
}