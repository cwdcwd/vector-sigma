import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash } from 'node:crypto';

export interface HashParams {
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
}

/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). */
export const OWASP_HASH_PARAMS: HashParams = {
  memoryCostKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Hash a plaintext device/admin key with argon2id. Plaintext is never stored. */
export async function hashKey(key: string, params: HashParams = OWASP_HASH_PARAMS): Promise<string> {
  return argonHash(key, {
    algorithm: Algorithm.Argon2id,
    memoryCost: params.memoryCostKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

/** Constant-time argon2id verification of a presented key against a stored hash. */
export async function verifyKey(storedHash: string, presentedKey: string): Promise<boolean> {
  return argonVerify(storedHash, presentedKey);
}

/**
 * Short non-secret fingerprint of a presented key, for audit key_id only.
 * Reveals nothing reversible about the key itself.
 */
export function keyFingerprint(key: string | null | undefined): string | null {
  if (!key) return null;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}