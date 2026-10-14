/**
 * Shared finding shapes + redaction-safe formatting (fleet-ops-1py.14
 * slice 6). Neither shape below has a field for the matched value —
 * the type system itself refuses to carry a credential value past the
 * scan boundary, matching the structural guarantee in scan-text.ts.
 */
import type { CredentialPatternName } from './patterns.js';

export interface SourceTreeFinding {
  pattern: CredentialPatternName;
  /** Path relative to the scanned root, forward-slash separated. */
  path: string;
}

export interface HistoryFinding {
  pattern: CredentialPatternName;
  /** Full commit SHA the credential-shaped content was found in. */
  commit: string;
  /** Path relative to the repo root, forward-slash separated. */
  path: string;
}

/** Formats one source-tree finding as a single redacted report line. */
export function formatSourceTreeFinding(f: SourceTreeFinding): string {
  return `[${f.pattern}] path=${f.path} value=REDACTED`;
}

/** Formats one history finding as a single redacted report line. */
export function formatHistoryFinding(f: HistoryFinding): string {
  return `[${f.pattern}] commit=${f.commit} path=${f.path} value=REDACTED`;
}
