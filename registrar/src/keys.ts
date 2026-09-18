import { randomUUID } from 'node:crypto';

/**
 * Key namespaces — structural role separation between device bootstrap keys
 * and admin keys. A key's role is readable from its prefix alone, which is
 * what makes structural rejection possible in the admin auth path: a device
 * key can never authenticate as an admin even in the presence of a hash
 * collision, because it is refused before any admin_keys lookup.
 */

export const DEVICE_KEY_PREFIX = 'bk_';
export const ADMIN_KEY_PREFIX = 'ak_';

/** Mint a fresh device bootstrap key. */
export function mintDeviceKey(): string {
  return `${DEVICE_KEY_PREFIX}${randomUUID()}`;
}

/** Mint a fresh admin key. */
export function mintAdminKey(): string {
  return `${ADMIN_KEY_PREFIX}${randomUUID()}`;
}

/** Structurally a device key (prefix namespace). */
export function isDeviceKey(key: string): boolean {
  return key.startsWith(DEVICE_KEY_PREFIX);
}

/** Structurally an admin key (prefix namespace). */
export function isAdminKey(key: string): boolean {
  return key.startsWith(ADMIN_KEY_PREFIX);
}