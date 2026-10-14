/**
 * Credential-shaped text scanning (fleet-ops-1py.14 slice 6).
 *
 * Structural redaction guarantee: this function returns ONLY pattern
 * names (regex.test() booleans), never the matched substring itself.
 * There is no code path here that calls `.match()`, `.exec()`, or any
 * other API that would expose the matched text — by construction, a
 * caller of this module cannot leak a credential value even by
 * accident, because the value never exists as a JS value anywhere in
 * this module.
 */
import { CREDENTIAL_PATTERNS, type CredentialPatternName } from './patterns.js';

const BINARY_NULL_SNIFF_BYTES = 8000;

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_NULL_SNIFF_BYTES));
  return sample.includes(0);
}

/**
 * Scans one text blob and returns the set of credential pattern names
 * that matched, deduped. Never returns the matched substring, the
 * matched offset, or any other value derived from the credential text
 * itself.
 */
export function scanTextForCredentials(text: string): CredentialPatternName[] {
  const hits: CredentialPatternName[] = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.regex.test(text)) {
      hits.push(pattern.name);
    }
  }
  return hits;
}

/**
 * Scans raw bytes: skips binary content (NUL-byte sniff, matching the
 * slice-4 oci-gate secret-scan convention) and decodes as UTF-8 text
 * before scanning. Binary blobs are never decoded/scanned — this
 * avoids both false matches inside compiled binaries and wasted work,
 * and it means a credential embedded ONLY in binary bytes (e.g. an
 * already-compiled artifact) is out of scope for this text-shaped
 * scanner, same limitation the oci-gate scanner documents.
 */
export function scanBytesForCredentials(buf: Buffer): CredentialPatternName[] {
  if (buf.length === 0 || looksBinary(buf)) return [];
  return scanTextForCredentials(buf.toString('utf8'));
}
