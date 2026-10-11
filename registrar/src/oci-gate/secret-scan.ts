/**
 * Secret + topology scanning of raw layer byte streams (fleet-ops-1py.14
 * slice 4). Scans RAW layer content (file bytes, as seen in the tar,
 * including whiteout-deleted entries) — never a merged/filtered
 * filesystem view — because a secret committed in a lower layer and
 * "deleted" by a later layer's whiteout is still present in the
 * published image's blobs and still exfiltrable.
 *
 * Pattern classes:
 *  - secret-shaped: common credential/key formats (private key PEM
 *    headers, AWS access keys, generic high-entropy API-key-looking
 *    assignments, GitHub tokens, Slack tokens).
 *  - topology literal: live tailnet/MagicDNS FQDNs (<host>.<tailnet>.ts.net,
 *    same class fleet-ops-1py.14 slices 1-3 already sanitize in
 *    fleet-ops composes/docs/source) and RFC1918 private IPv4
 *    addresses.
 */
import type { LayerEntry } from './layer-walk.js';
import { ContentGateError } from './errors.js';

export interface ScanFinding {
  kind: 'secret' | 'topology';
  pattern: string;
  path: string;
  layerIndex: number;
  layerDigest: string;
  deleted: boolean;
}

interface NamedPattern {
  name: string;
  kind: 'secret' | 'topology';
  regex: RegExp;
}

const PATTERNS: NamedPattern[] = [
  { name: 'pem_private_key', kind: 'secret', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'aws_access_key_id', kind: 'secret', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_token', kind: 'secret', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack_token', kind: 'secret', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'generic_api_key_assignment', kind: 'secret', regex: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{12,}['"]/i },
  { name: 'private_key_generic', kind: 'secret', regex: /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'tailnet_magicdns_fqdn', kind: 'topology', regex: /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i },
  {
    name: 'rfc1918_private_ip',
    kind: 'topology',
    regex: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})\b/,
  },
];

const BINARY_NULL_SNIFF_BYTES = 8000;

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_NULL_SNIFF_BYTES));
  return sample.includes(0);
}

/**
 * Scans every regular-file entry's raw bytes (text files only — binary
 * blobs are skipped by a NUL-byte sniff, matching standard secret-scan
 * practice; this avoids false "matches" inside compiled binaries while
 * still catching secrets baked into any text/script/config file,
 * REGARDLESS of whiteout-deletion status). Throws a ContentGateError
 * fail-closed on the FIRST finding — the gate rejects the whole build,
 * it does not attempt partial remediation.
 */
export function scanLayersForSecretsAndTopology(entries: LayerEntry[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const entry of entries) {
    if (entry.isWhiteoutMarker) continue;
    if (entry.type !== '0' && entry.type !== '\0') continue;
    if (entry.data.length === 0) continue;
    if (looksBinary(entry.data)) continue;

    const text = entry.data.toString('utf8');
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(text)) {
        findings.push({
          kind: pattern.kind,
          pattern: pattern.name,
          path: entry.name,
          layerIndex: entry.layerIndex,
          layerDigest: entry.layerDigest,
          deleted: entry.deleted,
        });
      }
    }
  }
  return findings;
}

/** Scans and throws fail-closed on the first finding (secret or topology). */
export function assertNoSecretsOrTopologyLiterals(entries: LayerEntry[]): void {
  const findings = scanLayersForSecretsAndTopology(entries);
  if (findings.length === 0) return;
  const first = findings[0]!;
  const code = first.kind === 'secret' ? 'secret_found' : 'topology_literal_found';
  throw new ContentGateError(
    code,
    `content gate rejected: ${first.kind} pattern "${first.pattern}" found at "${first.path}" in layer[${first.layerIndex}] ${first.layerDigest}` +
      (first.deleted ? ' (path is whiteout-deleted in the merged view — still present in published layer bytes)' : ''),
    findings,
  );
}
