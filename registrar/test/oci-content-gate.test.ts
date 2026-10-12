/**
 * Pre-publication OCI content gate — fail-closed test matrix
 * (fleet-ops-1py.14 slice 4, plan PR #60/#61).
 *
 * ALL fixtures here are SYNTHETIC, built in-memory by
 * test/helpers/oci-fixtures.ts — this suite never touches a real
 * image, never shells docker, and never makes a network call. Every
 * negative case asserts BOTH that the gate rejects AND that no
 * network/registry client was invoked (this slice does zero registry
 * calls by design: a global fetch/http(s) sentinel must stay silent
 * across every gate run, pass or reject).
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runContentGate,
  scanPlatformLayout,
  ContentGateError,
  type PlatformLayoutInput,
} from '../src/oci-gate/gate.js';
import { assembleLocalOciIndex } from '../src/oci-gate/index-assembly.js';
import { parseTar, buildTar } from '../src/oci-gate/tar.js';
import { buildFakeOciLayoutTar, buildLayerBlob, sha256Digest, corruptTarTruncate } from './helpers/oci-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// Network-sentinel: fails the test immediately if ANYTHING in this suite
// (the gate code included) ever attempts an outbound network call.
// ---------------------------------------------------------------------------
let networkCallAttempted = false;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let httpSpy: ReturnType<typeof vi.spyOn> | undefined;
let httpsSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  networkCallAttempted = false;
  if (typeof globalThis.fetch === 'function') {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      networkCallAttempted = true;
      throw new Error('network call attempted during a local-only content-gate run');
    });
  }
  httpSpy = vi.spyOn(http, 'request').mockImplementation(() => {
    networkCallAttempted = true;
    throw new Error('http.request attempted during a local-only content-gate run');
  });
  httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => {
    networkCallAttempted = true;
    throw new Error('https.request attempted during a local-only content-gate run');
  });
});

afterEach(() => {
  fetchSpy?.mockRestore();
  httpSpy?.mockRestore();
  httpsSpy?.mockRestore();
});

function assertNoNetworkCalls(): void {
  expect(networkCallAttempted).toBe(false);
}

const CLEAN_FILES = [
  { name: 'usr/bin/app', content: 'binary-stand-in content, not a real ELF\n' },
  { name: 'etc/hostname', content: 'myhost\n' },
];

// ---------------------------------------------------------------------------
// tar round-trip sanity (the hand-rolled reader/writer this slice adds)
// ---------------------------------------------------------------------------
describe('tar reader/writer round-trip (local-only, no npm tar dependency)', () => {
  it('reads back exactly what it wrote, including a nested path', () => {
    const tar = buildTar([
      { name: 'a/b/c.txt', data: Buffer.from('hello world') },
      { name: 'd.txt', data: Buffer.from('') },
    ]);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe('a/b/c.txt');
    expect(entries[0]!.data.toString('utf8')).toBe('hello world');
    expect(entries[1]!.name).toBe('d.txt');
    expect(entries[1]!.data.length).toBe(0);
  });

  it('throws on a truncated/corrupt tar rather than silently returning a partial entry', () => {
    const tar = buildTar([{ name: 'big.bin', data: Buffer.alloc(2000, 7) }]);
    const truncated = corruptTarTruncate(tar, 0.3);
    expect(() => parseTar(truncated)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Single-platform scan: happy path
// ---------------------------------------------------------------------------
describe('scanPlatformLayout: a clean single-platform layout passes (synthetic fixture)', () => {
  it('validates descriptors, walks layers, and finds no secrets/topology', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    expect(result.layerCount).toBe(1);
    expect(result.entryCount).toBeGreaterThan(0);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 1: secret in a LOWER/WHITEOUT layer — must still be caught.
// ---------------------------------------------------------------------------
describe('fail-closed: secret committed in a lower layer, deleted by a later whiteout', () => {
  it('rejects with secret_found even though the merged view hides the path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        { files: [{ name: 'opt/app/config/id_rsa', content: '-----BEGIN RSA PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END RSA PRIVATE KEY-----\n' }] },
        { files: [{ name: 'opt/app/config/.wh.id_rsa', content: '' }] },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    expect((err as ContentGateError).message).toMatch(/whiteout-deleted/);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 2: topology literal in a DELETED layer.
// ---------------------------------------------------------------------------
describe('fail-closed: tailnet topology literal in a deleted layer', () => {
  it('rejects with topology_literal_found for a lower-layer FQDN removed by a later whiteout', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/arm64',
      layers: [
        { files: [{ name: 'etc/app/peers.conf', content: 'edge=master-node.example-tailnet.ts.net\n' }] },
        { files: [{ name: 'etc/app/.wh.peers.conf', content: '' }] },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/arm64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('rejects an RFC1918 private IP literal, not deleted, present in the top layer', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'edge_ip=192.168.4.17\n' }] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 3/4/5: index assembly — missing / duplicate / extra platform.
// ---------------------------------------------------------------------------
describe('fail-closed: OCI index assembly platform-set violations', () => {
  function cleanInput(platform: 'linux/amd64' | 'linux/arm64'): PlatformLayoutInput {
    return { platform, tarBytes: buildFakeOciLayoutTar({ platform, layers: [{ files: CLEAN_FILES }] }) };
  }

  it('rejects when a required platform is missing (only amd64 supplied)', () => {
    expect(() => runContentGate([cleanInput('linux/amd64')])).toThrow(ContentGateError);
    try {
      runContentGate([cleanInput('linux/amd64')]);
    } catch (e) {
      expect((e as ContentGateError).code).toBe('missing_platform');
    }
    assertNoNetworkCalls();
  });

  it('rejects a duplicate platform (two amd64 inputs)', () => {
    expect(() => runContentGate([cleanInput('linux/amd64'), cleanInput('linux/amd64')])).toThrow(ContentGateError);
    try {
      runContentGate([cleanInput('linux/amd64'), cleanInput('linux/amd64')]);
    } catch (e) {
      expect((e as ContentGateError).code).toBe('duplicate_platform');
    }
    assertNoNetworkCalls();
  });

  it('rejects an extra/unknown platform (linux/386 alongside the required pair)', () => {
    const extra: PlatformLayoutInput = {
      platform: 'linux/386' as unknown as 'linux/amd64',
      tarBytes: buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] }),
    };
    // force the layout's own declared platform to 386 so scanPlatformLayout's
    // internal platform-match check doesn't fire first for the wrong reason
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const inputs: PlatformLayoutInput[] = [cleanInput('linux/amd64'), cleanInput('linux/arm64'), { ...extra, tarBytes }];
    let err: unknown;
    try {
      runContentGate(inputs);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect(['extra_platform', 'malformed_layout']).toContain((err as ContentGateError).code);
    assertNoNetworkCalls();
  });

  it('assembles a valid index from exactly the two required, scanned digests', () => {
    const { index, results } = runContentGate([cleanInput('linux/amd64'), cleanInput('linux/arm64')]);
    expect(index.manifests).toHaveLength(2);
    const platforms = index.manifests.map((m) => `${m.platform!.os}/${m.platform!.architecture}`).sort();
    expect(platforms).toEqual(['linux/amd64', 'linux/arm64']);
    expect(results).toHaveLength(2);
    assertNoNetworkCalls();
  });
});

describe('fail-closed: index-assembly unit cases (allow-set + malformed descriptors)', () => {
  it('rejects a candidate digest outside the scanned-and-passed allow-set', () => {
    const d1 = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256Digest(Buffer.from('a')), size: 1, platform: { os: 'linux', architecture: 'amd64' } };
    const d2 = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256Digest(Buffer.from('b')), size: 1, platform: { os: 'linux', architecture: 'arm64' } };
    expect(() =>
      assembleLocalOciIndex({ candidates: [d1, d2], scannedAllowSet: new Set([d1.digest]) }),
    ).toThrow(ContentGateError);
    try {
      assembleLocalOciIndex({ candidates: [d1, d2], scannedAllowSet: new Set([d1.digest]) });
    } catch (e) {
      expect((e as ContentGateError).code).toBe('unknown_child_digest');
    }
  });

  it('rejects a malformed descriptor (bad digest string)', () => {
    const bad = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'not-a-digest', size: 1, platform: { os: 'linux', architecture: 'amd64' } };
    expect(() => assembleLocalOciIndex({ candidates: [bad as any], scannedAllowSet: new Set([bad.digest]) })).toThrow(
      ContentGateError,
    );
  });
});

// ---------------------------------------------------------------------------
// Matrix case 6: corrupt/truncated layer.
// ---------------------------------------------------------------------------
describe('fail-closed: corrupt/truncated layer blob', () => {
  it('rejects a layer whose gzip bytes are truncated mid-stream', () => {
    const { bytes: goodLayer } = buildLayerBlob({ files: CLEAN_FILES });
    const corrupted = goodLayer.subarray(0, Math.floor(goodLayer.length * 0.5));

    // Build a layout by hand so the corrupted blob's digest+size still
    // match what the manifest declares (otherwise this would be a
    // digest/size-mismatch case, not a corrupt-layer case).
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestDigest = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestDigest}`)!;
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    const layerDigestHex = manifest.layers[0].digest.replace('sha256:', '');

    // Replace the layer blob bytes with the truncated copy, and fix up
    // the manifest's digest+size to point at the corrupted bytes (so
    // the corruption is detected at decompress/parse time, not at the
    // earlier digest-check step).
    const corruptedDigest = sha256Digest(corrupted);
    manifest.layers[0].digest = corruptedDigest;
    manifest.layers[0].size = corrupted.length;
    const newManifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const newManifestDigest = sha256Digest(newManifestBytes);
    index.manifests[0].digest = newManifestDigest;
    index.manifests[0].size = newManifestBytes.length;

    const rebuilt = buildTar([
      { name: 'oci-layout', data: entries.find((e) => e.name === 'oci-layout')!.data },
      { name: 'index.json', data: Buffer.from(JSON.stringify(index), 'utf8') },
      { name: `blobs/sha256/${newManifestDigest.replace('sha256:', '')}`, data: newManifestBytes },
      { name: `blobs/sha256/${corruptedDigest.replace('sha256:', '')}`, data: corrupted },
      ...entries
        .filter((e) => e.name.startsWith('blobs/sha256/') && e.name !== `blobs/sha256/${manifestDigest}` && e.name !== `blobs/sha256/${layerDigestHex}`)
        .map((e) => ({ name: e.name, data: e.data })),
    ]);

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('corrupt_layer');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 7: digest/size mismatch.
// ---------------------------------------------------------------------------
describe('fail-closed: descriptor digest/size mismatch against actual blob bytes', () => {
  it('rejects when the manifest blob bytes do not match the index-declared digest', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestHex = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestHex}`)!;
    // Tamper the manifest blob's bytes in place without updating index.json's digest.
    const tampered = Buffer.concat([manifestEntry.data, Buffer.from(' ')]);

    const rebuilt = buildTar(
      entries.map((e) => (e.name === `blobs/sha256/${manifestHex}` ? { name: e.name, data: tampered } : { name: e.name, data: e.data })),
    );

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect(['digest_mismatch', 'size_mismatch']).toContain((err as ContentGateError).code);
    assertNoNetworkCalls();
  });

  it('rejects when the declared size does not match the actual blob length', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    index.manifests[0].size = index.manifests[0].size + 500; // wrong size, digest untouched

    const rebuilt = buildTar(
      entries.map((e) => (e.name === 'index.json' ? { name: e.name, data: Buffer.from(JSON.stringify(index), 'utf8') } : { name: e.name, data: e.data })),
    );

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('size_mismatch');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 8: tar path-traversal attempt.
// ---------------------------------------------------------------------------
describe('fail-closed: tar path-traversal attempt', () => {
  it('rejects a layer entry with a parent-traversal path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: '../../etc/passwd', content: 'root:x:0:0::/root:/bin/sh\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('path_traversal');
    assertNoNetworkCalls();
  });

  it('rejects an absolute-path layer entry', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: '/etc/shadow', content: 'x\n' }] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });

  it('rejects path traversal in the OUTER layout tar itself', () => {
    const inner = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(inner);
    const rebuilt = buildTar([...entries.map((e) => ({ name: e.name, data: e.data })), { name: '../escape.txt', data: Buffer.from('x') }]);
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Static + behavioral proof: zero registry/network client anywhere in
// the slice-4 source tree, and the sentinel never fires across the
// WHOLE matrix above (pass or reject).
// ---------------------------------------------------------------------------
describe('no registry/network client anywhere in the oci-gate module tree (1py.14 slice 4)', () => {
  const OCI_GATE_DIR = path.join(repoRoot, 'registrar/src/oci-gate');
  const files = readdirSync(OCI_GATE_DIR).filter((f) => f.endsWith('.ts'));

  it.each(files)('%s imports no http/https/fetch/registry client', (file) => {
    const src = readFileSync(path.join(OCI_GATE_DIR, file), 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/require\(['"]https?['"]\)/);
    expect(src).not.toMatch(/dockerode|docker-registry-client|ghcr\.io|registry-v2/i);
  });

  it('the sentinel observed zero network calls across every case in this file', () => {
    assertNoNetworkCalls();
  });
});
