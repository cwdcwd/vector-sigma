/**
 * The image gate's building blocks, tested directly: the layer walker (decompression, traversal,
 * whiteout/opaque deletion status), layout loading, descriptor checks, nested-index resolution
 * and index assembly. The end-to-end gate tests (oci-content-gate.test.ts) prove the happy path
 * through real-shaped layouts; this file pins every fail-closed refusal to its error code.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ContentGateError, type ContentGateErrorCode } from '../src/oci-gate/errors.js';
import { assembleLocalOciIndex } from '../src/oci-gate/index-assembly.js';
import { walkAllLayers } from '../src/oci-gate/layer-walk.js';
import {
  loadManifest,
  loadOciLayout,
  resolveIndexDescriptors,
  validateDescriptorAgainstBlob,
  validateDescriptorShape,
  type LoadedOciLayout,
} from '../src/oci-gate/oci-layout.js';
import { buildTar } from '../src/oci-gate/tar.js';
import type { OciDescriptor } from '../src/oci-gate/types.js';

const TAR = 'application/vnd.oci.image.layer.v1.tar';
const TAR_GZ = 'application/vnd.oci.image.layer.v1.tar+gzip';
const INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const digestOf = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function expectGateError(fn: () => unknown, code: ContentGateErrorCode, msg?: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe(code);
    if (msg) expect((err as Error).message).toMatch(msg);
    return;
  }
  throw new Error(`expected ContentGateError(${code}), nothing was thrown`);
}

/** A layout holding the given blobs, plus the descriptors that reference them. */
function layoutOf(blobs: Array<{ bytes: Buffer; mediaType: string }>): { layout: LoadedOciLayout; descs: OciDescriptor[] } {
  const map = new Map<string, Buffer>();
  const descs = blobs.map(({ bytes, mediaType }) => {
    map.set(digestOf(bytes), bytes);
    return { mediaType, digest: digestOf(bytes), size: bytes.length };
  });
  return { layout: { index: { schemaVersion: 2, manifests: [] }, blobs: map }, descs };
}

const layer = (files: Array<{ name: string; data?: string; type?: string }>) =>
  buildTar(files.map((f) => ({ name: f.name, type: f.type, data: f.data !== undefined ? Buffer.from(f.data) : undefined })));

describe('walkAllLayers', () => {
  it('reads plain and gzip layers (gzip by media type or by magic bytes)', () => {
    const plain = layer([{ name: 'a.txt', data: 'a' }]);
    const gz = gzipSync(layer([{ name: 'b.txt', data: 'b' }]));
    const gzUnlabelled = gzipSync(layer([{ name: 'c.txt', data: 'c' }]));
    const { layout, descs } = layoutOf([
      { bytes: plain, mediaType: TAR },
      { bytes: gz, mediaType: TAR_GZ },
      { bytes: gzUnlabelled, mediaType: TAR },
    ]);
    const entries = walkAllLayers(layout, descs);
    expect(entries.map((e) => [e.name, e.layerIndex, e.data.toString()])).toEqual([
      ['a.txt', 0, 'a'],
      ['b.txt', 1, 'b'],
      ['c.txt', 2, 'c'],
    ]);
  });

  it('a gzip layer that fails to decompress is corrupt_layer', () => {
    const { layout, descs } = layoutOf([{ bytes: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad]), mediaType: TAR_GZ }]);
    expectGateError(() => walkAllLayers(layout, descs), 'corrupt_layer', /decompress/);
  });

  it('an unparseable tar is corrupt_layer', () => {
    const bad = layer([{ name: 'x', data: 'xyz' }]);
    bad.write('zzzzzzzz', 124, 'ascii'); // non-octal size field
    const { layout, descs } = layoutOf([{ bytes: bad, mediaType: TAR }]);
    expectGateError(() => walkAllLayers(layout, descs), 'corrupt_layer', /tar is corrupt/);
  });

  it('a .. segment anywhere is path_traversal; an absolute-rooted name is normalized, not refused', () => {
    const traversal = layoutOf([{ bytes: layer([{ name: 'usr/../../etc/passwd', data: 'x' }]), mediaType: TAR }]);
    expectGateError(() => walkAllLayers(traversal.layout, traversal.descs), 'path_traversal');
    const absolute = layoutOf([{ bytes: layer([{ name: '/usr/local/bin/', type: '5' }, { name: './etc/app.conf', data: 'x' }]), mediaType: TAR }]);
    expect(walkAllLayers(absolute.layout, absolute.descs).map((e) => e.name)).toEqual(['usr/local/bin', 'etc/app.conf']);
  });

  it('a layer whose bytes do not match its descriptor is refused before parsing', () => {
    const { layout, descs } = layoutOf([{ bytes: layer([{ name: 'a', data: 'a' }]), mediaType: TAR }]);
    expectGateError(() => walkAllLayers(layout, [{ ...descs[0]!, size: descs[0]!.size + 1 }]), 'size_mismatch');
  });

  it('a whiteout in a later layer marks the lower file deleted, but keeps it in the scan set', () => {
    const { layout, descs } = layoutOf([
      { bytes: layer([{ name: 'etc/secret.env', data: 'K=V' }, { name: 'root.txt', data: 'r' }]), mediaType: TAR },
      { bytes: layer([{ name: 'etc/.wh.secret.env' }, { name: '.wh.root.txt' }]), mediaType: TAR },
    ]);
    const entries = walkAllLayers(layout, descs);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['etc/secret.env']).toMatchObject({ deleted: true, isWhiteoutMarker: false });
    expect(byName['root.txt']).toMatchObject({ deleted: true });
    expect(byName['etc/.wh.secret.env']).toMatchObject({ deleted: false, isWhiteoutMarker: true });
  });

  it('a whiteout never deletes content written by a LATER layer', () => {
    const { layout, descs } = layoutOf([
      { bytes: layer([{ name: '.wh.app.conf' }]), mediaType: TAR },
      { bytes: layer([{ name: 'app.conf', data: 'new' }]), mediaType: TAR },
    ]);
    expect(walkAllLayers(layout, descs).find((e) => e.name === 'app.conf')?.deleted).toBe(false);
  });

  it('an opaque marker hides LOWER layers\' contents of that directory, but not the directory itself, siblings, or same-layer files', () => {
    const { layout, descs } = layoutOf([
      { bytes: layer([{ name: 'data/', type: '5' }, { name: 'data/old.txt', data: 'old' }, { name: 'datafile', data: 'sibling' }]), mediaType: TAR },
      { bytes: layer([{ name: 'data/.wh..wh..opq' }, { name: 'data/new.txt', data: 'new' }]), mediaType: TAR },
    ]);
    const byName = Object.fromEntries(walkAllLayers(layout, descs).map((e) => [e.name, e]));
    expect(byName['data/old.txt']!.deleted).toBe(true);
    expect(byName['data']!.deleted).toBe(false);
    expect(byName['datafile']!.deleted).toBe(false); // prefix match is by path segment, not string prefix
    // OCI image-spec: files in the same layer as an opaque whiteout are retained
    expect(byName['data/new.txt']!.deleted).toBe(false);
    expect(byName['data/.wh..wh..opq']!.isWhiteoutMarker).toBe(true);
  });

  it('an opaque marker at the layer root hides every lower file', () => {
    const { layout, descs } = layoutOf([
      { bytes: layer([{ name: 'a/b.txt', data: 'x' }]), mediaType: TAR },
      { bytes: layer([{ name: '.wh..wh..opq' }]), mediaType: TAR },
    ]);
    expect(walkAllLayers(layout, descs).find((e) => e.name === 'a/b.txt')?.deleted).toBe(true);
  });
});

describe('descriptor checks', () => {
  const bytes = Buffer.from('blob');
  const blobs = new Map([[digestOf(bytes), bytes]]);
  const good: OciDescriptor = { mediaType: MANIFEST, digest: digestOf(bytes), size: bytes.length };

  it('validateDescriptorAgainstBlob: missing, size and digest mismatches each fail closed', () => {
    expect(validateDescriptorAgainstBlob(good, blobs, 'x').equals(bytes)).toBe(true);
    expectGateError(() => validateDescriptorAgainstBlob({ ...good, digest: `sha256:${'0'.repeat(64)}` }, blobs, 'x'), 'missing_blob');
    expectGateError(() => validateDescriptorAgainstBlob({ ...good, size: 99 }, blobs, 'x'), 'size_mismatch');
    const forged = new Map([[good.digest, Buffer.from('blub')]]); // same length, different bytes
    expectGateError(() => validateDescriptorAgainstBlob(good, forged, 'x'), 'digest_mismatch');
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing mediaType', { digest: good.digest, size: 1 }],
    ['size as a string', { mediaType: MANIFEST, digest: good.digest, size: '4' }],
    ['a sha512 digest', { mediaType: MANIFEST, digest: `sha512:${'a'.repeat(128)}`, size: 1 }],
    ['an uppercase-hex digest', { mediaType: MANIFEST, digest: `sha256:${'A'.repeat(64)}`, size: 1 }],
    ['a negative size', { ...good, size: -1 }],
    ['a fractional size', { ...good, size: 1.5 }],
  ])('validateDescriptorShape refuses %s', (_label, desc) => {
    expectGateError(() => validateDescriptorShape(desc, 'x'), 'malformed_descriptor');
  });
});

describe('loadOciLayout', () => {
  const marker = { name: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') };
  const index = (manifests: unknown) => ({ name: 'index.json', data: Buffer.from(JSON.stringify({ schemaVersion: 2, manifests })) });

  it('loads blobs by digest and keeps platform/annotations on the index descriptors', () => {
    const blob = Buffer.from('{}');
    const desc = { mediaType: MANIFEST, digest: digestOf(blob), size: blob.length, platform: { os: 'linux', architecture: 'arm64' } };
    const loaded = loadOciLayout(
      buildTar([marker, index([desc]), { name: 'blobs/', type: '5' }, { name: `blobs/sha256/${desc.digest.slice(7)}`, data: blob }]),
    );
    expect(loaded.blobs.get(desc.digest)?.equals(blob)).toBe(true);
    expect(loaded.index.manifests[0]!.platform?.architecture).toBe('arm64');
  });

  it.each([
    ['a corrupt outer tar', () => { const t = buildTar([marker]); t.write('zzzzzzzz', 124, 'ascii'); return t; }, 'corrupt_layer'],
    ['an absolute entry name', () => buildTar([marker, { name: '/etc/passwd', data: Buffer.from('x') }]), 'path_traversal'],
    ['a backslash-rooted entry name', () => buildTar([marker, { name: '\\evil', data: Buffer.from('x') }]), 'path_traversal'],
    ['a .. entry name', () => buildTar([marker, { name: 'blobs/../../x', data: Buffer.from('x') }]), 'path_traversal'],
    ['a non-sha256 blob', () => buildTar([marker, index([]), { name: 'blobs/sha512/abcd', data: Buffer.from('x') }]), 'malformed_layout'],
    ['no oci-layout marker', () => buildTar([index([])]), 'malformed_layout'],
    ['a non-JSON marker', () => buildTar([{ name: 'oci-layout', data: Buffer.from('{nope') }, index([])]), 'malformed_layout'],
    ['an unsupported layout version', () => buildTar([{ name: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"2.0.0"}') }, index([])]), 'malformed_layout'],
    ['no index.json', () => buildTar([marker]), 'malformed_layout'],
    ['an index without manifests', () => buildTar([marker, { name: 'index.json', data: Buffer.from('{"schemaVersion":2}') }]), 'malformed_layout'],
    ['a malformed index descriptor', () => buildTar([marker, index([{ mediaType: MANIFEST, digest: 'sha256:short', size: 1 }])]), 'malformed_descriptor'],
  ] as const)('refuses %s', (_label, build, code) => {
    expectGateError(() => loadOciLayout(build()), code);
  });
});

describe('loadManifest and nested indexes', () => {
  const blobLayout = (bytes: Buffer) => layoutOf([{ bytes, mediaType: MANIFEST }]);

  it('refuses a manifest that is not JSON, or lacks config/layers', () => {
    const notJson = blobLayout(Buffer.from('{nope'));
    expectGateError(() => loadManifest(notJson.layout, notJson.descs[0]!), 'malformed_layout', /not valid JSON/);
    const noLayers = blobLayout(Buffer.from(JSON.stringify({ config: { mediaType: 'x', digest: `sha256:${'a'.repeat(64)}`, size: 1 } })));
    expectGateError(() => loadManifest(noLayers.layout, noLayers.descs[0]!), 'malformed_layout', /missing config\/layers/);
  });

  it('defaults schemaVersion and validates every layer descriptor', () => {
    const cfg = { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'b'.repeat(64)}`, size: 2 };
    const ok = blobLayout(Buffer.from(JSON.stringify({ config: cfg, layers: [cfg] })));
    expect(loadManifest(ok.layout, ok.descs[0]!)).toMatchObject({ schemaVersion: 2, mediaType: undefined, layers: [cfg] });
    const bad = blobLayout(Buffer.from(JSON.stringify({ config: cfg, layers: [{ ...cfg, size: -1 }] })));
    expectGateError(() => loadManifest(bad.layout, bad.descs[0]!), 'malformed_descriptor', /layers\[0\]/);
  });

  it('refuses a nested index that is not JSON or has no manifests', () => {
    for (const body of ['{nope', '{"schemaVersion":2}']) {
      const { layout, descs } = layoutOf([{ bytes: Buffer.from(body), mediaType: INDEX }]);
      expectGateError(() => resolveIndexDescriptors(layout, descs), 'malformed_layout', /nested index/);
    }
  });

  it('refuses index nesting past the depth limit (a pathological chain)', () => {
    const leaf = Buffer.from('{"manifests":[]}');
    let current = { bytes: leaf, desc: { mediaType: INDEX, digest: digestOf(leaf), size: leaf.length } };
    const blobs = new Map([[current.desc.digest, leaf]]);
    for (let i = 0; i < 10; i++) {
      const bytes = Buffer.from(JSON.stringify({ manifests: [current.desc] }));
      current = { bytes, desc: { mediaType: INDEX, digest: digestOf(bytes), size: bytes.length } };
      blobs.set(current.desc.digest, bytes);
    }
    const layout: LoadedOciLayout = { index: { schemaVersion: 2, manifests: [] }, blobs };
    expectGateError(() => resolveIndexDescriptors(layout, [current.desc]), 'malformed_layout', /maximum supported depth/);
  });
});

describe('assembleLocalOciIndex', () => {
  const d = (arch: string, n: string): OciDescriptor => ({
    mediaType: MANIFEST,
    digest: `sha256:${n.repeat(64)}`,
    size: 10,
    platform: { os: 'linux', architecture: arch },
  });
  const amd = d('amd64', 'a');
  const arm = d('arm64', 'b');
  const allow = new Set([amd.digest, arm.digest]);

  it('assembles exactly the two required platforms, in the fixed order', () => {
    const idx = assembleLocalOciIndex({ candidates: [arm, amd], scannedAllowSet: allow });
    expect(idx.manifests.map((m) => m.platform?.architecture)).toEqual(['amd64', 'arm64']);
    expect(idx.mediaType).toBe(INDEX);
  });

  it.each([
    ['a missing platform', [amd], 'missing_platform'],
    ['a duplicate platform', [amd, { ...amd, digest: `sha256:${'c'.repeat(64)}` }, arm], 'duplicate_platform'],
    ['an extra platform', [amd, arm, d('riscv64', 'c')], 'extra_platform'],
    ['a digest outside the scanned set', [amd, d('arm64', 'f')], 'unknown_child_digest'],
    ['a null candidate', [null as unknown as OciDescriptor], 'malformed_descriptor'],
    ['a malformed digest', [{ ...amd, digest: 'sha256:xyz' }], 'malformed_descriptor'],
    ['an empty mediaType', [{ ...amd, mediaType: '' }], 'malformed_descriptor'],
    ['a negative size', [{ ...amd, size: -1 }], 'malformed_descriptor'],
    ['no platform', [{ ...amd, platform: undefined }], 'malformed_descriptor'],
  ] as const)('refuses %s', (_label, candidates, code) => {
    expectGateError(() => assembleLocalOciIndex({ candidates: [...candidates], scannedAllowSet: allow }), code);
  });
});
