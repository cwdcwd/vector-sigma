/**
 * `fetch`-backed RegistryTransport (fleet-ops-r3v).
 *
 * The single place in the promotion path that actually touches the
 * network. It exists as its own module for two reasons:
 *
 *  1. `registrar/src/oci-gate/**` carries a load-bearing static + behavioral
 *     assertion that nothing in the SCAN tree can make a network call. The
 *     promoter needs the network, so it lives in `registrar/src/registry/**`
 *     and the gate tree stays provably local.
 *  2. Every caller above this module (the promotion orchestration, the CLI)
 *     is exercised in tests against an in-memory fake transport, so the
 *     network seam is one injectable function wide.
 *
 * Credential hygiene: the token arrives in the request's `Authorization`
 * header, is never placed in a URL, and is never included in a thrown
 * error message.
 */
import { RegistryClientError, type RegistryRequest, type RegistryResponse, type RegistryTransport } from './types.js';

/** The subset of the WHATWG fetch signature this transport uses. */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class FetchRegistryTransport implements RegistryTransport {
  constructor(private readonly fetchImpl: FetchLike) {}

  async send(req: RegistryRequest): Promise<RegistryResponse> {
    let res;
    try {
      res = await this.fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body ? { body: new Uint8Array(req.body) } : {}),
      });
    } catch (err) {
      // A transport-level failure (DNS, TLS, reset) is reported without the
      // URL's query string or any header value — the URL never carries a
      // credential, but the safe habit is to report the failure, not dump it.
      throw new RegistryClientError(0, `registry request failed (${req.method}): ${(err as Error).message}`);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
  }
}

/** Constructs the production transport over the runtime's global `fetch`. */
export function createFetchTransport(): FetchRegistryTransport {
  const impl = globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof impl !== 'function') {
    throw new RegistryClientError(0, 'no global fetch available to construct the registry transport');
  }
  return new FetchRegistryTransport(impl.bind(globalThis));
}
