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
  // PR #61 review round 4 finding #3 (P2, lexical bug, fixed in the
  // regex itself — NOT via another allowlist file exception, which
  // would mask the defect): the ORIGINAL trailing `\b` boundary
  // matches a dotted-quad PREFIX of a longer dotted identifier,
  // because `\b` only asserts a word/non-word transition, and a `.`
  // immediately after the fourth octet is non-word on BOTH sides (a
  // dot is never a \w character), so `\b` is satisfied even though
  // MORE dotted-decimal content follows. CPython 3.13's own
  // Lib/random.py (upstream, verified at
  // https://github.com/python/cpython/blob/3.13/Lib/random.py)
  // contains the literal research citation
  // `https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.47.8407&rep=rep1&type=pdf`
  // — the OLD regex matched `10.1.1.47` out of that DOI
  // (`10.1.1.47.8407`) as a false-positive private IP, because it
  // never looked past the fourth octet to see the fifth
  // dot+digit-group continuing the real token.
  //
  // Fix: require a COMPLETE dotted-quad token — reject when the
  // match is immediately preceded OR followed by `.` + digit (i.e.
  // there's a FIFTH or ZEROTH octet-shaped component attached). This
  // is a narrow negative lookaround, not a narrower positive
  // character class, so real RFC1918 addresses immediately followed
  // by a non-dot character (a port number after `:`, a log-line
  // delimiter, end of string, etc.) still match in full — only a
  // CONTINUING dotted-decimal run on either side disqualifies the
  // match.
  {
    name: 'rfc1918_private_ip',
    kind: 'topology',
    regex:
      /\b(?<!\.\d)(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})\b(?!\.\d)/,
  },
];

// ---------------------------------------------------------------------------
// Narrow, content-aware allowlist for STABLE UPSTREAM files that ship their
// own illustrative/constant private-IP-shaped strings as part of their own
// stock distribution content — never a blanket "skip this path" or "skip
// comments/base-layers" rule (PR #61 review round 3 finding #1, live CI
// proof: CI run 38312045888, all 16 stage-and-scan jobs red).
//
// PR #61 review round 4 finding #1 (P1, SECURITY HOLE, owner-reproduced
// bypass): the round-3 design checked (a) path, (b) whole-file provenance
// markers, and (c) a PER-OCCURRENCE "shape" heuristic (comment-prefixed
// line for access.conf; IPv4Network(...)/IPv6Network(...) constructor
// argument for ipaddress.py). Provenance markers prove ANCESTRY/DERIVATION
// only — they do NOT prove the file is byte-identical/unmodified. The
// owner reproduced both: appending `# production database endpoint:
// 10.23.45.67` to an access.conf that still carries its provenance header
// passed (the new line is itself comment-shaped — the per-occurrence
// check has nothing to distinguish a REVIEWED stock comment from an
// ATTACKER-ADDED comment that merely mimics the same shape), and
// appending `PRODUCTION_NETWORK = IPv4Network('10.23.45.0/24')` to an
// ipaddress.py that still carries its class markers also passed (same
// defect: new occurrence, correct constructor shape, unreviewed real
// value). A per-occurrence SHAPE check can always be satisfied by an
// attacker who copies the accepted shape verbatim around a new value — it
// is not a security boundary.
//
// FIX (owner's explicit required direction — pin exact values, not a
// cleverer shape heuristic): every allowlist entry now carries a CLOSED
// SET of the exact literal RFC1918-shaped substrings that were actually
// reviewed in the real stock upstream file (`approvedOccurrences`). When
// scanning an allowlisted file, EVERY RFC1918 match's literal matched text
// must be a MEMBER of that file's approved set — an occurrence with the
// "right shape" but a literal value outside the reviewed set is NOT
// excused, and its presence rejects the WHOLE file (the allowlist does
// not partially excuse a file; one unreviewed value anywhere fails
// closed, exactly like round 3's per-file contract). This directly
// defeats the bypass: an appended line can reuse the exact accepted
// syntax, but it cannot reuse a literal value that was never reviewed,
// because that value is simply absent from the pinned set no matter how
// it's phrased.
//
// Mechanism choice — EXACT OCCURRENCE VALUES over WHOLE-FILE DIGESTS:
// both options satisfy the owner's requirement ("pin approved file
// content/digests OR exact reviewed occurrences and values"); exact
// occurrence-value pinning was chosen as more maintainable for these
// specific files because the reviewed private-IP strings here are IANA
// special-registry / RFC1918 example constants that are extremely stable
// across upstream releases (CPython's `_private_networks` list, PAM's
// doc example addresses, openssl.cnf's one proxy-example IP, npm's one
// CIDR-whitelist example IP) even as surrounding prose/comments/version
// numbers in the same file legitimately churn release to release. Whole
// -file digest pinning would force a mandatory allowlist-entry edit on
// every patch-level upstream bump (a new CPython 3.13.x point release
// with an unrelated bugfix elsewhere in ipaddress.py would otherwise trip
// a byte-identity check) — that is strictly worse ongoing maintenance
// burden for a scanner whose job is to recognize REVIEWED VALUES, not to
// pin an entire upstream project's release cadence. (Whole-file digest
// pinning remains the right call for a file whose SPECIFIC
// private-IP-shaped literals vary unpredictably release to release; none
// of the four entries below are in that category.)
//
// The (now secondary, defense-in-depth) per-occurrence shape check is
// still retained alongside the value pin — but it is no longer the
// security boundary by itself. The determining gate is: is this EXACT
// literal value in the reviewed closed set for this file? If not, reject
// — regardless of how innocuous the surrounding syntax looks.
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
   * CLOSED SET of exact literal matched substrings reviewed and approved
   * for this specific upstream file (e.g. the real IPv4 dotted-decimal
   * strings that appear in the pinned stock release). An occurrence
   * whose literal text is outside this set rejects the WHOLE file, even
   * when it matches every other accepted shape — this is the fix for
   * round-4 finding #1 (a shape-only check cannot distinguish a reviewed
   * stock occurrence from an attacker-appended one that copies the same
   * shape around a new, unreviewed value).
   */
  approvedOccurrences: ReadonlySet<string>;
  /**
   * Per-occurrence shape check (defense-in-depth, NOT the security
   * boundary by itself — see block comment above): is this match sitting
   * in the shape the stock file actually uses? Kept to catch a reviewed
   * VALUE reappearing in a clearly non-stock shape (e.g. the same real
   * constant also appended as a live, uncommented rule elsewhere in a
   * tampered file).
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
    // Round 4: literal values below were fetched and verified directly
    // against the real upstream file (master branch, fetched this
    // review round) — these are the ONLY four RFC1918-shaped strings
    // that exist anywhere in the real stock access.conf.
    name: 'linux-pam-pam_access-access.conf',
    matchesPath: (p) => p === 'etc/security/access.conf' || p.endsWith('/etc/security/access.conf'),
    // The stock file's distinctive header text (verbatim in every
    // linux-pam release of this file) — a same-named file lacking this
    // exact upstream doc header is not proven to BE the stock file and
    // is not excused.
    verifyProvenance: (text) => text.includes('Login access control table') && text.includes('pam_access'),
    approvedOccurrences: new Set(['192.168.200.1', '192.168.200.4', '192.168.200.9', '192.168.201.0']),
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
    // Round 4: literal values below were fetched and verified directly
    // against the real CPython 3.13 branch Lib/ipaddress.py — these are
    // the ONLY three RFC1918-pattern-matching IPv4 literals in the real
    // file's `_private_networks` list (the list also carries
    // 0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 192.0.0.0/24,
    // 192.0.0.170/31, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24,
    // 203.0.113.0/24, 240.0.0.0/4, 255.255.255.255/32 — none of those
    // match the rfc1918_private_ip pattern, so they never reach this
    // check at all).
    name: 'cpython-ipaddress-stdlib',
    matchesPath: (p) => /(^|\/)python3\.\d+\/ipaddress\.py$/.test(p),
    // Distinctive class/constant names CPython's real ipaddress module
    // defines — a file at this path lacking ALL of these is not proven
    // to BE CPython's stdlib source and is not excused.
    verifyProvenance: (text) =>
      text.includes('class IPv4Address(_BaseV4, _BaseAddress):') &&
      text.includes('class IPv6Address(_BaseV6, _BaseAddress):') &&
      text.includes('_private_networks = ['),
    approvedOccurrences: new Set(['10.0.0.0', '172.16.0.0', '192.168.0.0']),
    // Safe ONLY when the match is the literal argument to an
    // IPv4Network(...)/IPv6Network(...) constructor call — exactly how
    // CPython's own source embeds these range constants. A private-IP
    // string appearing ANYWHERE else in the file (e.g. a bare
    // assignment appended by a build step, carrying a real
    // deployment-specific address) does not match this shape and must
    // still reject.
    isSafeOccurrence: (text, matchIndex) => /IPv[46]Network\(\s*['"]$/.test(text.slice(Math.max(0, matchIndex - 40), matchIndex)),
  },
  {
    // Upstream: npm CLI's OWN shipped documentation page for `npm
    // token`, baked into every node image that ships npm
    // (usr/local/lib/node_modules/npm/docs/content/commands/npm-token.md)
    // — PR #61 review round 4 finding #2, newly discovered in the real
    // registrar image job. The doc's example `npm token list` output
    // table illustrates the `--cidr` IP-whitelist feature with a
    // single, long-stable placeholder example address, never a
    // deployed Vector Sigma endpoint.
    //
    // Verified directly (fetched this review round) against THREE real
    // npm release lines (npm@9.9.4, npm@10.8.2/10.9.3, npm@11.6.2 — the
    // CLI's doc content has been stable across major versions): all
    // three carry the identical example `192.168.0.1/24` and no other
    // RFC1918-shaped string anywhere in the file.
    name: 'npm-cli-npm-token-docs',
    matchesPath: (p) => p.endsWith('npm/docs/content/commands/npm-token.md'),
    // Distinctive content unique to this specific doc page — a
    // same-named file lacking these exact command/description strings
    // is not proven to BE npm's real shipped doc and is not excused.
    verifyProvenance: (text) =>
      text.includes('Manage your authentication tokens') &&
      text.includes('npm token revoke') &&
      text.includes('npm token create'),
    approvedOccurrences: new Set(['192.168.0.1']),
    // Safe ONLY inside the illustrative `npm token list`/table output
    // block (immediately preceded by "IP Whitelist:" or a bare
    // '|'-delimited CIDR table cell) — never a bare assignment/config
    // line, which would indicate a real deployment value was spliced
    // into the doc text.
    isSafeOccurrence: (text, matchIndex) => /(?:IP Whitelist:\s*|\|\s*)$/.test(text.slice(Math.max(0, matchIndex - 40), matchIndex)),
  },
  {
    // Upstream: OpenSSL's OWN example configuration file
    // (etc/ssl/openssl.cnf), shipped by the distro package and baked
    // into both the postgres and tailscale base images — PR #61 review
    // round 4 finding #2, newly discovered in the real CI image matrix.
    // See https://github.com/openssl/openssl/blob/master/apps/openssl.cnf
    // — the file's `[insta]` CMP-client example section documents a
    // generic illustrative HTTP proxy value in a comment, never a
    // deployed Vector Sigma endpoint.
    //
    // Verified directly (fetched this review round) against the real
    // openssl/openssl master branch apps/openssl.cnf: exactly one
    // RFC1918-shaped string exists in the entire file.
    name: 'openssl-example-openssl.cnf',
    matchesPath: (p) => p === 'etc/ssl/openssl.cnf' || p.endsWith('/etc/ssl/openssl.cnf'),
    // Distinctive content unique to OpenSSL's real stock example config
    // — a same-named file lacking these exact section/comment markers
    // is not proven to BE the real upstream file and is not excused.
    verifyProvenance: (text) =>
      text.includes('OpenSSL example configuration file') &&
      text.includes('[ CA_default ]') &&
      text.includes('[ req_distinguished_name ]'),
    approvedOccurrences: new Set(['192.168.1.1']),
    // Safe ONLY on a COMMENTED-OUT line (the stock file's proxy example
    // is `# proxy = ...`, never an active directive) — an uncommented
    // line carrying this value would be a real, live proxy
    // configuration, i.e. deployed topology, and must still reject.
    isSafeOccurrence: (text, matchIndex) => /^\s*#/.test(linePrefixAt(text, matchIndex)),
  },
];

/**
 * Returns true only when EVERY RFC1918 occurrence in `text` is excused by
 * the SAME allowlist entry — the occurrence's EXACT LITERAL VALUE must be
 * a member of that entry's reviewed `approvedOccurrences` set (the
 * closed-set fix for round-4 finding #1: a shape-correct but unreviewed
 * value is never excused, no matter how it's phrased), AND the
 * (secondary, defense-in-depth) per-occurrence shape check must also
 * hold. A single occurrence that fails either check anywhere in the file
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
      // Closed-set value pin FIRST: an occurrence whose literal text was
      // never reviewed for this file rejects the whole file regardless
      // of shape — this is the defense that actually stops the round-4
      // bypass (an appended line can mimic the accepted SHAPE, but it
      // cannot mimic membership in a set it was never added to).
      if (!entry.approvedOccurrences.has(match[0])) {
        allSafe = false;
        break;
      }
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
