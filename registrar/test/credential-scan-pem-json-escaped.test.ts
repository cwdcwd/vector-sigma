/**
 * PR #61 review round 2 — finding #2 regression tests (fleet-ops-1py.14,
 * review round 2 by cwdcwd on commit 2f070ad).
 *
 * Round-1's pem_private_key fix (requiring a real base64 body between
 * header/footer, separated by REAL newlines) correctly rejected the
 * admin-html.ts non-secret PEM textarea placeholder. It also, as a
 * side effect, stopped detecting a REAL private key when it is stored
 * as a JSON STRING VALUE: `JSON.stringify({ private_key: pem })`
 * serializes every real newline in `pem` as the two-character escape
 * sequence `\n` (a literal backslash followed by the letter n), never
 * an actual CR/LF byte, so the round-1 regex (which only matched real
 * `[\r\n]+` as the line separator) silently matched nothing against
 * the JSON-serialized form while still matching the raw multi-line
 * PEM.
 *
 * This file uses a FRESHLY GENERATED, disposable, never-used Ed25519
 * PKCS#8 key (via Node's crypto.generateKeyPairSync, generated fresh
 * inside this test file — never a real/production key) to prove:
 *   (a) the raw multi-line PEM is still detected (no regression),
 *   (b) the JSON.stringify'd single-line escaped-newline PEM is NOW
 *       detected (this is the regression fix under test),
 *   (c) the admin-html.ts placeholder still passes (no false positive)
 *       in both its raw form and a JSON-serialized form.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scanTextForCredentials } from '../src/credential-scan/scan-text.js';

function generateDisposablePemPkcs8(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

describe('pem_private_key: detects PEM content across BOTH real-newline and JSON-escaped-newline (\\n) representations (PR #61 review round 2 finding #2)', () => {
  const disposablePem = generateDisposablePemPkcs8();
  const placeholderShape = '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----';

  it('(a) raw multi-line PEM (real CR/LF newlines) is still detected — no regression', () => {
    expect(disposablePem.includes('\n')).toBe(true);
    expect(scanTextForCredentials(disposablePem)).toContain('pem_private_key');
  });

  it('(b) JSON.stringify of the SAME disposable key (escaped \\n, single line) is NOW detected — the regression this fixes', () => {
    const jsonSerialized = JSON.stringify({ private_key: disposablePem });
    // Sanity: confirm this really is the single-line, escaped-newline shape (no real newline bytes survive JSON.stringify).
    expect(jsonSerialized.includes('\n')).toBe(false);
    expect(jsonSerialized.includes('\\n')).toBe(true);
    expect(
      scanTextForCredentials(jsonSerialized),
      'JSON.stringify of a real PEM must still be flagged as pem_private_key — this was the round-2 regression (zero findings)',
    ).toContain('pem_private_key');
  });

  it('(b-cont) the escaped-newline shape is detected even nested inside a larger JSON document', () => {
    const jsonDoc = JSON.stringify({ kind: 'config', payload: { private_key: disposablePem, other_field: 'unrelated' } });
    expect(scanTextForCredentials(jsonDoc)).toContain('pem_private_key');
  });

  it('(c) the admin-html.ts placeholder (raw form) still passes — no false positive', () => {
    expect(scanTextForCredentials(placeholderShape)).not.toContain('pem_private_key');
  });

  it('(c-cont) the admin-html.ts placeholder, JSON-serialized the same way a real key would be, still passes — no false positive in either representation', () => {
    // placeholderShape embeds real newlines (like the actual admin-html.ts
    // source constant), so JSON.stringify legitimately escapes them to
    // literal \n — this IS the JSON-escaped-newline shape, with zero
    // real base64 body, and must still NOT be flagged.
    const jsonSerializedPlaceholder = JSON.stringify({ github_app_pem: placeholderShape });
    expect(jsonSerializedPlaceholder.includes('\\n')).toBe(true);
    expect(scanTextForCredentials(jsonSerializedPlaceholder)).not.toContain('pem_private_key');
  });

  it('a CRLF-style (\\r\\n) raw PEM is also detected (Windows-style line endings, not just \\n)', () => {
    const crlfPem = disposablePem.replace(/\n/g, '\r\n');
    expect(scanTextForCredentials(crlfPem)).toContain('pem_private_key');
  });
});
