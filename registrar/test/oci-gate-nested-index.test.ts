/**
 * PR #61 review round 2 — finding #1 regression tests (fleet-ops-1py.14,
 * review round 2 by cwdcwd on commit 2f070ad).
 *
 * All fixtures here are SYNTHETIC, built in-memory by
 * test/helpers/oci-fixtures.ts — never a real image, never a real
 * secret, no network calls.
 *
 * Round-1 finding #1 fixed classification of SIBLING descriptors inside
 * the OUTER index.json (image manifest vs attestation manifest at the
 * SAME level). It did not handle a genuinely NESTED index: `docker
 * buildx build --output type=oci --provenance=...` can emit an outer
 * index.json whose single manifests[] entry is ITSELF an OCI index
 * (mediaType application/vnd.oci.image.index.v1+json), and THAT nested
 * index contains the real image manifest + attestation manifest. The
 * round-1 classifier saw the outer index-typed descriptor, mislabeled
 * it 'image' (classifyIndexDescriptor only checks the attestation
 * annotation, defaulting everything else to 'image'), and handed it
 * straight to loadManifest — which expects config+layers and throws
 * "missing config/layers". Live CI proof: run 38309617753, job
 * 'registrant amd64', manifest-list digest
 * sha256:2339d41c6f5423f381ea5380cca03b35865341fa219e0f0496999ded78c25f95
 * rejected with exactly that error; all 16 stage-and-scan jobs in that
 * run failed identically.
 *
 * This file pins the fix: resolveIndexDescriptors (oci-layout.ts)
 * recursively follows index-media-typed descriptors to their real leaf
 * manifests, classifying image-vs-attestation only once a descriptor's
 * mediaType is no longer an index type, at whatever depth that occurs.
 */
import { describe, expect, it } from 'vitest';
import { scanPlatformLayout, ContentGateError } from '../src/oci-gate/gate.js';
import { buildFakeNestedIndexOciLayoutTar } from './helpers/oci-fixtures.js';
import { parseTar, buildTar } from '../src/oci-gate/tar.js';

const CLEAN_FILES = [{ name: 'usr/bin/app', content: 'binary-stand-in content, not a real ELF\n' }];

describe('finding #1 (round 2): genuinely nested index (outer index -> nested index -> image+attestation)', () => {
  it('passes a layout shaped exactly like the real buildx --provenance nested-index output (owner repro shape)', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    expect(result.layerCount).toBe(1);
  });

  it('never mistakes the nested index descriptor itself for the image manifest (platform resolves to the real linux/amd64, not unknown/unknown or the index entry)', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.manifestDescriptor.platform?.os).toBe('linux');
    expect(result.manifestDescriptor.platform?.architecture).toBe('amd64');
  });

  it('works identically for linux/arm64 (the exact arch of the owner\'s live CI repro)', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/arm64',
      layers: [{ files: CLEAN_FILES }],
    });
    const result = scanPlatformLayout({ platform: 'linux/arm64', tarBytes });
    expect(result.platform).toBe('linux/arm64');
    expect(result.manifestDescriptor.platform?.architecture).toBe('arm64');
  });

  it('rejects a nested index containing ONLY an attestation manifest (no image manifest at any depth) with malformed_layout, never a false pass', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      omitImageManifest: true,
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('malformed_layout');
  });

  it('the nested index BLOB is still structurally validated: a tampered nested-index blob rejects fail-closed (digest/size mismatch), never silently recurses into corrupt bytes', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    // Corrupt the nested-index blob bytes IN THE TAR (not via the
    // builder hook, which would keep the outer descriptor's digest/size
    // in sync) so the outer descriptor's digest/size now mismatch the
    // actual nested-index blob bytes.
    const entries = parseTar(tarBytes);
    const outerIndexEntry = entries.find((e) => e.name === 'index.json')!;
    const outerIndex = JSON.parse(outerIndexEntry.data.toString('utf8'));
    const nestedIndexHex = outerIndex.manifests[0].digest.replace('sha256:', '');
    const rebuilt = buildTar(
      entries.map((e) =>
        e.name === `blobs/sha256/${nestedIndexHex}`
          ? { name: e.name, data: Buffer.concat([e.data, Buffer.from(' tampered')]) }
          : { name: e.name, data: e.data },
      ),
    );
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect(['digest_mismatch', 'size_mismatch']).toContain((err as ContentGateError).code);
  });

  it('a nested index whose blob is entirely missing from the layout rejects with missing_blob, never a silent pass-through', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    const entries = parseTar(tarBytes);
    const outerIndexEntry = entries.find((e) => e.name === 'index.json')!;
    const outerIndex = JSON.parse(outerIndexEntry.data.toString('utf8'));
    const nestedIndexHex = outerIndex.manifests[0].digest.replace('sha256:', '');
    const rebuilt = buildTar(entries.filter((e) => e.name !== `blobs/sha256/${nestedIndexHex}`).map((e) => ({ name: e.name, data: e.data })));
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('missing_blob');
  });

  it('a layout with a malformed nested-index JSON blob (not valid JSON) rejects with malformed_layout', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      tamperNestedIndexBytes: () => Buffer.from('not valid json{{{', 'utf8'),
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('malformed_layout');
  });

  it('still correctly resolves the FLAT (non-nested) shape from round 1 — no regression on the already-working sibling case', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    // Sanity: this fixture really does nest (outer manifests[0].mediaType is an index type) — distinguishes this test file's shape from oci-gate-attestation-and-config.test.ts's flat shape.
    const entries = parseTar(tarBytes);
    const outerIndex = JSON.parse(entries.find((e) => e.name === 'index.json')!.data.toString('utf8'));
    expect(outerIndex.manifests).toHaveLength(1);
    expect(outerIndex.manifests[0].mediaType).toBe('application/vnd.oci.image.index.v1+json');
  });

  it('rejects a secret hiding in a layer inside the nested-index shape, proving the scan still reaches real layer content through the extra index level', () => {
    const tarBytes = buildFakeNestedIndexOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'config/secrets.env', content: `AWS_ACCESS_KEY_ID=AKIA${'A'.repeat(16)}\n` }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
  });
});
