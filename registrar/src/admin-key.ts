#!/usr/bin/env node
/**
 * Admin key minting CLI — the operator path for creating admin_keys rows.
 * Prints the plaintext key ONCE plus the argon2id hash and the SQL INSERT
 * to run against the registrar database. The plaintext is never stored.
 *
 * Usage: node dist/admin-key.js <label>
 */
import { fileURLToPath } from 'node:url';
import { hashKey } from './db/key-crypto.js';
import { mintAdminKey } from './keys.js';

/** A SQL string literal: single quotes doubled, so the operator's label can't break the INSERT. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The operator-facing output: the key (shown once), its hash, and the INSERT to run. */
export function renderAdminKeyOutput(key: string, hash: string, label: string): string {
  return [
    'Admin key (shown once, never stored — save it now):',
    `  ${key}`,
    '',
    'argon2id hash:',
    `  ${hash}`,
    '',
    'SQL INSERT for the registrar database:',
    `  INSERT INTO admin_keys (hash, label) VALUES (${sqlLiteral(hash)}, ${sqlLiteral(label)});`,
  ].join('\n');
}

/* v8 ignore start -- argv wiring only; the output is renderAdminKeyOutput (tested) */
async function main(): Promise<void> {
  const label = process.argv[2];
  if (!label) {
    console.error('usage: node dist/admin-key.js <label>');
    process.exit(1);
  }
  const key = mintAdminKey();
  const hash = await hashKey(key);
  console.log(renderAdminKeyOutput(key, hash, label));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
/* v8 ignore stop */
