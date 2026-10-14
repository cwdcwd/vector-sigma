/**
 * Remote digest verification (fleet-ops-r3v).
 *
 * The promotion job records what it published (`PromotedRecord`). This
 * module is the INDEPENDENT half of the contract: it re-reads the
 * registry afterwards and proves the bytes still present are the bytes
 * that were promoted — not a retargeted tag, not a rewritten manifest.
 *
 * It deliberately does NOT trust the client's own `putManifest` return
 * value or the server's `Docker-Content-Digest` header: every comparison
 * recomputes SHA-256 over the exact bytes the registry served.
 *
 * Verification is per-arch child digests AND the published index digest
 * (the owner's rounding requirement — verifying one child manifest alone
 * would leave the multi-arch reference unpinned).
 */
import { createHash } from 'node:crypto';
import { OciDistributionClient } from './oci-distribution.js';
import type { RegistryTransport } from './types.js';

export type VerifyFailureCode =
  | 'index_mismatch'
  | 'child_missing'
  | 'child_mismatch'
  | 'malformed_index'
  | 'tag_unresolvable';

export class VerifyRemoteError extends Error {
  constructor(
    readonly code: VerifyFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerifyRemoteError';
  }
}

/** What the promotion step recorded; the only input this verifier trusts. */
export interface PromotedRecord {
  repository: string;
  index: { tag: string; digest: string };
  perPlatform: Array<{ platform: string; tag: string; digest: string }>;
}

export interface VerifyRemoteOptions {
  transport: RegistryTransport;
  registry: string;
  token?: string;
  /** `https` in production; overridden only by the local-registry transport test. */
  scheme?: 'http' | 'https';
  record: PromotedRecord;
}

export interface VerifyRemoteResult {
  repository: string;
  indexDigest: string;
  children: Array<{ platform: string; digest: string }>;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface IndexShape {
  manifests?: Array<{ digest?: unknown; platform?: { os?: unknown; architecture?: unknown } }>;
}

/**
 * Re-fetches the published index by tag and every child manifest, and
 * fails closed on any difference from the recorded promotion.
 */
export async function verifyRemote(opts: VerifyRemoteOptions): Promise<VerifyRemoteResult> {
  const client = new OciDistributionClient({
    transport: opts.transport,
    registry: opts.registry,
    repository: opts.record.repository,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.scheme ? { scheme: opts.scheme } : {}),
  });

  const { tag, digest: recordedIndexDigest } = opts.record.index;

  const fetched = await client.getManifest(tag);
  const actualIndexDigest = sha256(fetched.bytes);
  if (actualIndexDigest !== recordedIndexDigest) {
    throw new VerifyRemoteError(
      'index_mismatch',
      `index tag ${tag} resolves to ${actualIndexDigest}, recorded ${recordedIndexDigest}`,
    );
  }

  let parsed: IndexShape;
  try {
    parsed = JSON.parse(fetched.bytes.toString('utf8')) as IndexShape;
  } catch {
    throw new VerifyRemoteError('malformed_index', `index served for tag ${tag} is not JSON`);
  }
  const remoteChildren = parsed.manifests ?? [];

  const children: Array<{ platform: string; digest: string }> = [];
  for (const expected of opts.record.perPlatform) {
    // Match the recorded child to the published index BY PLATFORM, then
    // prove the registry's own index agrees on the digest. A recorded
    // digest that the published index does not list means the index was
    // assembled from different bytes than the promotion recorded.
    const [os, arch] = expected.platform.split('/');
    const match = remoteChildren.find(
      (m) => m.platform?.os === os && m.platform?.architecture === arch,
    );
    if (!match) {
      throw new VerifyRemoteError(
        'child_missing',
        `published index ${tag} has no child for platform ${expected.platform}`,
      );
    }
    if (match.digest !== expected.digest) {
      throw new VerifyRemoteError(
        'child_mismatch',
        `published index ${tag} lists ${expected.platform} as ${String(match.digest)}, recorded ${expected.digest}`,
      );
    }

    // And re-fetch the child BY DIGEST and confirm the served bytes hash
    // to that digest. This is the step that catches a registry serving
    // different content at a content-addressed path.
    const childBytes = await client.getManifest(expected.digest);
    const childActual = sha256(childBytes.bytes);
    if (childActual !== expected.digest) {
      throw new VerifyRemoteError(
        'child_mismatch',
        `child manifest ${expected.digest} (${expected.platform}) re-fetched as ${childActual}`,
      );
    }
    children.push({ platform: expected.platform, digest: expected.digest });
  }

  return { repository: opts.record.repository, indexDigest: actualIndexDigest, children };
}

/**
 * Verifies a tag reference resolves to an expected digest without any
 * promotion record — the release workflows' independent "did the tag I am
 * about to deploy really point where the build said" check.
 */
export async function verifyTagResolvesTo(opts: {
  transport: RegistryTransport;
  registry: string;
  repository: string;
  tag: string;
  expectedDigest: string;
  token?: string;
}): Promise<void> {
  const client = new OciDistributionClient({
    transport: opts.transport,
    registry: opts.registry,
    repository: opts.repository,
    ...(opts.token ? { token: opts.token } : {}),
  });
  const res = await client.getManifest(opts.tag);
  const actual = sha256(res.bytes);
  if (actual !== opts.expectedDigest) {
    throw new VerifyRemoteError(
      'tag_unresolvable',
      `tag ${opts.tag} resolves to ${actual}, expected ${opts.expectedDigest}`,
    );
  }
}
