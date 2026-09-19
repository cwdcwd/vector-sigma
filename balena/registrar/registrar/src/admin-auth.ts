import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { adminKeys } from './db/schema.js';
import { verifyKey } from './db/key-crypto.js';
import { isDeviceKey } from './keys.js';
import type { AuthRateLimiter } from './rate-limit.js';

/**
 * Admin key verification shared by the console login and the owner API
 * routes (/v1/re-arm, /v1/rotate). Device keys (bk_ namespace) are
 * structurally rejected BEFORE any admin_keys lookup — role separation at
 * the prefix, so a device key can never authenticate as an admin.
 */

export type AdminKeyAuth =
  | { ok: true; keyId: number; label: string }
  | { ok: false; kind: 'no_key' | 'device_key' | 'locked' | 'bad_key'; locked?: number };

export async function verifyAdminKey(
  db: NodePgDatabase,
  presentedKey: string | null | undefined,
  limiter: AuthRateLimiter,
  ip: string,
): Promise<AdminKeyAuth> {
  if (presentedKey === null || presentedKey === undefined || presentedKey === '') {
    return { ok: false, kind: 'no_key' };
  }
  const locked = limiter.lockedRetryAfter(ip);
  if (locked !== null) {
    return { ok: false, kind: 'locked', locked };
  }
  if (isDeviceKey(presentedKey)) {
    limiter.recordFailure(ip);
    return { ok: false, kind: 'device_key' };
  }
  const rows = await db.select().from(adminKeys);
  for (const row of rows) {
    const ok = await verifyKey(row.hash, presentedKey).catch(() => false);
    if (ok) return { ok: true, keyId: Number(row.id), label: row.label };
  }
  limiter.recordFailure(ip);
  return { ok: false, kind: 'bad_key' };
}