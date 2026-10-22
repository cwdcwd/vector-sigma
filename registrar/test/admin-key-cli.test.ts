/**
 * The admin-key minting CLI (src/admin-key.ts): the operator copies its INSERT into psql, so the
 * label must never be able to break out of its SQL string literal.
 */
import { describe, expect, it } from 'vitest';
import { renderAdminKeyOutput, sqlLiteral } from '../src/admin-key.js';
import { isAdminKey, isDeviceKey, mintAdminKey, mintMeshEnrollKey } from '../src/keys.js';

describe('admin-key CLI output', () => {
  it('prints the key once, its hash, and an INSERT carrying both', () => {
    const out = renderAdminKeyOutput('ak_example', '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', 'ops laptop');
    expect(out.match(/ak_example/g)).toHaveLength(1);
    expect(out).toContain("INSERT INTO admin_keys (hash, label) VALUES ('$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', 'ops laptop');");
  });

  it("escapes a quote in the label instead of ending the literal", () => {
    const out = renderAdminKeyOutput('ak_x', 'h', "o'brien'); DROP TABLE admin_keys; --");
    expect(out).toContain("VALUES ('h', 'o''brien''); DROP TABLE admin_keys; --');");
  });

  it.each([
    ['plain', 'plain', "'plain'"],
    ['empty', '', "''"],
    ['only quotes', "''", "''''''"],
    ['backslash is not an escape in standard SQL', 'a\\b', "'a\\b'"],
  ])('sqlLiteral: %s', (_label, input, expected) => {
    expect(sqlLiteral(input)).toBe(expected);
  });
});

describe('key namespaces', () => {
  it('admin and mesh-enroll keys carry distinct prefixes and are never device keys', () => {
    const admin = mintAdminKey();
    const mesh = mintMeshEnrollKey();
    expect(isAdminKey(admin)).toBe(true);
    expect(isAdminKey(mesh)).toBe(false);
    expect(isDeviceKey(admin)).toBe(false);
    expect(isDeviceKey(mesh)).toBe(false);
    expect(mintAdminKey()).not.toBe(admin);
  });
});
