/**
 * OCI Distribution v2 client (fleet-ops-r3v).
 *
 * The exact-byte promoter needs three registry primitives and nothing
 * else: does this blob already exist, store these exact bytes, and read
 * the bytes back for a reference. This client implements exactly those,
 * over an injected `RegistryTransport`, and is deliberately dumb — it
 * never parses a manifest, never decides what to promote, and never
 * swallows a non-2xx response. Ordering and verification policy live in
 * `promote.ts`, where they can be tested against a fake registry.
 *
 * Credentials: a bearer token may be supplied per construction. It is
 * placed only in the `Authorization` request header and is never echoed
 * into a URL, a log line, or an error message.
 */
import {
  RegistryClientError,
  type RegistryRequest,
  type RegistryResponse,
  type RegistryTransport,
} from './types.js';

const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const MANIFEST_LIST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.list.v2+json';

/** Both index media types, so a Docker-typed index is accepted alongside an OCI one. */
export const MANIFEST_ACCEPT = [INDEX_MEDIA_TYPE, MANIFEST_LIST_MEDIA_TYPE, MANIFEST_MEDIA_TYPE].join(', ');

export interface OciDistributionClientOptions {
  transport: RegistryTransport;
  /** e.g. `ghcr.io` — no scheme. */
  registry: string;
  /** e.g. `cwdcwd/vector-sigma/registrar`. */
  repository: string;
  token?: string;
  /**
   * URL scheme for the base. Always `https` in production; a local
   * `node:http` registry in the transport test suite overrides it so the
   * real `fetch` adapter can be exercised over a real socket without TLS.
   */
  scheme?: 'http' | 'https';
}

export interface FetchedManifest {
  bytes: Buffer;
  mediaType: string;
  /** Digest the registry reported, or recomputed from the bytes when absent. */
  digest: string;
}

export class OciDistributionClient {
  private readonly transport: RegistryTransport;
  private readonly base: string;
  /** Scheme + authority, used to resolve a relative upload `Location`. */
  private readonly origin: string;

  constructor(private readonly opts: OciDistributionClientOptions) {
    this.transport = opts.transport;
    this.origin = `${opts.scheme ?? 'https'}://${opts.registry}`;
    this.base = `${this.origin}/v2/${opts.repository}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Header names are normalised to lower case at this seam: HTTP header
    // names are case-insensitive, and the injected fake (like any transport
    // implementation inspecting its own request map) must not have to guess
    // which capitalisation the caller used.
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) h[k.toLowerCase()] = v;
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  private async request(req: RegistryRequest, what: string): Promise<RegistryResponse> {
    const res = await this.transport.send(req);
    if (res.status < 200 || res.status >= 300) {
      throw new RegistryClientError(res.status, `${what}: registry returned HTTP ${res.status}`);
    }
    return res;
  }

  /** HEAD a blob. A 404 is a legitimate "not stored yet", not an error. */
  async blobExists(digest: string): Promise<boolean> {
    const res = await this.transport.send({
      method: 'HEAD',
      url: `${this.base}/blobs/${digest}`,
      headers: this.headers(),
    });
    if (res.status === 404) return false;
    if (res.status < 200 || res.status >= 300) {
      throw new RegistryClientError(res.status, `blobExists ${digest}: HTTP ${res.status}`);
    }
    return true;
  }

  /**
   * Uploads exact bytes under the given digest: POST for an upload
   * session, then a single-request PUT carrying the whole body (no chunk
   * reassembly — a monolithic PUT is what makes the byte-identity story
   * simple to reason about). Returns nothing; the caller re-reads by
   * digest to prove what landed.
   */
  async uploadBlob(bytes: Buffer, digest: string): Promise<void> {
    const post = await this.request(
      { method: 'POST', url: `${this.base}/blobs/uploads/`, headers: this.headers() },
      `blob upload session for ${digest}`,
    );
    const location = post.headers.location ?? post.headers.Location;
    if (!location) {
      throw new RegistryClientError(post.status, `blob upload session for ${digest}: registry returned no Location header`);
    }
    // Origin pin (r3v, thanos review note on #62): the upload session's
    // Location is registry-controlled, so a hostile or misconfigured
    // registry could hand back a Location on a different host and have the
    // bearer-authenticated PUT (and the raw bytes) go there. Fail closed:
    // resolve the Location against THIS client's configured origin and
    // refuse any redirect to another origin. The PUT below is derived from
    // this pinned-origin URL, so no other host ever sees the byte payload.
    const fromLocation = new URL(location, this.origin);
    if (fromLocation.origin !== this.origin) {
      throw new RegistryClientError(
        post.status,
        `blob upload session for ${digest}: registry Location ${fromLocation.origin} is outside the configured registry origin ${this.origin}`,
      );
    }
    const uploadUrl = fromLocation.toString();
    const withDigest = new URL(uploadUrl);
    withDigest.searchParams.set('digest', digest);

    await this.request(
      {
        method: 'PUT',
        url: withDigest.toString(),
        headers: this.headers({
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
        }),
        body: bytes,
      },
      `blob PUT ${digest}`,
    );
  }

  /** Fetches a blob's raw bytes by digest. */
  async getBlob(digest: string): Promise<Buffer> {
    const res = await this.request(
      { method: 'GET', url: `${this.base}/blobs/${digest}`, headers: this.headers() },
      `blob GET ${digest}`,
    );
    return res.body;
  }

  /** PUTs a manifest to a reference (a tag or a digest) and returns the assigned digest. */
  async putManifest(reference: string, bytes: Buffer, mediaType: string): Promise<string> {
    const res = await this.request(
      {
        method: 'PUT',
        url: `${this.base}/manifests/${reference}`,
        headers: this.headers({
          'Content-Type': mediaType,
          'Content-Length': String(bytes.length),
        }),
        body: bytes,
      },
      `manifest PUT ${reference}`,
    );
    return res.headers['docker-content-digest'] ?? '';
  }

  /**
   * Reads a manifest back by tag or digest. The `digest` field is the
   * registry's reported content digest when present; callers that need
   * proof of byte identity must recompute over `bytes` themselves rather
   * than trust this field.
   */
  async getManifest(reference: string): Promise<FetchedManifest> {
    const res = await this.request(
      { method: 'GET', url: `${this.base}/manifests/${reference}`, headers: this.headers({ Accept: MANIFEST_ACCEPT }) },
      `manifest GET ${reference}`,
    );
    return {
      bytes: res.body,
      mediaType: res.headers['content-type'] ?? '',
      digest: res.headers['docker-content-digest'] ?? '',
    };
  }
}
