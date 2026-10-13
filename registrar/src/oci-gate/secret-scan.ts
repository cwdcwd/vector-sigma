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
  //
  // PR #61 review round 5 finding #1, sub-bug (a) (P2, the round-4
  // left-boundary lookbehind was backwards): `(?<!\.\d)` checks for
  // "dot immediately followed by digit immediately before the match
  // start" — but that is the shape of a digit sitting right before
  // the match that is ITSELF preceded by a dot (i.e. it describes a
  // position two characters earlier, not the actual continuation
  // shape). The real continuation shape when a dotted-decimal run
  // precedes the match is "digit THEN dot" immediately before the
  // match start (e.g. in `42.10.1.1.47`, the characters immediately
  // before the matched `10.1.1.47` are `2` then `.` — a digit
  // followed by a dot, not a dot followed by a digit). The owner's
  // exact repro (`doi=42.10.1.1.47`) still matched on the suffix
  // `10.1.1.47` under the old lookbehind because `(?<!\.\d)` never
  // asserts anything about that shape. Fixed lookbehind:
  // `(?<!\d\.)` — reject when the match is immediately preceded by
  // "digit then dot" (a continuing left-hand dotted-decimal
  // component). Verified this does not affect real standalone IPs
  // preceded by non-digit, non-dot content (`=`, start-of-string,
  // whitespace, etc.) — see regression tests below.
  //
  // PR #61 review round 5 finding #1, sub-bug (b) (P2, unvalidated
  // octets): every octet position used an unconstrained `\d{1,3}`,
  // so an out-of-range value like `999`/`888`/`777` (e.g.
  // `10.999.888.777`) matched as if it were a syntactically valid
  // RFC1918 private IPv4 address. Fixed by replacing every `\d{1,3}`
  // octet group (in ALL THREE range alternatives — 10.x.x.x,
  // 172.16-31.x.x, 192.168.x.x) with a proper IPv4 octet pattern that
  // only matches the valid 0-255 range: `(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`
  // (250-255, 200-249, 100-199, and 0-99/single-or-double-digit,
  // covering the full valid octet range with no leading-zero
  // ambiguity beyond what `\d` already permits). The 172.16-31 range
  // alternative's SECOND component (`1[6-9]|2\d|3[01]`) was already a
  // correct, independently-reviewed range check for 16-31 and needed
  // no change — re-verified against both ends of the real RFC1918
  // boundary (172.15.x.x must NOT match, 172.16.x.x and 172.31.x.x
  // must match, 172.32.x.x must NOT match) in the regression tests.
  {
    name: 'rfc1918_private_ip',
    kind: 'topology',
    regex:
      /\b(?<!\d\.)(?:10\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){2}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|192\.168\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))\b(?!\.\d)/,
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
//
// PR #61 review round 5 finding #3 (P1): this exact-value-pinning
// architecture was originally hardcoded to the single `rfc1918_private_ip`
// pattern (both in the entry shape below — which had no notion of WHICH
// pattern it excused — and in the matching/lookup code, which always
// compiled `RFC1918_PATTERN_SOURCE`). npm's OWN `@npmcli/arborist`
// README.md documents its auth mechanism with a dummy illustrative
// credential (`token: 'deadbeefcafebad'`, verified directly against
// https://github.com/npm/cli/blob/latest/workspaces/arborist/README.md
// fetched this review round), which trips the `generic_api_key_assignment`
// SECRET pattern — a pattern this allowlist mechanism previously had no
// way to excuse at all, however narrowly and content-verified the
// exception.
//
// Fix: generalize the SAME architecture (path match + whole-file
// provenance + closed-set exact occurrence values + per-occurrence shape
// check, ALL must hold, fail-closed on any unlisted occurrence) to work
// for ANY named pattern — `patternName` is now a required field on every
// entry, and the lookup/match code below resolves the pattern's regex
// source by name instead of assuming RFC1918. This is a strict
// generalization: every existing RFC1918 entry keeps working unchanged
// (each one now just carries `patternName: 'rfc1918_private_ip'`
// explicitly), and the SAME safety properties apply uniformly whether the
// excused pattern is topology-shaped or secret-shaped — in particular the
// closed-set approvedOccurrences check is pattern-value-agnostic (it
// compares matched literal substrings of WHATEVER pattern regex applies),
// so a bypass attempt that replaces or appends a different credential-
// shaped value in the same allowlisted file still rejects, exactly like
// the RFC1918 bypass-proof tests from round 4 (see the arborist-specific
// regression tests below for the credential-pattern analogue).
interface UpstreamAllowlistEntry {
  name: string;
  /**
   * Which NAMED pattern (from PATTERNS above) this entry excuses. An
   * entry only ever excuses occurrences of THIS ONE pattern in the
   * matched file — every other pattern (including other secret/topology
   * patterns in the SAME file) is still scanned and enforced in full.
   */
  patternName: string;
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
   * strings that appear in the pinned stock release, or the real dummy
   * credential string the upstream doc ships). An occurrence whose
   * literal text is outside this set rejects the WHOLE file, even when
   * it matches every other accepted shape — this is the fix for
   * round-4 finding #1 (a shape-only check cannot distinguish a reviewed
   * stock occurrence from an attacker-appended one that copies the same
   * shape around a new, unreviewed value), now generalized to any
   * pattern class in round 5 finding #3.
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

function patternSourceByName(patternName: string): string {
  const pattern = PATTERNS.find((p) => p.name === patternName);
  if (!pattern) {
    throw new Error(`UPSTREAM_ALLOWLIST entry references unknown pattern name "${patternName}"`);
  }
  return pattern.regex.source;
}

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
    patternName: 'rfc1918_private_ip',
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
    patternName: 'rfc1918_private_ip',
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
    patternName: 'rfc1918_private_ip',
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
    patternName: 'rfc1918_private_ip',
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
  {
    // Upstream: the SAME OpenSSL example configuration file as the
    // entry above, but at its `.dist` TEMPLATE/distributed-copy path —
    // PR #61 review round 5 finding #2 (P1), real CI failure: postgres
    // job 115360971642, tailscale job 115360971607, path
    // `etc/ssl/openssl.cnf.dist`. Many distro package managers (ucf's
    // "distributed copy" convention on Debian/Ubuntu-derived images)
    // ship BOTH the active `openssl.cnf` AND an untouched `.dist`
    // backup/template copy so a local admin's edits to the active file
    // can be diffed against the pristine upstream original on upgrade.
    //
    // Verification honesty: unlike the other three entries in this
    // file (fetched and read byte-for-byte this round), the `.dist`
    // copy's content could NOT be independently fetched this round —
    // it is not addressable at a stable public URL (it is a
    // packaging-time artifact, not an upstream git blob), and
    // package-content search services (packages.debian.org contents
    // search) returned no match for this exact filename in the
    // reachable suites searched. The REASONED basis for this entry is
    // that ucf's `.dist` mechanism copies the SAME bytes the active
    // config file is initialized from (i.e. byte-identical to the
    // `etc/ssl/openssl.cnf` content already fetched and verified for
    // the sibling entry above) — so the SAME provenance markers and
    // the SAME one approved occurrence value apply. This is flagged
    // explicitly as REASONED, not fetched-and-verified, and should be
    // confirmed against the real live image bytes before being treated
    // as fully matrix-proven.
    name: 'openssl-example-openssl.cnf.dist',
    patternName: 'rfc1918_private_ip',
    matchesPath: (p) => p === 'etc/ssl/openssl.cnf.dist' || p.endsWith('/etc/ssl/openssl.cnf.dist'),
    verifyProvenance: (text) =>
      text.includes('OpenSSL example configuration file') &&
      text.includes('[ CA_default ]') &&
      text.includes('[ req_distinguished_name ]'),
    approvedOccurrences: new Set(['192.168.1.1']),
    isSafeOccurrence: (text, matchIndex) => /^\s*#/.test(linePrefixAt(text, matchIndex)),
  },
  {
    // Upstream: npm CLI's OWN RENDERED HTML output of the npm-token
    // doc page (npm's doc build converts
    // docs/content/commands/npm-token.md -> docs/output/commands/npm-token.html
    // as part of its own build pipeline) — PR #61 review round 5
    // finding #2 (P1), real CI failure: registrant job 115360971584,
    // registrar job 115360971826, path
    // `npm/docs/output/commands/npm-token.html`.
    //
    // Verified directly (fetched this review round) against the real
    // unpkg-served npm@10.8.2 rendered
    // docs/output/commands/npm-token.html: the rendered HTML preserves
    // the SAME `with IP Whitelist: 192.168.0.1/24` text VERBATIM inside
    // a `<pre><code>...</code></pre>` block — no HTML-entity encoding
    // applies to this particular substring (it contains no `<`, `>`,
    // `&`, or `"` characters), so the matched literal value is
    // identical to the .md source's. The SURROUNDING markup context is
    // different (rendered `<pre><code>` block vs. a markdown fenced
    // code block), which is why this is its own allowlist entry with
    // its own isSafeOccurrence shape check rather than reusing the .md
    // entry's.
    name: 'npm-cli-npm-token-docs-html',
    patternName: 'rfc1918_private_ip',
    matchesPath: (p) => p.endsWith('npm/docs/output/commands/npm-token.html'),
    // Distinctive content unique to this specific rendered doc page —
    // a same-named file lacking these exact strings is not proven to
    // BE npm's real shipped rendered doc and is not excused.
    verifyProvenance: (text) =>
      text.includes('Manage your authentication tokens') &&
      text.includes('npm token revoke') &&
      text.includes('npm token create') &&
      text.includes('<pre><code>'),
    approvedOccurrences: new Set(['192.168.0.1']),
    // Safe ONLY inside the illustrative rendered `<pre><code>` block
    // (immediately preceded by "IP Whitelist:" — the rendered HTML's
    // exact text shape for this example line) — never a bare
    // assignment/config line, which would indicate a real deployment
    // value was spliced into the rendered doc.
    isSafeOccurrence: (text, matchIndex) => /IP Whitelist:\s*$/.test(text.slice(Math.max(0, matchIndex - 40), matchIndex)),
  },
  {
    // Upstream: the Linux kernel's OWN uapi header
    // (usr/include/linux/bpf.h), shipped via linux-headers/libc6-dev
    // packages into glibc-based images — PR #61 review round 5
    // finding #2 (P1), real CI failure: agent job 115360971679, hermes
    // job 115360971589, path `usr/include/linux/bpf.h`.
    //
    // Verified directly (fetched this review round against
    // https://raw.githubusercontent.com/torvalds/linux/master/include/uapi/linux/bpf.h):
    // exactly ONE RFC1918-shaped string exists in the entire 7800+
    // line file — a doc-comment code EXAMPLE for the
    // bpf_skb_get_tunnel_key() helper's kernel-doc block, illustrating
    // a TC-ingress GRE-tunnel filter that drops packets whose remote
    // IPv4 address is anything OTHER than the illustrative constant
    // `10.0.0.1` (the comment also shows the same value as the hex
    // literal `0x0a000001` a few lines later — that form does not
    // match the dotted-decimal RFC1918 pattern and never reaches this
    // check). Never a deployed Vector Sigma endpoint — it is kernel
    // API usage documentation embedded in a C comment.
    name: 'linux-kernel-uapi-bpf-h',
    patternName: 'rfc1918_private_ip',
    matchesPath: (p) => p === 'usr/include/linux/bpf.h' || p.endsWith('/usr/include/linux/bpf.h'),
    // Distinctive content unique to the real kernel uapi bpf.h header —
    // a same-named file lacking these exact include-guard/doc markers
    // is not proven to BE the real upstream file and is not excused.
    verifyProvenance: (text) =>
      text.includes('_UAPI__LINUX_BPF_H__') && text.includes('bpf_skb_get_tunnel_key') && text.includes('enum bpf_prog_type {'),
    approvedOccurrences: new Set(['10.0.0.1']),
    // Safe ONLY inside the kernel-doc comment block illustrating the
    // tunnel-key helper (immediately preceded by "IPv4 address other
    // than" — the exact real wording of the real upstream comment
    // line) — never a bare assignment/config line, which would
    // indicate a real deployment value was spliced into the header.
    isSafeOccurrence: (text, matchIndex) => /IPv4 address other than\s*$/.test(text.slice(Math.max(0, matchIndex - 60), matchIndex)),
  },
  {
    // Upstream: CPython's OWN urllib/request.py stdlib module — PR #61
    // review round 5 finding #2 (P1), real CI failure: LiteLLM job
    // 115360971754, path `usr/lib/python3.13/urllib/request.py`.
    //
    // Verified directly (fetched this review round against
    // https://raw.githubusercontent.com/python/cpython/3.13/Lib/urllib/request.py):
    // exactly ONE RFC1918-shaped string exists in the entire 2800+
    // line file — inside `_proxy_bypass_winreg_override`'s docstring,
    // illustrating the Windows proxy-override registry value shape:
    // `"www.example.com;*.example.net; 192.168.0.1"`. Never a deployed
    // Vector Sigma endpoint — it is a docstring example of a
    // semicolon-delimited proxy-bypass override list format.
    name: 'cpython-urllib-request-stdlib',
    patternName: 'rfc1918_private_ip',
    matchesPath: (p) => /(^|\/)python3\.\d+\/urllib\/request\.py$/.test(p),
    // Distinctive content unique to the real CPython urllib/request.py
    // module — a same-named file lacking these exact function/class
    // markers is not proven to BE CPython's stdlib source and is not
    // excused.
    verifyProvenance: (text) =>
      text.includes('_proxy_bypass_winreg_override') && text.includes('class OpenerDirector:') && text.includes('def urlopen('),
    approvedOccurrences: new Set(['192.168.0.1']),
    // Safe ONLY inside the docstring's illustrative override-list
    // example string (quoted, semicolon-delimited, immediately
    // preceded by the real docstring's distinctive
    // "*.example.net; " prefix) — never a bare assignment/config
    // line, which would indicate a real deployment value was spliced
    // into the module.
    isSafeOccurrence: (text, matchIndex) => /\*\.example\.net;\s*$/.test(text.slice(Math.max(0, matchIndex - 60), matchIndex)),
  },
];

// ---------------------------------------------------------------------------
// PR #61 review round 5 finding #3: generalized GENERIC-SECRET exact-value
// exceptions, parallel to UPSTREAM_ALLOWLIST above but scoped to secret-shaped
// patterns (currently just `generic_api_key_assignment`). Same safety
// contract: path match + whole-file provenance + closed-set exact occurrence
// values + per-occurrence shape check, ALL must hold, fail-closed on any
// unlisted occurrence or shape mismatch. Reuses the SAME
// `UpstreamAllowlistEntry` shape and the SAME evaluation function
// (`isPatternFullyExcusedByAllowlist`) — the mechanism is pattern-name-keyed,
// not RFC1918-specific, so this is literally the same list the topology
// entries above live in, just with secret-pattern entries interleaved. Kept
// as a SEPARATE exported const purely for readability/navigation — code below
// merges it with UPSTREAM_ALLOWLIST for lookup.
const SECRET_PATTERN_ALLOWLIST: UpstreamAllowlistEntry[] = [
  {
    // Upstream: npm CLI's OWN `@npmcli/arborist` package README.md —
    // PR #61 review round 5 finding #3 (P1), real CI failure: scotty
    // image job 115360971609, layer 2. The README's USAGE example
    // documents the Arborist constructor's auth options with a dummy,
    // explicitly-labeled illustrative credential
    // (`token: 'deadbeefcafebad'`, with a second, duplicate-value
    // alias field `_authToken: 'deadbeefcafebad'` immediately below
    // it) — a long-standing, widely-recognized "obviously fake hex"
    // placeholder convention, never a real deployed Vector Sigma
    // secret.
    //
    // Verified directly (fetched this review round against
    // https://raw.githubusercontent.com/npm/cli/latest/workspaces/arborist/README.md):
    // the real file contains EXACTLY THREE occurrences of the generic
    // secret pattern in the USAGE options-object example — `token:
    // 'deadbeefcafebad'`, `_authToken: 'deadbeefcafebad'` (an alias for
    // the same dummy value), AND `password: 'bm90IG15IHJlYWwgcGFzc3dvcmQ9'`
    // (the base64 encoding of the literal string "not my real password",
    // itself a self-documenting dummy — the comment immediately above
    // it reads "username and base64 encoded password"). The adjacent
    // `auth: 'aXNhYWNz...'` line does NOT match the generic pattern at
    // all — `auth` is not one of the pattern's keyword alternatives
    // (api_key|secret|token|password) — so it never reaches this check.
    // All three real occurrences are pinned below; this is a genuinely
    // closed set for the whole real file, not a partial list.
    name: 'npmcli-arborist-readme-dummy-token',
    patternName: 'generic_api_key_assignment',
    matchesPath: (p) => p.endsWith('@npmcli/arborist/README.md') || p.endsWith('npmcli/arborist/README.md'),
    // Distinctive content unique to this specific README — a
    // same-named file lacking these exact section/usage markers is
    // not proven to BE npm's real shipped README and is not excused.
    verifyProvenance: (text) =>
      text.includes('Inspect and manage `node_modules` trees.') &&
      text.includes('new Arborist({') &&
      text.includes('loadActual'),
    approvedOccurrences: new Set([
      "token: 'deadbeefcafebad'",
      "_authToken: 'deadbeefcafebad'",
      "password: 'bm90IG15IHJlYWwgcGFzc3dvcmQ9'",
    ]),
    // Safe ONLY inside the USAGE code fence's options-object literal
    // — each of the three approved occurrences sits on a line
    // immediately preceded (within the same options object) by its
    // real documented comment ("an npm auth token", "an alias for the
    // same thing", "username and base64 encoded password") or by the
    // sibling `token:`/`username:` line directly above it. Defense-in-
    // depth on top of the value pin; a same-valued occurrence
    // appearing OUTSIDE the documented options object (e.g. spliced in
    // as a real top-level assignment elsewhere in the file) would not
    // match this shape and must still reject — proven by the
    // regression test below.
    isSafeOccurrence: (text, matchIndex) => {
      const before = text.slice(Math.max(0, matchIndex - 400), matchIndex);
      return (
        /\bregistry:\s*'https:\/\/registry\.npmjs\.org'/.test(before) ||
        /token:\s*'deadbeefcafebad',\s*$/.test(before) ||
        /username:\s*'isaacs',\s*$/.test(before)
      );
    },
  },
];


/**
 * Returns true only when EVERY occurrence of `patternName` in `text` is
 * excused by the SAME allowlist entry — the occurrence's EXACT LITERAL
 * VALUE must be a member of that entry's reviewed `approvedOccurrences`
 * set (the closed-set fix for round-4 finding #1: a shape-correct but
 * unreviewed value is never excused, no matter how it's phrased), AND the
 * (secondary, defense-in-depth) per-occurrence shape check must also
 * hold. A single occurrence that fails either check anywhere in the file
 * means the file is NOT excused and falls back to normal fail-closed
 * rejection.
 *
 * Generalized in PR #61 review round 5 finding #3: this used to be named
 * `isRfc1918FullyExcusedByAllowlist` and hardcoded both the pattern name
 * ('rfc1918_private_ip') and the allowlist it searched (UPSTREAM_ALLOWLIST
 * only). It now takes `patternName` as a parameter, resolves ONLY entries
 * whose own `entry.patternName` matches (so an RFC1918-scoped entry can
 * never accidentally excuse a secret-pattern occurrence or vice versa),
 * and searches the combined allowlist (topology + secret entries) — the
 * safety contract (path + provenance + closed-set value pin + shape
 * check, ALL required) is identical regardless of which pattern class is
 * being excused.
 */
const ALL_ALLOWLIST_ENTRIES: UpstreamAllowlistEntry[] = [...UPSTREAM_ALLOWLIST, ...SECRET_PATTERN_ALLOWLIST];

function isPatternFullyExcusedByAllowlist(patternName: string, path: string, text: string): boolean {
  const patternSource = patternSourceByName(patternName);
  for (const entry of ALL_ALLOWLIST_ENTRIES) {
    if (entry.patternName !== patternName) continue;
    if (!entry.matchesPath(path)) continue;
    if (!entry.verifyProvenance(text)) continue;
    const occurrenceRegex = new RegExp(patternSource, 'g');
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
        // PR #61 review round 3 finding #1 (topology) / round 5 finding
        // #3 (secrets): a stable upstream file whose ONLY
        // pattern-shaped content for THIS pattern is its own stock
        // illustrative/constant/dummy value (verified narrow,
        // content-aware, NOT a blanket path bypass — see
        // UPSTREAM_ALLOWLIST / SECRET_PATTERN_ALLOWLIST above) is
        // excused from this ONE pattern only, for the files explicitly
        // reviewed and pinned. Every other pattern in the PATTERNS
        // list still applies in full to the same file — only an
        // exact-value-pinned, provenance-verified entry for THIS
        // specific pattern name can excuse an occurrence.
        if (isPatternFullyExcusedByAllowlist(pattern.name, entry.name, text)) {
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
