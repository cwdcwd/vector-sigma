import { describe, it, expect } from 'vitest';
import { hashKey, verifyKey, keyFingerprint, OWASP_HASH_PARAMS } from '../src/db/key-crypto.js';

describe('key-crypto', () => {
  it('hashKey produces argon2id and verifyKey round-trips', async () => {
    const key = 'bk_test-key-material-123';
    const h = await hashKey(key, { memoryCostKiB: 8192, timeCost: 1 });
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyKey(h, key)).toBe(true);
    expect(await verifyKey(h, 'bk_wrong')).toBe(false);
  });

  it('hash never contains the plaintext', async () => {
    const key = 'bk_super-secret-plaintext';
    const h = await hashKey(key, { memoryCostKiB: 8192, timeCost: 1 });
    expect(h).not.toContain(key);
    expect(h).not.toContain('super-secret');
  });

  it('OWASP params produce the standard argon2id prefix m=19456,t=2,p=1', async () => {
    const h = await hashKey('bk_x', OWASP_HASH_PARAMS);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('keyFingerprint: short, stable, null-safe', () => {
    expect(keyFingerprint('bk_abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint('bk_abc')).toBe(keyFingerprint('bk_abc'));
    expect(keyFingerprint('bk_abc')).not.toBe(keyFingerprint('bk_abd'));
    expect(keyFingerprint(null)).toBeNull();
    expect(keyFingerprint('')).toBeNull();
  });
});