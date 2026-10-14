/**
 * Credential-SHAPED pattern catalog (fleet-ops-1py.14 slice 6).
 *
 * Deliberately separate from registrar/src/oci-gate/secret-scan.ts:
 * that module's pattern set is scoped to the slice-4 OCI content gate
 * (scans built image layer bytes, mixes 'secret' and 'topology' kinds
 * in one pass). This module is CREDENTIAL-ONLY — it never flags a
 * tailnet FQDN, an RFC1918 IP, or any other already-approved topology
 * literal (fleet-ops-1py.14 slices 1-3 own that sanitization; the
 * owner ruling for this slice explicitly keeps credential scanning a
 * separate, narrower scope). Used by two independent consumers:
 *
 *  - scripts/credential-history-audit.mjs: a one-time, read-only git
 *    HISTORY audit (every commit, every blob) with REDACTED findings.
 *  - scripts/credential-scan-run.mjs: a CI gate scanning image BUILD
 *    INPUTS (the Docker build-context source trees) on every PR/push,
 *    fail-closed.
 *
 * Every pattern here is credential-SHAPED, not a confirmed live
 * secret — a match means "this looks like a credential", which is
 * exactly what a fail-closed gate wants: it throws on the shape, it
 * never attempts to validate the matched value against a real
 * service, and it never logs the matched value anywhere (callers must
 * report pattern name + location only — see report.ts).
 */

export type CredentialPatternName =
  | 'pem_private_key'
  | 'aws_access_key_id'
  | 'github_token_classic'
  | 'github_token_fine_grained'
  | 'slack_token'
  | 'openai_api_key'
  | 'anthropic_api_key'
  | 'google_api_key'
  | 'stripe_live_key'
  | 'jwt_token'
  | 'generic_high_entropy_keyed_assignment';

export interface CredentialPattern {
  name: CredentialPatternName;
  regex: RegExp;
}

/**
 * Order matters only for readability — every pattern is evaluated
 * independently, so a string can legitimately match more than one
 * (e.g. a PEM block AND a generic keyed assignment around it); callers
 * collect ALL matches rather than stopping at the first.
 */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // pem_private_key: a real PEM private key has a SUBSTANTIAL base64
  // body (at least one full base64 line, conventionally wrapped at 64
  // chars — real keys run to many such lines) between its header and
  // footer. A UI placeholder (e.g. registrar/src/admin-html.ts's
  // github_app_pem field) uses the exact same header/footer framing
  // around an ellipsis or other short non-base64 filler with ZERO real
  // key material — "header + ellipsis/short-filler + footer" is not a
  // secret and must not reject shipped source that merely shows an
  // operator what to paste. Requiring >=20 base64 chars on at least one
  // line between the markers is the distinguishing signal: a real key's
  // body trivially clears this bar; a placeholder's ellipsis (…) or any
  // short human-readable filler never does, because it is neither valid
  // base64 content nor long enough.
  //
  // PR #61 review round 2 finding #2: a PEM also needs to be detected
  // when it is stored inside a JSON string value, where
  // JSON.stringify() serializes every real newline as the TWO-character
  // escape sequence `\n` (a literal backslash followed by the letter
  // n), not an actual line break — e.g.
  // `JSON.stringify({ private_key: pem })` yields a single-line string
  // like `-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE
  // KEY-----\n` with zero real CR/LF bytes. The round-1 fix's line
  // separator only matched real `[\r\n]+`, so it silently missed this
  // shape entirely (both in credential-scan/patterns.ts and the
  // mirrored oci-gate/secret-scan.ts). The line-break alternation below
  // accepts EITHER a real newline/CRLF run OR a literal backslash-n
  // escape run (`(?:\\n)+` — note this matches the two source
  // characters `\` and `n`, not an actual newline) as the separator
  // between header/body/footer, so both the raw multi-line file case
  // and the JSON-serialized single-line case are detected, while the
  // placeholder (no real base64 body in EITHER representation) still
  // correctly fails to match.
  {
    name: 'pem_private_key',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----(?:[\r\n]+|(?:\\n)+)(?:(?:[^-\\\r\n]|\\(?!n))*(?:[\r\n]+|(?:\\n)+))*?[A-Za-z0-9+/]{20,}={0,2}(?:[\r\n]+|(?:\\n)+)(?:(?:[^-\\\r\n]|\\(?!n))*(?:[\r\n]+|(?:\\n)+))*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: 'aws_access_key_id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_token_classic', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'github_token_fine_grained', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'slack_token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'anthropic_api_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai_api_key', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'stripe_live_key', regex: /\b(?:sk|pk)_live_[0-9a-zA-Z]{24,}\b/ },
  { name: 'jwt_token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'generic_high_entropy_keyed_assignment',
    regex: /\b(?:api[_-]?key|secret|password|access[_-]?key|private[_-]?key|token)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{12,}['"]/i,
  },
] as const;
