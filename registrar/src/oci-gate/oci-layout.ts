/**
 * OCI-layout loader + descriptor validation (fleet-ops-1py.14 slice 4).
 *
 * Input shape: a single tar byte buffer as produced by
 * `docker buildx build --output type=oci` — containing `oci-layout`,
 * `index.json`, and `blobs/<alg>/<hex>` content-addressed blobs. This
 * module is 100% local/offline: it never makes a network call and
 * never shells out to docker/skopeo/registry clients.
 *
 * Every descriptor encountered (the index's manifest list, each
 * platform manifest, each manifest's config + layers) is validated
 * against the ACTUAL blob bytes before anything downstream trusts it:
 * the digest is recomputed (sha256) and compared, the size is
 * compared, and the declared mediaType must be a string. Any mismatch
 * throws — the gate never proceeds past a tampered or corrupt blob.
 */
import { createHash } from 'node:crypto';
import { parseTar, type TarEntry } from './tar.js';
import { ContentGateError } from './errors.js';
import { classifyIndexDescriptor, type OciDescriptor, type OciIndex, type OciManifest } from './types.js';

export interface LoadedOciLayout {
  index: OciIndex;
  /** blob digest ("sha256:<hex>") -> raw bytes, for every blob present in the layout tar. */
  blobs: Map<string, Buffer>;
}

function sha256(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function assertNoTraversal(name: string): void {
  // Reject absolute paths, parent-traversal segments, and any decoded
  // path that would escape the extraction root — tar-slip is a known
  // supply-chain vector and this gate must refuse it outright rather
  // than merely skip the one bad entry.
  if (name.startsWith('/') || name.startsWith('\\')) {
    throw new ContentGateError('path_traversal', `tar entry has an absolute path: "${name}"`);
  }
  const normalized = name.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    throw new ContentGateError('path_traversal', `tar entry attempts path traversal: "${name}"`);
  }
}

function parseJsonEntry(entries: TarEntry[], name: string, what: string): unknown {
  const entry = entries.find((e) => e.name === name || e.name === `./${name}`);
  if (!entry) {
    throw new ContentGateError('malformed_layout', `OCI layout is missing required file: ${what} (${name})`);
  }
  try {
    return JSON.parse(entry.data.toString('utf8'));
  } catch (err) {
    throw new ContentGateError('malformed_layout', `OCI layout's ${what} is not valid JSON`, err);
  }
}

export function validateDescriptorShape(desc: unknown, where: string): OciDescriptor {
  if (
    typeof desc !== 'object' ||
    desc === null ||
    typeof (desc as Record<string, unknown>).mediaType !== 'string' ||
    typeof (desc as Record<string, unknown>).digest !== 'string' ||
    typeof (desc as Record<string, unknown>).size !== 'number'
  ) {
    throw new ContentGateError('malformed_descriptor', `malformed OCI descriptor at ${where}`, desc);
  }
  const d = desc as OciDescriptor;
  if (!/^sha256:[0-9a-f]{64}$/.test(d.digest)) {
    throw new ContentGateError('malformed_descriptor', `descriptor at ${where} has a malformed digest: "${d.digest}"`);
  }
  if (!Number.isInteger(d.size) || d.size < 0) {
    throw new ContentGateError('malformed_descriptor', `descriptor at ${where} has a malformed size: ${d.size}`);
  }
  return d;
}

/** Validates one descriptor's digest+size against the actual blob bytes. Throws fail-closed. */
export function validateDescriptorAgainstBlob(desc: OciDescriptor, blobs: Map<string, Buffer>, where: string): Buffer {
  const bytes = blobs.get(desc.digest);
  if (!bytes) {
    throw new ContentGateError('missing_blob', `blob referenced at ${where} is absent from the layout: ${desc.digest}`);
  }
  if (bytes.length !== desc.size) {
    throw new ContentGateError(
      'size_mismatch',
      `blob size mismatch at ${where}: descriptor says ${desc.size}, actual blob is ${bytes.length} bytes`,
    );
  }
  const actualDigest = sha256(bytes);
  if (actualDigest !== desc.digest) {
    throw new ContentGateError(
      'digest_mismatch',
      `blob digest mismatch at ${where}: descriptor says ${desc.digest}, recomputed ${actualDigest}`,
    );
  }
  return bytes;
}

/**
 * Parses an OCI-layout tar export into its index + content-addressed
 * blob map, with every tar entry name path-traversal checked. Does
 * NOT yet validate descriptor-vs-bytes (that happens per-manifest in
 * `loadManifest`/`loadConfig` so callers control exactly what subset
 * of the layout they need to touch).
 */
export function loadOciLayout(tarBytes: Buffer): LoadedOciLayout {
  let entries: TarEntry[];
  try {
    entries = parseTar(tarBytes);
  } catch (err) {
    throw new ContentGateError('corrupt_layer', `OCI layout tar is corrupt/truncated: ${(err as Error).message}`, err);
  }

  const blobs = new Map<string, Buffer>();
  for (const entry of entries) {
    assertNoTraversal(entry.name);
    if (entry.type !== '0' && entry.type !== '\0') continue; // directories, etc.
    const m = entry.name.match(/^(?:\.\/)?blobs\/([a-z0-9]+)\/([0-9a-f]+)$/);
    if (!m) continue;
    const [, alg, hex] = m;
    if (alg !== 'sha256') {
      // Unsupported digest algorithm present in the layout — fail
      // closed rather than silently skip bytes the gate cannot verify.
      throw new ContentGateError('malformed_layout', `OCI layout blob uses unsupported digest algorithm: ${alg}`);
    }
    blobs.set(`sha256:${hex}`, entry.data);
  }

  const layoutDecl = parseJsonEntry(entries, 'oci-layout', 'oci-layout marker') as { imageLayoutVersion?: string };
  if (layoutDecl.imageLayoutVersion !== '1.0.0') {
    throw new ContentGateError(
      'malformed_layout',
      `unsupported imageLayoutVersion: "${String(layoutDecl.imageLayoutVersion)}"`,
    );
  }

  const indexRaw = parseJsonEntry(entries, 'index.json', 'index.json') as Record<string, unknown>;
  if (!Array.isArray(indexRaw.manifests)) {
    throw new ContentGateError('malformed_layout', 'index.json has no manifests array');
  }
  const rawManifests = indexRaw.manifests as unknown[];
  const manifests = rawManifests.map((m, i) => validateDescriptorShape(m, `index.json manifests[${i}]`));
  const index: OciIndex = {
    schemaVersion: typeof indexRaw.schemaVersion === 'number' ? indexRaw.schemaVersion : 2,
    mediaType: typeof indexRaw.mediaType === 'string' ? indexRaw.mediaType : undefined,
    manifests: manifests.map((m, i) => ({
      ...m,
      platform: (rawManifests[i] as Record<string, unknown>).platform as OciDescriptor['platform'],
      annotations: (rawManifests[i] as Record<string, unknown>).annotations as OciDescriptor['annotations'],
    })),
  };

  return { index, blobs };
}

/**
 * OCI/Docker media types that mean "this descriptor is itself an
 * index/manifest-list, not a manifest" — both the OCI spec's own
 * index media type and the legacy Docker manifest-list type that some
 * tooling still emits.
 */
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

function isIndexMediaType(mediaType: string | undefined): boolean {
  return mediaType !== undefined && INDEX_MEDIA_TYPES.has(mediaType);
}

/** Parses a nested index blob's raw bytes into shape-validated descriptors (annotations/platform preserved, same as the outer-index parse in loadOciLayout). */
function parseNestedIndexManifests(bytes: Buffer, where: string): OciDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new ContentGateError('malformed_layout', `nested index ${where} is not valid JSON`, err);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.manifests)) {
    throw new ContentGateError('malformed_layout', `nested index ${where} has no manifests array`);
  }
  const rawManifests = obj.manifests as unknown[];
  return rawManifests.map((m, i) => {
    const shape = validateDescriptorShape(m, `nested index ${where} manifests[${i}]`);
    const raw = rawManifests[i] as Record<string, unknown>;
    return {
      ...shape,
      platform: raw.platform as OciDescriptor['platform'],
      annotations: raw.annotations as OciDescriptor['annotations'],
    };
  });
}

export interface ResolvedIndexDescriptors {
  imageManifestDescs: OciDescriptor[];
  attestationDescs: OciDescriptor[];
}

/** Hard ceiling on nested-index depth — guards against a pathological or cyclic layout rather than an unbounded/infinite recursion. Real buildx output nests at most one level deep (outer index -> per-platform nested index -> image + attestation manifests); this ceiling is generous headroom, not a hardcoded "exactly one level" assumption. */
const MAX_INDEX_NESTING_DEPTH = 8;

/**
 * Recursively resolves a list of index-level descriptors (the outer
 * index.json `manifests` array, or — through recursion — a nested
 * index's own `manifests` array) into the two kinds of LEAF manifest
 * descriptor this gate ultimately cares about: runnable IMAGE
 * manifests (have config+layers) and ATTESTATION manifests (do not,
 * and are never scanned as image content — see classifyIndexDescriptor
 * for the owner-ruled policy).
 *
 * `docker buildx build --output type=oci --provenance=...` can emit an
 * ADDITIONAL index level: the outer index.json references a
 * descriptor whose mediaType is itself an OCI/Docker index type (a
 * nested index blob), and THAT nested index in turn contains the real
 * image manifest + attestation manifest descriptors (PR #61 review
 * round 2 finding #1 — live CI proof: run 38309617753, manifest-list
 * digest sha256:2339d41c6f5423f381ea5380cca03b35865341fa219e0f0496999ded78c25f95
 * rejected "missing config/layers" because the outer descriptor was an
 * index, not an image manifest, and was handed straight to
 * loadManifest). Dispatch is by descriptor mediaType — any descriptor
 * whose mediaType means "this is an index" is resolved (digest/size
 * validated against its actual blob, same rigor as every other blob in
 * this module) and recursed into; everything else is classified
 * image-vs-attestation at that depth and treated as a leaf. No fixed
 * nesting depth is assumed — recursion continues until every
 * descriptor resolves to a non-index media type, bounded only by
 * MAX_INDEX_NESTING_DEPTH as a fail-closed guard against a pathological
 * or cyclic layout.
 */
export function resolveIndexDescriptors(
  layout: LoadedOciLayout,
  descriptors: OciDescriptor[],
  depth = 0,
): ResolvedIndexDescriptors {
  if (depth > MAX_INDEX_NESTING_DEPTH) {
    throw new ContentGateError(
      'malformed_layout',
      `OCI index nesting exceeds the maximum supported depth (${MAX_INDEX_NESTING_DEPTH}) — refusing to recurse further`,
    );
  }

  const imageManifestDescs: OciDescriptor[] = [];
  const attestationDescs: OciDescriptor[] = [];

  for (const desc of descriptors) {
    if (isIndexMediaType(desc.mediaType)) {
      const bytes = validateDescriptorAgainstBlob(desc, layout.blobs, `nested index ${desc.digest}`);
      const nestedDescs = parseNestedIndexManifests(bytes, desc.digest);
      const nested = resolveIndexDescriptors(layout, nestedDescs, depth + 1);
      imageManifestDescs.push(...nested.imageManifestDescs);
      attestationDescs.push(...nested.attestationDescs);
    } else if (classifyIndexDescriptor(desc) === 'attestation') {
      attestationDescs.push(desc);
    } else {
      imageManifestDescs.push(desc);
    }
  }

  return { imageManifestDescs, attestationDescs };
}

/**
 * Validates + parses one platform manifest's descriptor against actual
 * bytes. ATTESTATION-MANIFEST descriptors (classifyIndexDescriptor ==
 * 'attestation') are structurally validated here too (digest/size
 * against the real blob — fail-closed on tamper/corruption/missing
 * blob) but their JSON is never required to carry config/layers:
 * buildx attestation manifests are shaped
 * `{ schemaVersion, mediaType, artifactType, config, layers, subject }`
 * where `config` is the OCI EMPTY descriptor and `layers` holds the
 * in-toto/SBOM blob(s) — a structurally different, non-runnable shape
 * this gate does not scan as image content (see classifyIndexDescriptor
 * in types.ts for the full owner-ruled attestation policy).
 */
export function loadManifest(layout: LoadedOciLayout, desc: OciDescriptor): OciManifest {
  const bytes = validateDescriptorAgainstBlob(desc, layout.blobs, `manifest ${desc.digest}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new ContentGateError('malformed_layout', `manifest ${desc.digest} is not valid JSON`, err);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.config !== 'object' || obj.config === null || !Array.isArray(obj.layers)) {
    throw new ContentGateError('malformed_layout', `manifest ${desc.digest} is missing config/layers`);
  }
  const config = validateDescriptorShape(obj.config, `manifest ${desc.digest} config`);
  const layers = obj.layers.map((l, i) => validateDescriptorShape(l, `manifest ${desc.digest} layers[${i}]`));
  return {
    schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 2,
    mediaType: typeof obj.mediaType === 'string' ? obj.mediaType : undefined,
    config,
    layers,
  };
}

/**
 * Validates the image CONFIG blob referenced by a manifest's `config`
 * descriptor (fleet-ops-1py.14 fix for PR #61 review finding #3):
 * recomputes the config blob's real sha256 digest + byte length and
 * compares against the descriptor exactly (same rigor `loadManifest`
 * already applies to the manifest blob and `walkAllLayers` applies to
 * every layer blob — the config descriptor was previously SHAPE-only
 * checked and never read/verified against its own referenced bytes),
 * then parses the config JSON. Throws fail-closed (`missing_blob` /
 * `digest_mismatch` / `size_mismatch` / `malformed_layout`) exactly
 * like every other blob-integrity check in this module — a missing or
 * tampered config blob is an invalid image, full stop, and must never
 * be reported as a passing scan.
 */
export function loadConfig(layout: LoadedOciLayout, configDesc: OciDescriptor): Record<string, unknown> {
  const bytes = validateDescriptorAgainstBlob(configDesc, layout.blobs, `config ${configDesc.digest}`);
  try {
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new ContentGateError('malformed_layout', `config ${configDesc.digest} is not valid JSON`, err);
  }
}
