/**
 * Minimal OCI Distribution v2 transport types (fleet-ops-r3v).
 *
 * The promoter must push the EXACT byte streams the content gate already
 * scanned, and then re-fetch them by digest and prove byte identity. That
 * is a registry-client concern, so this module lives OUTSIDE
 * `registrar/src/oci-gate/` on purpose: the gate tree carries a static +
 * behavioral no-network assertion (every file in it must contain no
 * `fetch(`, no `node:http(s)` import, no registry SDK) and that invariant
 * is load-bearing — it is what makes "the scan is local-only" provable.
 * The transport here is injected, so the promoter's own tests run with no
 * network either; only the CI job wires the real `fetch` implementation.
 */

/** A single outbound registry request. */
export interface RegistryRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT';
  /** Absolute URL, no credentials embedded. */
  url: string;
  headers: Record<string, string>;
  /** Absent for GET/HEAD. */
  body?: Buffer;
}

/** A single registry response, body already buffered. */
export interface RegistryResponse {
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The transport seam. Real code passes a `fetch`-backed implementation;
 * tests pass an in-memory fake. Nothing above this seam knows which.
 */
export interface RegistryTransport {
  send(req: RegistryRequest): Promise<RegistryResponse>;
}

/** Raised by the client on any non-2xx registry response. */
export class RegistryClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryClientError';
  }
}

export function describeRequest(req: RegistryRequest): string {
  return `${req.method} ${req.url.replace(/^https?:\/\/[^/]+/, '')}`;
}
