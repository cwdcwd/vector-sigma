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
  // pem_private_key / private_key_generic: require a real base64 body
  // between header and footer (see registrar/src/credential-scan/
  // patterns.ts for the full rationale) — a UI placeholder shape
  // (header + ellipsis/short filler + footer, zero real key material)
  // must not reject an otherwise-clean image layer that merely ships
  // that placeholder text (e.g. a baked copy of admin-html.ts).
  //
  // PR #61 review round 2 finding #2 (mirrored fix — identical
  // regression to credential-scan/patterns.ts): the line separator
  // between header/body/footer must accept EITHER a real newline/CRLF
  // run OR a literal backslash-n escape run (as JSON.stringify()
  // produces for a PEM stored in a config.json string value / a JSON
  // file baked into an image layer), or a real private key serialized
  // to JSON inside an image layer/config blob silently evades this
  // scanner while the identical raw multi-line PEM is caught.
  {
    name: 'pem_private_key',
    kind: 'secret',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----(?:[\r\n]+|(?:\\n)+)(?:(?:[^-\\\r\n]|\\(?!n))*(?:[\r\n]+|(?:\\n)+))*?[A-Za-z0-9+/]{20,}={0,2}(?:[\r\n]+|(?:\\n)+)(?:(?:[^-\\\r\n]|\\(?!n))*(?:[\r\n]+|(?:\\n)+))*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  { name: 'aws_access_key_id', kind: 'secret', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_token', kind: 'secret', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack_token', kind: 'secret', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'generic_api_key_assignment', kind: 'secret', regex: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{12,}['"]/i },
  {
    name: 'private_key_generic',
    kind: 'secret',
    regex:
      /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----(?:[\r\n]+|(?:\\n)+)(?:(?:[^-\\\r\n]|\\(?!n))*(?:[\r\n]+|(?:\\n)+))*?[A-Za-z0-9+/]{20,}={0,2}(?:[\r\n]+|(?:\\n)+)(?:(?:[^-\\\r\n]|\\(?!n))*(?:[\r\n]+|(?:\\n)+))*?-----END (?:ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: 'tailnet_magicdns_fqdn', kind: 'topology', regex: /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i },
  {
    name: 'rfc1918_private_ip',
    kind: 'topology',
    regex: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})\b/,
  },
];

// ---------------------------------------------------------------------------
// Narrow, content-aware allowlist for STABLE UPSTREAM files that ship their
// own illustrative/constant private-IP-shaped strings as part of their own
// stock distribution content — never a blanket "skip this path" or "skip
// comments/base-layers" rule (PR #61 review round 3 finding #1, live CI
// proof: CI run 38312045888, all 16 stage-and-scan jobs red).
//
// Two concrete entries, each reviewed and scoped to:
//   1. an EXACT (or suffix-matched) upstream file path, AND
//   2. a PROVENANCE check on the file's own text (distinctive upstream
//      markers that only the real stock file carries — not just any file
//      that happens to share the path), AND
//   3. a PER-OCCURRENCE context check on every individual RFC1918 match —
//      the match must sit in the EXACT shape the stock file uses (a
//      commented-out example line for access.conf; an argument to
//      IPv4Network(...)/IPv6Network(...) for ipaddress.py's own constant
//      definitions).
//
// An entry excuses a file ONLY when ALL THREE checks pass for EVERY
// RFC1918 occurrence in the file. A single occurrence that doesn't match
// the known-safe shape (e.g. an active/uncommented rule line, or a bare
// assignment outside an IPv4Network(...)/IPv6Network(...) call) makes the
// WHOLE allowlist lookup fail for that file, and the scan falls back to
// its normal fail-closed rejection — this is what the negative tests in
// oci-content-gate.test.ts prove: changing the SAME path's content to carry
// a deployment-specific private IP in a non-stock shape still rejects.
interface UpstreamAllowlistEntry {
  name: string;
  /** Path match, applied to the already-normalized (no leading `./`) entry path. */
  matchesPath: (path: string) => boolean;
  /**
   * Whole-file provenance check: distinctive content only the real
   * upstream file carries. Checked ONCE per file before any per-occurrence
   * check runs — if this fails, the path match alone proves nothing (a
   * same-named file in some other image with real deployed content) and
   * the allowlist does not apply at all.
   */
  verifyProvenance: (text: string) => boolean;
  /**
   * Per-occurrence check: is THIS SPECIFIC RFC1918 match sitting in the
   * exact shape the stock upstream file uses it in? Every match in the
   * file must pass this for the file to be excused.
   */
  isSafeOccurrence: (text: string, matchIndex: number) => boolean;
}

const RFC1918_PATTERN_SOURCE = PATTERNS.find((p) => p.name === 'rfc1918_private_ip')!.regex.source;

function linePrefixAt(text: string, matchIndex: number): string {
  const lineStart = text.lastIndexOf('\n', matchIndex - 1) + 1;
  return text.slice(lineStart, matchIndex);
}

const UPSTREAM_ALLOWLIST: UpstreamAllowlistEntry[] = [
  {
    // Upstream: linux-pam's pam_access module config file, shipped
    // verbatim by the distro package — generic, COMMENTED-OUT example
    // private-IP ranges exist as documentation in the stock file (see
    // https://github.com/linux-pam/linux-pam/blob/master/modules/pam_access/access.conf),
    // never a deployed Vector Sigma fleet endpoint. PR #61 review round
    // 3 finding #1(a): registrant image job 115019841988, layer 0.
    name: 'linux-pam-pam_access-access.conf',
    matchesPath: (p) => p === 'etc/security/access.conf' || p.endsWith('/etc/security/access.conf'),
    // The stock file's distinctive header text (verbatim in every
    // linux-pam release of this file) — a same-named file lacking this
    // exact upstream doc header is not proven to BE the stock file and
    // is not excused.
    verifyProvenance: (text) => text.includes('Login access control table') && text.includes('pam_access'),
    // Safe ONLY when the match sits on a COMMENTED-OUT line (the stock
    // file's example rules are all `#`-prefixed documentation, never
    // active). An uncommented rule line carrying a private IP is a real,
    // live access-control entry — i.e. deployed topology — and must
    // still reject.
    isSafeOccurrence: (text, matchIndex) => /^\s*#/.test(linePrefixAt(text, matchIndex)),
  },
  {
    // Upstream: CPython's OWN standard library module — defines
    // RFC1918/private-network range CONSTANTS as literal
    // IPv4Network(...)/IPv6Network(...) arguments, as part of its own
    // implementation (ipaddress.py's `_private_networks` list etc.),
    // never application/deployment config. PR #61 review round 3
    // finding #1(b): litellm image job 115019842022.
    name: 'cpython-ipaddress-stdlib',
    matchesPath: (p) => /(^|\/)python3\.\d+\/ipaddress\.py$/.test(p),
    // Distinctive class/constant names CPython's real ipaddress module
    // defines — a file at this path lacking ALL of these is not proven
    // to BE CPython's stdlib source and is not excused.
    verifyProvenance: (text) =>
      text.includes('class IPv4Address(_BaseV4, _BaseAddress):') &&
      text.includes('class IPv6Address(_BaseV6, _BaseAddress):') &&
      text.includes('_private_networks = ['),
    // Safe ONLY when the match is the literal argument to an
    // IPv4Network(...)/IPv6Network(...) constructor call — exactly how
    // CPython's own source embeds these range constants. A private-IP
    // string appearing ANYWHERE else in the file (e.g. a bare
    // assignment appended by a build step, carrying a real
    // deployment-specific address) does not match this shape and must
    // still reject.
    isSafeOccurrence: (text, matchIndex) => /IPv[46]Network\(\s*['"]$/.test(text.slice(Math.max(0, matchIndex - 40), matchIndex)),
  },
];

/**
 * Returns true only when EVERY RFC1918 occurrence in `text` is excused by
 * the SAME allowlist entry (provenance + per-occurrence shape both hold
 * for every match) — a single unsafe occurrence anywhere in the file
 * means the file is NOT excused and falls back to normal fail-closed
 * rejection.
 */
function isRfc1918FullyExcusedByAllowlist(path: string, text: string): boolean {
  for (const entry of UPSTREAM_ALLOWLIST) {
    if (!entry.matchesPath(path)) continue;
    if (!entry.verifyProvenance(text)) continue;
    const occurrenceRegex = new RegExp(RFC1918_PATTERN_SOURCE, 'g');
    let match: RegExpExecArray | null;
    let sawMatch = false;
    let allSafe = true;
    while ((match = occurrenceRegex.exec(text)) !== null) {
      sawMatch = true;
      if (!entry.isSafeOccurrence(text, match.index)) {
        allSafe = false;
        break;
      }
      if (match[0].length === 0) occurrenceRegex.lastIndex++; // guard against zero-width loop
    }
    if (sawMatch && allSafe) return true;
  }
  return false;
}

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
        // PR #61 review round 3 finding #1: a stable upstream file
        // whose ONLY RFC1918-shaped content is its own stock
        // illustrative/constant private-IP strings (verified narrow,
        // content-aware, NOT a blanket path bypass — see
        // UPSTREAM_ALLOWLIST above) is excused from this ONE pattern
        // only. Every other pattern (secrets, tailnet FQDNs) still
        // applies in full to the same file.
        if (pattern.name === 'rfc1918_private_ip' && isRfc1918FullyExcusedByAllowlist(entry.name, text)) {
          continue;
        }
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
