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
/** Primus-scoped machine keys for the mesh-enroll action (fleet-ops-j7g.1). */
export const MESH_ENROLL_KEY_PREFIX = 'mk_';

/** Mint a fresh device bootstrap key. */
export function mintDeviceKey(): string {
  return `${DEVICE_KEY_PREFIX}${randomUUID()}`;
}

/** Mint a fresh admin key. */
export function mintAdminKey(): string {
  return `${ADMIN_KEY_PREFIX}${randomUUID()}`;
}

/** Mint a fresh mesh-enroll machine key (primus-scoped class). */
export function mintMeshEnrollKey(): string {
  return `${MESH_ENROLL_KEY_PREFIX}${randomUUID()}`;
}

/** Structurally a device key (prefix namespace). */
export function isDeviceKey(key: string): boolean {
  return key.startsWith(DEVICE_KEY_PREFIX);
}

/** Structurally an admin key (prefix namespace). */
export function isAdminKey(key: string): boolean {
  return key.startsWith(ADMIN_KEY_PREFIX);
}

/** Structurally a mesh-enroll machine key (prefix namespace). */
export function isMeshEnrollKey(key: string): boolean {
  return key.startsWith(MESH_ENROLL_KEY_PREFIX);
}