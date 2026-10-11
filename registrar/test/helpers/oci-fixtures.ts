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
}

/**
 * Builds a complete single-platform OCI-layout tar: oci-layout marker,
 * index.json (one manifest), the manifest blob, a config blob, and
 * every layer blob — all content-addressed under blobs/sha256/<hex>,
 * matching `docker buildx build --output type=oci` shape.
 */
export function buildFakeOciLayoutTar(opts: FakeSingleArchLayoutOptions): Buffer {
  const [os, architecture] = opts.platform.split('/');
  const blobs: Array<{ digest: string; bytes: Buffer }> = [];

  const configBytes = Buffer.from(JSON.stringify({ architecture, os }), 'utf8');
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

  const indexObj = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifestDigest,
        size: manifestBytes.length,
        platform: { architecture, os },
      },
    ],
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
