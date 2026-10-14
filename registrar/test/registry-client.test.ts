/**
 * OCI Distribution v2 client (fleet-ops-r3v) — the transport seam the
 * exact-byte promoter speaks.
 *
 * Scope: blob existence/blob upload, manifest PUT, manifest GET (by tag
 * OR digest), blob GET. No credentials are embedded in URLs, no token is
 * ever logged, and every response body is returned as raw bytes so the
 * caller (the promoter) can recompute a digest over the EXACT bytes the
 * registry served — which is the whole point of the verification step.
 */
import { describe, expect, it } from 'vitest';
import { OciDistributionClient } from '../src/registry/oci-distribution.js';
import { RegistryClientError } from '../src/registry/types.js';
import { FakeRegistry, sha256Digest } from './helpers/fake-registry.js';

function client(fake: FakeRegistry, token?: string): OciDistributionClient {
  return new OciDistributionClient({
    transport: fake,
    registry: 'ghcr.io',
    repository: 'cwdcwd/vector-sigma/registrar',
    token,
  });
}

const MANIFEST_MT = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_MT = 'application/vnd.oci.image.index.v1+json';

describe('OciDistributionClient: request shape', () => {
  it('addresses the registry v2 API under the repository path', async () => {
    const fake = new FakeRegistry();
    await client(fake).blobExists('sha256:' + 'a'.repeat(64));
    expect(fake.calls).toEqual([`HEAD /v2/cwdcwd/vector-sigma/registrar/blobs/sha256:${'a'.repeat(64)}`]);
  });

  it('sends a bearer token as an Authorization header when one is supplied, and never in the URL', async () => {
    const fake = new FakeRegistry();
    const seen: Array<{ url: string; auth?: string }> = [];
    const original = fake.send.bind(fake);
    fake.send = async (req) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      return original(req);
    };
    await client(fake, 'test-token-value').blobExists('sha256:' + 'b'.repeat(64));
    expect(seen[0].url).not.toContain('test-token-value');
    expect(seen[0].auth).toBe('Bearer test-token-value');
  });

  it('omits the Authorization header entirely when no token is supplied (anonymous public read)', async () => {
    const fake = new FakeRegistry();
    const seen: Array<Record<string, string>> = [];
    const original = fake.send.bind(fake);
    fake.send = async (req) => {
      seen.push(req.headers);
      return original(req);
    };
    const bytes = Buffer.from('{"schemaVersion":2}');
    await client(fake).putManifest('anon-ref', bytes, MANIFEST_MT);
    await client(fake).getManifest('anon-ref');
    expect(seen[1].authorization).toBeUndefined();
  });
});

describe('OciDistributionClient: blobs', () => {
  it('reports absence for an unknown blob and presence for a stored one', async () => {
    const fake = new FakeRegistry();
    const c = client(fake);
    const bytes = Buffer.from('layer-bytes');
    const digest = sha256Digest(bytes);
    expect(await c.blobExists(digest)).toBe(false);
    await c.uploadBlob(bytes, digest);
    expect(await c.blobExists(digest)).toBe(true);
  });

  it('uploads via POST-then-PUT with the digest as a query parameter', async () => {
    const fake = new FakeRegistry();
    const bytes = Buffer.from('layer-bytes-2');
    const digest = sha256Digest(bytes);
    await client(fake).uploadBlob(bytes, digest);
    expect(fake.calls).toEqual([
      'POST /v2/cwdcwd/vector-sigma/registrar/blobs/uploads/',
      `PUT /v2/cwdcwd/vector-sigma/registrar/blobs/uploads/fake-session-1`,
    ]);
    expect(fake.storedBlob(digest)?.equals(bytes)).toBe(true);
  });

  it('returns the blob bytes verbatim on GET', async () => {
    const fake = new FakeRegistry();
    const bytes = Buffer.from('some config json');
    const digest = sha256Digest(bytes);
    await client(fake).uploadBlob(bytes, digest);
    expect((await client(fake).getBlob(digest)).equals(bytes)).toBe(true);
  });

  it('raises a status-carrying error when the registry rejects an upload', async () => {
    const fake = new FakeRegistry();
    const bytes = Buffer.from('x');
    const digest = sha256Digest(bytes);
    await client(fake).uploadBlob(bytes, digest);
    expect(await client(fake).blobExists(digest)).toBe(true);
    // A registry that stores DIFFERENT bytes under the digest we claimed is
    // the failure the fake models by rejecting a mismatched body outright.
    await expect(client(fake).uploadBlob(Buffer.from('y'), digest)).rejects.toBeInstanceOf(RegistryClientError);
  });

  it('raises for a missing blob on GET rather than returning empty bytes', async () => {
    const fake = new FakeRegistry();
    await expect(client(fake).getBlob('sha256:' + 'd'.repeat(64))).rejects.toBeInstanceOf(RegistryClientError);
  });
});

describe('OciDistributionClient: manifests', () => {
  it('PUTs a manifest to a tag reference and returns the registry-assigned digest', async () => {
    const fake = new FakeRegistry();
    const bytes = Buffer.from('{"schemaVersion":2}');
    const digest = await client(fake).putManifest('abc123-amd64', bytes, MANIFEST_MT);
    expect(digest).toBe(sha256Digest(bytes));
    expect(fake.storedManifest('cwdcwd/vector-sigma/registrar', 'abc123-amd64')?.bytes.equals(bytes)).toBe(true);
  });

  it('GETs a manifest by tag, returning raw bytes plus the media type', async () => {
    const fake = new FakeRegistry();
    const bytes = Buffer.from('{"schemaVersion":2,"mediaType":"index"}');
    await client(fake).putManifest('abc123', bytes, INDEX_MT);
    const got = await client(fake).getManifest('abc123');
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.mediaType).toBe(INDEX_MT);
    expect(got.digest).toBe(sha256Digest(bytes));
  });

  it('GETs a manifest by digest reference', async () => {
    const fake = new FakeRegistry();
    const bytes = Buffer.from('{"schemaVersion":2,"by":"digest"}');
    const digest = await client(fake).putManifest('abc123', bytes, MANIFEST_MT);
    const got = await client(fake).getManifest(digest);
    expect(got.bytes.equals(bytes)).toBe(true);
  });

  it('advertises both index and manifest media types on Accept', async () => {
    const fake = new FakeRegistry();
    const accepts: Array<string | undefined> = [];
    const original = fake.send.bind(fake);
    fake.send = async (req) => {
      accepts.push(req.headers.accept);
      return original(req);
    };
    const bytes = Buffer.from('{"schemaVersion":2}');
    await client(fake).putManifest('accept-ref', bytes, MANIFEST_MT);
    await client(fake).getManifest('accept-ref');
    expect(accepts[1]).toContain(INDEX_MT);
    expect(accepts[1]).toContain(MANIFEST_MT);
  });

  it('raises for an unknown manifest reference', async () => {
    const fake = new FakeRegistry();
    await expect(client(fake).getManifest('nope')).rejects.toBeInstanceOf(RegistryClientError);
  });
});
