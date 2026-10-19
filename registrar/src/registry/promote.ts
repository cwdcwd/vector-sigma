/**
 * Exact-byte promotion + remote digest verification (fleet-ops-r3v).
 *
 * THE CONTRACT THIS MODULE EXISTS TO ENFORCE: the bytes that reach the
 * registry must be the bytes the content gate already scanned, and no
 * release TAG may exist until every one of those bytes has been
 * re-fetched from the registry and proven identical. The previous
 * behaviour (a second `buildx build --push` after the scan) had no
 * cryptographic link between scanned and published content at all.
 *
 * Ordering, deliberately:
 *   STAGING  — upload every blob, PUT every per-arch manifest and the
 *              multi-arch index BY DIGEST (a digest reference is
 *              content-addressed: it can only ever point at those exact
 *              bytes), then GET each one back and compare digests.
 *   TAGGING  — only after EVERY staging verification passed, PUT the
 *              per-arch tags and then the index tag, each followed by a
 *              read-back that must resolve to the same digest.
 *
 * A failure anywhere in staging leaves the registry with zero
 * human-facing tags. A failure while tagging stops before the index tag
 * is applied, so a partially-verified release is never advertised as one
 * coherent multi-arch release.
 */
import { createHash } from 'node:crypto';
import {
  loadOciLayout,
  loadManifest,
  resolveIndexDescriptors,
  type LoadedOciLayout,
} from '../oci-gate/oci-layout.js';
import { assembleLocalOciIndex } from '../oci-gate/index-assembly.js';
import { REQUIRED_PLATFORMS, type OciDescriptor, type RequiredPlatform } from '../oci-gate/types.js';
import { OciDistributionClient } from './oci-distribution.js';
import type { RegistryTransport } from './types.js';

export type PromotionErrorCode =
  | 'malformed_layout'
  | 'digest_mismatch'
  | 'index_mismatch'
  | 'tag_mismatch'
  | 'duplicate_platform'
  | 'missing_platform';

export class PromotionError extends Error {
  constructor(
    readonly code: PromotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}

export interface PromoteComponentOptions {
  transport: RegistryTransport;
  /** e.g. `ghcr.io` — no scheme. */
  registry: string;
  /** e.g. `cwdcwd/vector-sigma/registrar`. */
  repository: string;
  token?: string;
  /** `https` in production; overridden only by the local-registry transport test. */
  scheme?: 'http' | 'https';
  /**
   * The already-scanned `docker buildx build --output type=oci` tar for
   * each required platform. These are the exact bytes the content gate
   * accepted; nothing else may be published.
   */
  layouts: Array<{ platform: RequiredPlatform; tarBytes: Buffer }>;
  /** Tag for one platform's child manifest, e.g. `abcd1234-amd64`. */
  archTag: (platform: RequiredPlatform) => string;
  /** Tag for the assembled multi-arch index, e.g. `abcd1234`. */
  indexTag: string;
}

export interface PromotedPlatform {
  platform: RequiredPlatform;
  tag: string;
  /** Digest of the child manifest that was pushed and verified. */
  digest: string;
}

export interface PromoteResult {
  repository: string;
  perPlatform: PromotedPlatform[];
  index: { tag: string; digest: string };
}

const INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A manifest resolved from one platform's layout tar, with its exact bytes. */
interface StagedManifest {
  platform: RequiredPlatform;
  descriptor: OciDescriptor;
  bytes: Buffer;
  blobDigests: string[];
}

/**
 * Reads one platform layout and returns its single image manifest plus
 * the digests of every blob that manifest needs. Structural failures
 * surface as `malformed_layout`; this function performs no I/O.
 */
function stagePlatformLayout(platform: RequiredPlatform, layout: LoadedOciLayout): StagedManifest {
  const { imageManifestDescs } = resolveIndexDescriptors(layout, layout.index.manifests);
  if (imageManifestDescs.length !== 1) {
    throw new PromotionError(
      'malformed_layout',
      `${platform}: expected exactly one image manifest in the layout, found ${imageManifestDescs.length}`,
    );
  }
  const descriptor = imageManifestDescs[0]!;
  const manifest = loadManifest(layout, descriptor);
  const manifestBytes = layout.blobs.get(descriptor.digest);
  if (!manifestBytes) {
    throw new PromotionError('malformed_layout', `${platform}: manifest blob ${descriptor.digest} is absent from the layout`);
  }
  if (sha256(manifestBytes) !== descriptor.digest) {
    throw new PromotionError(
      'digest_mismatch',
      `${platform}: manifest bytes do not hash to the descriptor digest ${descriptor.digest}`,
    );
  }
  const blobDigests = [manifest.config.digest, ...manifest.layers.map((l) => l.digest)];
  for (const digest of blobDigests) {
    if (!layout.blobs.has(digest)) {
      throw new PromotionError('malformed_layout', `${platform}: referenced blob ${digest} is absent from the layout`);
    }
  }
  return { platform, descriptor, bytes: manifestBytes, blobDigests };
}

/**
 * Promotes one component's scanned layouts to the registry and proves the
 * result. Throws `PromotionError` on any structural failure or any
 * digest/content mismatch; never returns a result for unverified bytes.
 */
export async function promoteComponent(opts: PromoteComponentOptions): Promise<PromoteResult> {
  const client = new OciDistributionClient({
    transport: opts.transport,
    registry: opts.registry,
    repository: opts.repository,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.scheme ? { scheme: opts.scheme } : {}),
  });

  const seen = new Set<RequiredPlatform>();
  for (const l of opts.layouts) {
    if (seen.has(l.platform)) {
      throw new PromotionError('duplicate_platform', `duplicate platform supplied for promotion: ${l.platform}`);
    }
    seen.add(l.platform);
  }
  for (const required of REQUIRED_PLATFORMS) {
    if (!seen.has(required)) {
      throw new PromotionError('missing_platform', `required platform missing from promotion inputs: ${required}`);
    }
  }

  // ── STAGING ──────────────────────────────────────────────────────────
  const staged: Array<{ manifest: StagedManifest; blobs: Map<string, Buffer> }> = [];
  for (const l of opts.layouts) {
    const layout = loadOciLayout(l.tarBytes);
    staged.push({ manifest: stagePlatformLayout(l.platform, layout), blobs: layout.blobs });
  }

  for (const { manifest, blobs } of staged) {
    // Blobs first: a manifest referencing an absent blob is an invalid
    // image, and some registries reject the manifest PUT outright. HEAD
    // is only an existence hint: whether pre-existing or newly uploaded,
    // fetch every blob by digest and prove its bytes equal the scanned
    // layout bytes and hash to the requested content address before any
    // manifest or tag can be published.
    for (const digest of manifest.blobDigests) {
      const expected = blobs.get(digest);
      if (!expected || sha256(expected) !== digest) {
        throw new PromotionError('digest_mismatch', `${manifest.platform}: local blob ${digest} is absent or does not hash to its digest`);
      }
      if (!(await client.blobExists(digest))) {
        await client.uploadBlob(expected, digest);
      }
      const fetchedBlob = await client.getBlob(digest);
      if (!fetchedBlob.equals(expected) || sha256(fetchedBlob) !== digest) {
        throw new PromotionError(
          'digest_mismatch',
          `${manifest.platform}: blob read back from ${digest} differs from the scanned bytes or does not hash to that digest`,
        );
      }
    }
    // Manifest by DIGEST reference (content-addressed — cannot point at
    // anything else), then read back by that same digest and compare.
    await client.putManifest(manifest.descriptor.digest, manifest.bytes, manifest.descriptor.mediaType);
    const fetched = await client.getManifest(manifest.descriptor.digest);
    if (!fetched.bytes.equals(manifest.bytes)) {
      throw new PromotionError(
        'digest_mismatch',
        `${manifest.platform}: manifest read back from ${manifest.descriptor.digest} differs from the scanned bytes`,
      );
    }
    if (sha256(fetched.bytes) !== manifest.descriptor.digest) {
      throw new PromotionError(
        'digest_mismatch',
        `${manifest.platform}: manifest read back from ${manifest.descriptor.digest} does not hash to that digest`,
      );
    }
  }

  // The index is assembled locally from ONLY the scanned-and-passed child
  // descriptors — the same rule the gate applies — and pushed by digest
  // before any tag exists.
  const indexObj = assembleLocalOciIndex({
    candidates: staged.map((s) => ({ ...s.manifest.descriptor })),
    scannedAllowSet: new Set(staged.map((s) => s.manifest.descriptor.digest)),
  });
  const indexBytes = Buffer.from(JSON.stringify(indexObj), 'utf8');
  const indexDigest = sha256(indexBytes);

  await client.putManifest(indexDigest, indexBytes, INDEX_MEDIA_TYPE);
  const fetchedIndex = await client.getManifest(indexDigest);
  if (!fetchedIndex.bytes.equals(indexBytes)) {
    throw new PromotionError('index_mismatch', `index read back from ${indexDigest} differs from the locally assembled index`);
  }

  // ── TAGGING — only reachable if every staging verification above passed ──
  const perPlatform: PromotedPlatform[] = [];
  for (const { manifest } of staged) {
    const tag = opts.archTag(manifest.platform);
    await client.putManifest(tag, manifest.bytes, manifest.descriptor.mediaType);
    const readBack = await client.getManifest(tag);
    if (sha256(readBack.bytes) !== manifest.descriptor.digest) {
      throw new PromotionError(
        'tag_mismatch',
        `${manifest.platform}: tag ${tag} resolves to ${sha256(readBack.bytes)}, expected ${manifest.descriptor.digest}`,
      );
    }
    perPlatform.push({ platform: manifest.platform, tag, digest: manifest.descriptor.digest });
  }

  await client.putManifest(opts.indexTag, indexBytes, INDEX_MEDIA_TYPE);
  const indexReadBack = await client.getManifest(opts.indexTag);
  if (sha256(indexReadBack.bytes) !== indexDigest) {
    throw new PromotionError(
      'tag_mismatch',
      `index tag ${opts.indexTag} resolves to ${sha256(indexReadBack.bytes)}, expected ${indexDigest}`,
    );
  }

  return { repository: opts.repository, perPlatform, index: { tag: opts.indexTag, digest: indexDigest } };
}
