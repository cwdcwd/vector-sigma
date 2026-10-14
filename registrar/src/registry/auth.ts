/**
 * GHCR / OCI Distribution token exchange (fleet-ops-r3v).
 *
 * Both the promotion job (push scope) and the verify-remote job (pull
 * scope) need a bearer token, and neither may put a credential in a URL
 * or in a log line. This module owns that exchange:
 *
 *   GET https://<registry>/token?service=<registry>&scope=repository:<ns>/<repo>:<actions>
 *   Authorization: Basic base64(<username>:<password>)
 *
 * → { token | access_token }
 *
 * Anonymous pulls are supported (no credentials ⇒ no Authorization
 * header ⇒ GHCR issues an anonymous token) so verify-remote can prove a
 * PUBLIC image's bytes without any credential at all.
 *
 * Credential hygiene, enforced by the shape of the code: the password
 * arrives as a function argument, is used to build one base64 header,
 * and appears in no other expression — not in a URL, not in a thrown
 * error's message, not in a returned value.
 */
import { RegistryClientError, type RegistryTransport } from './types.js';

export interface TokenRequest {
  registry: string;
  /** e.g. `cwdcwd/vector-sigma/registrar`. */
  repository: string;
  /** `pull`, or `pull,push`. */
  actions: string;
  username?: string;
  password?: string;
  /** `https` in production; overridden only by the local-registry transport test. */
  scheme?: 'http' | 'https';
}

interface TokenResponse {
  token?: string;
  access_token?: string;
}

/**
 * Exchanges credentials for a bearer token. Throws on any non-2xx or a
 * 2xx body that carries neither `token` nor `access_token` — a silent
 * empty token would surface later as a confusing 401 mid-promotion.
 */
export async function fetchRegistryToken(transport: RegistryTransport, opts: TokenRequest): Promise<string> {
  const scope = `repository:${opts.repository}:${opts.actions}`;
  const url = new URL(`${opts.scheme ?? 'https'}://${opts.registry}/token`);
  url.searchParams.set('service', opts.registry);
  url.searchParams.set('scope', scope);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.username && opts.password) {
    headers.authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64')}`;
  }

  const res = await transport.send({ method: 'GET', url: url.toString(), headers });
  if (res.status < 200 || res.status >= 300) {
    throw new RegistryClientError(res.status, `token exchange for ${scope}: registry returned HTTP ${res.status}`);
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(res.body.toString('utf8')) as TokenResponse;
  } catch {
    throw new RegistryClientError(res.status, `token exchange for ${scope}: response was not JSON`);
  }

  const token = parsed.token ?? parsed.access_token;
  if (!token) {
    throw new RegistryClientError(res.status, `token exchange for ${scope}: response carried no token`);
  }
  return token;
}
