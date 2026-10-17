/**
 * In-memory fake OCI Distribution v2 registry transport (fleet-ops-r3v).
 *
 * Implements the exact subset of the distribution API the promoter's
 * `OciDistributionClient` speaks — blob HEAD/POST/PUT, manifest PUT/GET —
 * over an injectable transport so the promotion orchestration can be
 * exercised end to end WITHOUT a network call, a docker daemon, or a
 * live registry. Every request is recorded so a test can assert not only
 * the stored bytes (the exact-byte contract) but also the ORDER in which
 * writes and tags happened (the fail-stop contract: no tag is applied
 * before every digest has been re-fetched and verified).
 */
import { createHash } from 'node:crypto';
import type { RegistryRequest, RegistryResponse, RegistryTransport } from '../../src/registry/types.js';

export function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface StoredManifest {
  mediaType: string;
  bytes: Buffer;
}

export class RegistryHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class FakeRegistry implements RegistryTransport {
  /** Ordered log of every request the client issued ("METHOD path"). */
  readonly calls: string[] = [];
  /** Blobs stored, keyed by digest. */
  readonly blobs = new Map<string, Buffer>();
  /** Manifests stored, keyed by `<repository>@<ref>`. */
  private readonly manifests = new Map<string, StoredManifest>();
  /** Overrides the bytes returned by GET for a `<repository>@<ref>` key. */
  readonly tamper = new Map<string, Buffer>();
  /** Request keys ("METHOD <path>") that must answer 500. */
  readonly failOn = new Set<string>();

  private manifestKey(repository: string, ref: string): string {
    return `${repository}@${ref}`;
  }

  storedManifest(repository: string, ref: string): StoredManifest | undefined {
    return this.manifests.get(this.manifestKey(repository, ref));
  }

  storedBlob(digest: string): Buffer | undefined {
    return this.blobs.get(digest);
  }

  async send(req: RegistryRequest): Promise<RegistryResponse> {
    const url = new URL(req.url);
    const path = url.pathname;
    this.calls.push(`${req.method} ${path}`);

    if (this.failOn.has(`${req.method} ${path}`)) {
      return { status: 500, headers: {}, body: Buffer.from('injected failure') };
    }

    const blobMatch = path.match(/^\/v2\/(.+?)\/blobs\/(.+)$/);
    if (blobMatch) {
      const [, repository, rest] = blobMatch;
      if (rest === 'uploads/') {
        if (req.method !== 'POST') {
          return { status: 405, headers: {}, body: Buffer.from('method not allowed') };
        }
        return {
          status: 202,
          headers: { location: `/v2/${repository}/blobs/uploads/fake-session-${this.calls.length}` },
          body: Buffer.alloc(0),
        };
      }
      if (rest.startsWith('uploads/')) {
        if (req.method !== 'PUT') {
          return { status: 405, headers: {}, body: Buffer.from('method not allowed') };
        }
        const digest = url.searchParams.get('digest');
        if (!digest) return { status: 400, headers: {}, body: Buffer.from('missing digest') };
        const body = req.body ?? Buffer.alloc(0);
        if (sha256Digest(body) !== digest) {
          return { status: 400, headers: {}, body: Buffer.from('digest mismatch on upload') };
        }
        this.blobs.set(digest, body);
        return { status: 201, headers: { 'docker-content-digest': digest }, body: Buffer.alloc(0) };
      }
      // HEAD/GET blob by digest
      const exists = this.blobs.has(rest);
      return {
        status: exists ? 200 : 404,
        headers: { 'content-length': String(this.blobs.get(rest)?.length ?? 0) },
        body: req.method === 'HEAD' ? Buffer.alloc(0) : (this.blobs.get(rest) ?? Buffer.alloc(0)),
      };
    }

    const manifestMatch = path.match(/^\/v2\/(.+?)\/manifests\/(.+)$/);
    if (manifestMatch) {
      const [, repository, ref] = manifestMatch;
      const key = this.manifestKey(repository, ref);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const tampered = this.tamper.get(key);
        const stored = this.manifests.get(key);
        if (!stored && !tampered) {
          return { status: 404, headers: {}, body: Buffer.from('manifest unknown') };
        }
        const bytes = tampered ?? stored!.bytes;
        return {
          status: 200,
          headers: {
            'content-type': stored?.mediaType ?? 'application/vnd.oci.image.manifest.v1+json',
            'docker-content-digest': sha256Digest(bytes),
            'content-length': String(bytes.length),
          },
          body: req.method === 'HEAD' ? Buffer.alloc(0) : bytes,
        };
      }
      if (req.method === 'PUT') {
        const bytes = req.body ?? Buffer.alloc(0);
        const mediaType = req.headers['content-type'] ?? 'application/octet-stream';
        const digest = sha256Digest(bytes);
        this.manifests.set(key, { mediaType, bytes });
        // A manifest is additionally retrievable by its own digest, exactly
        // as a real registry serves it after a digest-addressed PUT.
        this.manifests.set(this.manifestKey(repository, digest), { mediaType, bytes });
        return { status: 201, headers: { 'docker-content-digest': digest }, body: Buffer.alloc(0) };
      }
      return { status: 405, headers: {}, body: Buffer.from('method not allowed') };
    }

    return { status: 404, headers: {}, body: Buffer.from('unknown route') };
  }
}
