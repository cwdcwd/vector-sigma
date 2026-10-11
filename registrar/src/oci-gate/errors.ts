/**
 * Content-gate error taxonomy (fleet-ops-1py.14 slice 4).
 *
 * Every rejection path in the gate throws one of these, tagged with a
 * stable `code` the test matrix asserts on. The gate is fail-closed:
 * any parse failure, descriptor mismatch, path-traversal attempt,
 * secret/topology finding, or index-assembly violation throws rather
 * than silently excluding content or returning a partial result.
 */
export type ContentGateErrorCode =
  | 'malformed_layout'
  | 'missing_blob'
  | 'path_traversal'
  | 'digest_mismatch'
  | 'size_mismatch'
  | 'malformed_descriptor'
  | 'corrupt_layer'
  | 'secret_found'
  | 'topology_literal_found'
  | 'missing_platform'
  | 'duplicate_platform'
  | 'extra_platform'
  | 'unknown_child_digest';

export class ContentGateError extends Error {
  readonly code: ContentGateErrorCode;
  readonly details?: unknown;

  constructor(code: ContentGateErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ContentGateError';
    this.code = code;
    this.details = details;
  }
}
