#!/usr/bin/env node
/**
 * Admin key minting CLI — the operator path for creating admin_keys rows.
 * Prints the plaintext key ONCE plus the argon2id hash and the SQL INSERT
 * to run against the registrar database. The plaintext is never stored.
 *
 * Usage: node dist/admin-key.js <label>
 */
import { hashKey } from './db/key-crypto.js';
import { mintAdminKey } from './keys.js';

async function main(): Promise<void> {
  const label = process.argv[2];
  if (!label) {
    console.error('usage: node dist/admin-key.js <label>');
    process.exit(1);
  }
  const key = mintAdminKey();
  const hash = await hashKey(key);
  console.log('Admin key (shown once, never stored — save it now):');
  console.log(`  ${key}`);
  console.log('');
  console.log('argon2id hash:');
  console.log(`  ${hash}`);
  console.log('');
  console.log('SQL INSERT for the registrar database:');
  console.log(`  INSERT INTO admin_keys (hash, label) VALUES ('${hash}', '${label}');`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});