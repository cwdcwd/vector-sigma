/**
 * Synthetic OCI-layout fixture builder (fleet-ops-1py.14 slice 4).
 *
 * Builds tiny FAKE OCI-layout tars entirely in memory — never touches
 * real image bytes. Used exclusively by the content-gate test matrix.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildTar } from '../../src/oci-gate/tar.js';

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256Digest(buf: Buffer): string {
  return `sha256:${sha256Hex(buf)}`;
}

export interface FakeLayerSpec {
  /** Files to put in this layer's tar, pre-whiteout/opaque entries included verbatim. */
  files: Array<{ name: string; content: string; type?: string }>;
  gzip?: boolean;
}

export function buildLayerBlob(spec: FakeLayerSpec): { bytes: Buffer; mediaType: string } {
  const tar = buildTar(spec.files.map((f) => ({ name: f.name, type: f.type, data: Buffer.from(f.content, 'utf8') })));
  const gzip = spec.gzip !== false;
  const bytes = gzip ? gzipSync(tar) : tar;
  const mediaType = gzip ? 'application/vnd.oci.image.layer.v1.tar+gzip' : 'application/vnd.oci.image.layer.v1.tar';
  return { bytes, mediaType };
}

export interface FakeSingleArchLayoutOptions {
  platform: 'linux/amd64' | 'linux/arm64';
  layers: FakeLayerSpec[];
  /** Corrupt the layout after building, for negative test cases. */
  corrupt?: (ctx: { layoutEntries: Array<{ name: string; data?: Buffer }>; blobDigests: Record<string, string> }) => void;
  /** Extra OCI image-config JSON fields (Env/Labels/Cmd/Entrypoint/history, etc). */
  configExtra?: Record<string, unknown>;
  /**
   * Include a buildx-shaped attestation manifest alongside the image
   * manifest in index.json (fleet-ops-1py.14 fix for PR #61 review
   * finding #1 — the REAL buildx --provenance/--sbom shape: an index
   * with one image manifest + one attestation manifest per arch).
   */
  includeAttestation?: boolean;
  /**
   * Post-build hook to corrupt/delete a specific blob by digest (used
   * by the config-blob-deleted / config-blob-tampered negative tests).
   * Receives the full blob list (including config/manifest/layers) and
   * may mutate it in place (e.g. filter out an entry, or replace bytes).
   */
  mutateBlobs?: (blobs: Array<{ digest: string; bytes: Buffer }>) => Array<{ digest: string; bytes: Buffer }>;
}

/**
 * Builds a complete single-platform OCI-layout tar: oci-layout marker,
 * index.json (one manifest, optionally plus one attestation manifest),
 * the manifest blob, a config blob, and every layer blob — all
 * content-addressed under blobs/sha256/<hex>, matching `docker buildx
 * build --output type=oci` shape.
 */
export function buildFakeOciLayoutTar(opts: FakeSingleArchLayoutOptions): Buffer {
  const [os, architecture] = opts.platform.split('/');
  let blobs: Array<{ digest: string; bytes: Buffer }> = [];

  const configBytes = Buffer.from(JSON.stringify({ architecture, os, ...(opts.configExtra ?? {}) }), 'utf8');
  const configDigest = sha256Digest(configBytes);
  blobs.push({ digest: configDigest, bytes: configBytes });

  const layerDescs = opts.layers.map((layerSpec) => {
    const { bytes, mediaType } = buildLayerBlob(layerSpec);
    const digest = sha256Digest(bytes);
    blobs.push({ digest, bytes });
    return { mediaType, digest, size: bytes.length };
  });

  const manifestObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: configBytes.length },
    layers: layerDescs,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifestObj), 'utf8');
  const manifestDigest = sha256Digest(manifestBytes);
  blobs.push({ digest: manifestDigest, bytes: manifestBytes });

  const indexManifests: Array<Record<string, unknown>> = [
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: manifestDigest,
      size: manifestBytes.length,
      platform: { architecture, os },
    },
  ];

  if (opts.includeAttestation) {
    // Real buildx attestation-manifest shape: empty-JSON config + an
    // in-toto layer blob, platform unknown/unknown, tagged with the
    // reference annotations buildx actually sets (see
    // docs.docker.com/build/metadata/attestations/attestation-storage).
    const emptyConfigBytes = Buffer.from('{}', 'utf8');
    const emptyConfigDigest = sha256Digest(emptyConfigBytes);
    blobs.push({ digest: emptyConfigDigest, bytes: emptyConfigBytes });

    const inTotoBytes = Buffer.from(JSON.stringify({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1' }), 'utf8');
    const inTotoDigest = sha256Digest(inTotoBytes);
    blobs.push({ digest: inTotoDigest, bytes: inTotoBytes });

    const attestationObj = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: emptyConfigDigest, size: emptyConfigBytes.length },
      layers: [{ mediaType: 'application/vnd.in-toto+json', digest: inTotoDigest, size: inTotoBytes.length }],
      subject: { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestDigest, size: manifestBytes.length },
    };
    const attestationBytes = Buffer.from(JSON.stringify(attestationObj), 'utf8');
    const attestationDigest = sha256Digest(attestationBytes);
    blobs.push({ digest: attestationDigest, bytes: attestationBytes });

    indexManifests.push({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: attestationDigest,
      size: attestationBytes.length,
      platform: { architecture: 'unknown', os: 'unknown' },
      annotations: {
        'vnd.docker.reference.digest': manifestDigest,
        'vnd.docker.reference.type': 'attestation-manifest',
      },
    });
  }

  if (opts.mutateBlobs) {
    blobs = opts.mutateBlobs(blobs);
  }

  const indexObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: indexManifests,
  };
  const indexBytes = Buffer.from(JSON.stringify(indexObj), 'utf8');

  const ociLayoutBytes = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }), 'utf8');

  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'oci-layout', data: ociLayoutBytes },
    { name: 'index.json', data: indexBytes },
    ...blobs.map((b) => ({ name: `blobs/sha256/${b.digest.replace('sha256:', '')}`, data: b.bytes })),
  ];

  return buildTar(entries);
}

export function corruptTarTruncate(tarBytes: Buffer, cutRatio = 0.6): Buffer {
  return tarBytes.subarray(0, Math.floor(tarBytes.length * cutRatio));
}

export interface FakeNestedIndexLayoutOptions {
  platform: 'linux/amd64' | 'linux/arm64';
  layers: FakeLayerSpec[];
  configExtra?: Record<string, unknown>;
  /** Omit the image manifest from the NESTED index (leaves only the attestation manifest), for a negative test. */
  omitImageManifest?: boolean;
  /** Corrupt the nested index blob's bytes after it is built (digest/size still point at the pre-corruption blob unless the caller also recomputes the outer descriptor). */
  tamperNestedIndexBytes?: (bytes: Buffer) => Buffer;
}

/**
 * Builds the REAL `docker buildx build --output type=oci
 * --provenance=...` shape: outer index.json references exactly ONE
 * descriptor whose mediaType is itself `application/vnd.oci.image.
 * index.v1+json` (a NESTED index blob, content-addressed like any
 * other blob) — and THAT nested index contains the real image
 * manifest (config+layers) plus one attestation manifest sibling.
 *
 * This reproduces PR #61 review round 2 finding #1 (the owner's live
 * CI repro, run 38309617753): the previous classifier only looked at
 * siblings in the OUTER index and mislabeled this nested-index
 * descriptor as an image manifest, handing it straight to loadManifest
 * which then threw "missing config/layers".
 */
export function buildFakeNestedIndexOciLayoutTar(opts: FakeNestedIndexLayoutOptions): Buffer {
  const [os, architecture] = opts.platform.split('/');
  let blobs: Array<{ digest: string; bytes: Buffer }> = [];

  const configBytes = Buffer.from(JSON.stringify({ architecture, os, ...(opts.configExtra ?? {}) }), 'utf8');
  const configDigest = sha256Digest(configBytes);
  blobs.push({ digest: configDigest, bytes: configBytes });

  const layerDescs = opts.layers.map((layerSpec) => {
    const { bytes, mediaType } = buildLayerBlob(layerSpec);
    const digest = sha256Digest(bytes);
    blobs.push({ digest, bytes });
    return { mediaType, digest, size: bytes.length };
  });

  const manifestObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: configBytes.length },
    layers: layerDescs,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifestObj), 'utf8');
  const manifestDigest = sha256Digest(manifestBytes);
  blobs.push({ digest: manifestDigest, bytes: manifestBytes });

  // Attestation manifest (real buildx shape), same as the flat case.
  const emptyConfigBytes = Buffer.from('{}', 'utf8');
  const emptyConfigDigest = sha256Digest(emptyConfigBytes);
  blobs.push({ digest: emptyConfigDigest, bytes: emptyConfigBytes });

  const inTotoBytes = Buffer.from(JSON.stringify({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1' }), 'utf8');
  const inTotoDigest = sha256Digest(inTotoBytes);
  blobs.push({ digest: inTotoDigest, bytes: inTotoBytes });

  const attestationObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: emptyConfigDigest, size: emptyConfigBytes.length },
    layers: [{ mediaType: 'application/vnd.in-toto+json', digest: inTotoDigest, size: inTotoBytes.length }],
    subject: { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestDigest, size: manifestBytes.length },
  };
  const attestationBytes = Buffer.from(JSON.stringify(attestationObj), 'utf8');
  const attestationDigest = sha256Digest(attestationBytes);
  blobs.push({ digest: attestationDigest, bytes: attestationBytes });

  const nestedIndexManifests: Array<Record<string, unknown>> = [];
  if (!opts.omitImageManifest) {
    nestedIndexManifests.push({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: manifestDigest,
      size: manifestBytes.length,
      platform: { architecture, os },
    });
  }
  nestedIndexManifests.push({
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: attestationDigest,
    size: attestationBytes.length,
    platform: { architecture: 'unknown', os: 'unknown' },
    annotations: {
      'vnd.docker.reference.digest': manifestDigest,
      'vnd.docker.reference.type': 'attestation-manifest',
    },
  });

  const nestedIndexObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: nestedIndexManifests,
  };
  let nestedIndexBytes = Buffer.from(JSON.stringify(nestedIndexObj), 'utf8');
  if (opts.tamperNestedIndexBytes) {
    nestedIndexBytes = opts.tamperNestedIndexBytes(nestedIndexBytes);
  }
  const nestedIndexDigest = sha256Digest(nestedIndexBytes);
  blobs.push({ digest: nestedIndexDigest, bytes: nestedIndexBytes });

  // Outer index.json references ONLY the nested index descriptor per
  // platform — no image/attestation manifest descriptor sits directly
  // at the outer level, which is the real buildx --provenance shape
  // this fixture reproduces.
  const outerIndexObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: nestedIndexDigest,
        size: nestedIndexBytes.length,
        platform: { architecture, os },
      },
    ],
  };
  const outerIndexBytes = Buffer.from(JSON.stringify(outerIndexObj), 'utf8');

  const ociLayoutBytes = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }), 'utf8');

  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'oci-layout', data: ociLayoutBytes },
    { name: 'index.json', data: outerIndexBytes },
    ...blobs.map((b) => ({ name: `blobs/sha256/${b.digest.replace('sha256:', '')}`, data: b.bytes })),
  ];

  return buildTar(entries);
}
