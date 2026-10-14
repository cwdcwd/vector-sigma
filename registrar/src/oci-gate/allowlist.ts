/**
 * Real-image allowlist evaluation (fleet-ops-1py.14, image-content-gate round 6 —
 * the full-registry-sweep rebuild of the upstream allowlist).
 *
 * PR #61 review rounds 3-5 built allowlist entries against SYNTHETIC excerpt
 * fixtures. The full sweep of 2026-10-13 — every component base image pulled
 * anonymously from its own registry (7 unique tags x amd64+arm64, ~3.5 GB of
 * real layer blobs) and run through the gate's own compiled patterns — proved
 * the existing entries fire on ZERO of the 250 real upstream files that
 * legitimately trip the patterns (573 distinct occurrences in 264 findings):
 *
 *  - cpython-ipaddress-stdlib: verified against Lib/ipaddress.py @ 3.13 branch,
 *    but the shape check `IPv[46]Network\(\s*['"]$` DOES hold on the real file;
 *    entry worked only after the sweep's data pin (values 10.0.0.0/172.16.0.0/
 *    192.168.0.0 — all real _private_networks literals).
 *  - linux-kernel-uapi-bpf-h: verified against torvalds master whose UAPI guard
 *    is `_UAPI__LINUX_BPF_H__`; the DEBIAN distro header ships
 *    `__LINUX_BPF_H__` (uapi-quoting is a kernel-tree style, the distro copy
 *    differs) — verifyProvenance failed on every real image, silently.
 *  - npmcli-arborist-readme-dummy-token: the pinned password value carries a
 *    transcription typo (`…cGFzc3dvcmQ9` vs the real file's `…cGFzc3dvcmQ=`);
 *    provenance held, but the occurrence never matched, silently FAIL-CLOSED
 *    (defensible direction but still a broken entry feeding whack-a-mole).
 *  - the npm-token .md/.html doc entries hold; the ROFF man page
 *    (man/man1/npm-token.1, shipped by npm 10.9.9 in node:22/26 bases with the
 *    same stock `with IP Whitelist: 192.168.0.1/24` example) was a FOURTH
 *    derived copy no entry covered.
 *
 * This module is the replacement upstream-image allowlist engine: data-driven
 * (upstream-allowlist-data.gen.ts, generated from the real bytes) with THREE
 * provenance planes, ALL fail-closed:
 *   1. exact file SHA256 pin (byte-identity vs the exact upstream release
 *      artifact: PyPI wheel / npm tarball / raw.githubusercontent @ pinned tag)
 *   2. closed-set occurrence pins — literal for innocuous values, sha256(value)
 *      DIGEST for secret-shaped values (AWS doc example keys, the evals probe
 *      xox dummy, PEM/DSA/RSA self-test fixtures) so secret-shaped bytes never
 *      land in this repo and a shape-identical but value-different token still
 *      rejects
 *   3. per-family marker/function shape predicates (verified against the same
 *      real bytes)
 * An entry excuses a (pattern, file) ONLY when: pattern ∈ entry.patterns ∧
 * path matches ∧ (fileSha256 == actual OR all markers ∧ markerFn) ∧ EVERY
 * occurrence's pin matches. Any miss → not excused → normal fail-closed reject.
 */
import type { LayerEntry } from './layer-walk.js';
import type { ScanFinding } from './secret-scan.js';
import { UPSTREAM_IMAGE_ALLOWLIST, MARKER_FNS, type UpstreamFileEntry } from './upstream-allowlist-data.gen.js';
import { createHash } from 'node:crypto';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Returns the excusing entry when EVERY occurrence of `patternName` in this file
 * is excused by the SAME entry under the three-plane contract above; otherwise
 * null (not excused → fail closed into the normal finding path).
 */
export function isPatternExcusedByImageAllowlist(
  patternName: string,
  path: string,
  fileText: string,
): UpstreamFileEntry | null {
  for (const entry of UPSTREAM_IMAGE_ALLOWLIST) {
    if (!entry.patterns.includes(patternName)) continue;
    if (!entryMatchesPath(entry, path)) continue;
    if (!entryProvenanceHolds(entry, fileText, path)) continue;
    const re = patternRegexByName(patternName);
    if (!re) continue;
    const occRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    let sawMatch = false;
    let allPinned = true;
    while ((m = occRe.exec(fileText)) !== null) {
      sawMatch = true;
      const ok = entry.occurrences.some((o) =>
        o.literal !== undefined ? o.literal === m![0] : o.sha256 !== undefined ? o.sha256 === sha256Hex(m![0]) : false,
      );
      if (!ok) {
        allPinned = false;
        break;
      }
      if (m[0].length === 0) occRe.lastIndex++;
    }
    if (sawMatch && allPinned) return entry;
  }
  return null;
}

function entryMatchesPath(entry: UpstreamFileEntry, path: string): boolean {
  const p = path.replace(/^(?:\.\/|\/)+/, '');
  switch (entry.matchKind) {
    case 'prefix':
      return p.includes(entry.match) && (p.slice(Math.max(0, p.indexOf(entry.match))).startsWith(entry.match));
    case 'suffix': {
      // A match ending in '/' declares a DIRECTORY subtree (every file path inside it
      // is covered); a plain suffix otherwise. Without this, directory-scoped entries
      // can never match a file path (files don't carry the trailing slash).
      if (entry.match.endsWith('/')) return p.includes(entry.match);
      const suf = entry.match.replace(/^\//, '');
      return p.endsWith(suf) || p.startsWith(suf + '/') || p === suf;
    }
    case 're':
      return new RegExp(entry.match).test(p);
  }
}

function entryProvenanceHolds(entry: UpstreamFileEntry, text: string, path: string): boolean {
  if (entry.fileSha256 !== null && entry.fileSha256 !== undefined) {
    const actual = createHash('sha256').update(text, 'utf8').digest('hex');
    if (actual === entry.fileSha256) return true;
    // FALLBACK plane: markers (the stock occurrence lines from the reviewed upstream
    // file) prove provenance for a byte-reduced excerpt while the closed-set
    // occurrence pins still gate every VALUE. Either plane suffices; both are
    // fail-closed.
    if (markersHold(entry, text)) return true;
  }
  if (entry.fileSha256s !== null && entry.fileSha256s !== undefined) {
    const actual = createHash('sha256').update(text, 'utf8').digest('hex');
    // exact-path pin wins; fall back to any per-file pin entry matching this path
    const normPath = `/${path.replace(/^(?:\.\/|\/)+/, '')}`;
    if (entry.fileSha256s[normPath] !== undefined && actual === entry.fileSha256s[normPath]!) return true;
    for (const [key, expected] of Object.entries(entry.fileSha256s)) {
      if (normPath.endsWith(key) || normPath === key || normPath.endsWith(key.replace(/^\//, ''))) {
        if (actual === expected) return true;
        break; // suffix matched a pin but bytes differ → fall through to markers
      }
    }
    if (markersHold(entry, text)) return true;
  }
  if ((!entry.fileSha256 || entry.fileSha256 === null) && (!entry.fileSha256s || entry.fileSha256s === null)) {
    if (entry.markers && entry.markers.length > 0) return entry.markers.every((marker) => text.includes(marker));
    if (entry.markerFn) {
      const fn = MARKER_FNS[entry.markerFn];
      return fn ? fn(text) : false;
    }
  }
  return false;
}

function markersHold(entry: UpstreamFileEntry, text: string): boolean {
  if (!entry.markers || entry.markers.length === 0) return false;
  return entry.markers.every((marker) => text.includes(marker));
}

// The rfc1918 regex source shared with secret-scan.ts's PATTERNS table — this
// module re-creates (by name lookup into its own copy of the pattern sources)
// ONLY for the occurrence-enumeration pass inside the excuse check. Keep in
// sync with secret-scan.ts; a test asserts both match every real finding value.
const PATTERN_SOURCES: Record<string, { flags: string; source: string }> = {
  pem_private_key: {
    flags: '',
    source:
      '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----(?:[\\r\\n]+|(?:\\\\n)+)(?:(?:[^-\\\\\\r\\n]|\\\\(?!n))*(?:[\\r\\n]+|(?:\\\\n)+))*?[A-Za-z0-9+/]{20,}={0,2}(?:[\\r\\n]+|(?:\\\\n)+)(?:(?:[^-\\\\\\r\\n]|\\\\(?!n))*(?:[\\r\\n]+|(?:\\\\n)+))*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
  },
  aws_access_key_id: { flags: '', source: '\\bAKIA[0-9A-Z]{16}\\b' },
  github_token: { flags: '', source: '\\bgh[pousr]_[A-Za-z0-9]{36,}\\b' },
  slack_token: { flags: '', source: '\\bxox[baprs]-[0-9A-Za-z-]{10,}\\b' },
  generic_api_key_assignment: {
    flags: 'i',
    source: "\\b(?:api[_-]?key|secret|token|password)\\b\\s*[:=]\\s*['\"][A-Za-z0-9_\\-/+=]{12,}['\"]",
  },
  private_key_generic: {
    flags: '',
    source:
      '-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----(?:[\\r\\n]+|(?:\\\\n)+)(?:(?:[^-\\\\\\r\\n]|\\\\(?!n))*(?:[\\r\\n]+|(?:\\\\n)+))*?[A-Za-z0-9+/]{20,}={0,2}(?:[\\r\\n]+|(?:\\\\n)+)(?:(?:[^-\\\\\\r\\n]|\\\\(?!n))*(?:[\\r\\n]+|(?:\\\\n)+))*?-----END (?:ENCRYPTED )?PRIVATE KEY-----',
  },
  tailnet_magicdns_fqdn: { flags: 'i', source: '\\b[a-z0-9-]+\\.[a-z0-9-]+\\.ts\\.net\\b' },
  rfc1918_private_ip: {
    flags: '',
    source:
      "\\b(?<!\\d\\.)(?:10\\.(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){2}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)|172\\.(?:1[6-9]|2\\d|3[01])\\.(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.)(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)|192\\.168\\.(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.)(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d))\\b(?!\\.\\d)",
  },
};

function patternRegexByName(name: string): RegExp | null {
  const spec = PATTERN_SOURCES[name];
  if (!spec) return null;
  return new RegExp(spec.source, spec.flags);
}

/**
 * Filters findings: every finding whose (pattern, path, fileText) is FULLY
 * excused by an allowlist entry is dropped; everything else stays. Scanning a
 * RAW entry list re-runs the pattern per file only for allowlist candidates.
 */
export function filterExcusedFindings(entries: LayerEntry[], findings: ScanFinding[]): ScanFinding[] {
  if (findings.length === 0) return findings;
  // group findings by path → patterns to re-check
  const byPath = new Map<string, Set<string>>();
  for (const f of findings) {
    if (!byPath.has(f.path)) byPath.set(f.path, new Set());
    byPath.get(f.path)!.add(f.pattern);
  }
  const textByPath = new Map<string, string>();
  for (const entry of entries) {
    if (entry.isWhiteoutMarker) continue;
    if (entry.type !== '0' && entry.type !== '\0') continue;
    if (entry.data.length === 0 || textByPath.has(entry.name)) continue;
    // same NUL-sniff as the scanner: binary entries never carry pattern text
    const firstNul = entry.data.subarray(0, 8000).indexOf(0);
    if (firstNul !== -1) continue;
    textByPath.set(entry.name, entry.data.toString('utf8'));
  }
  return findings.filter((f) => {
    const text = textByPath.get(f.path);
    if (text === undefined) return true;
    const excuser = isPatternExcusedByImageAllowlist(f.pattern, f.path, text);
    return excuser === null;
  });
}