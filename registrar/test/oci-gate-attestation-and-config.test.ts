/**
 * PR #61 review round 1 — findings #1 and #3 regression tests
 * (fleet-ops-1py.14, review by GPT6 Astra / cwdcwd on commit bc76580).
 *
 * All fixtures here are SYNTHETIC, built in-memory by
 * test/helpers/oci-fixtures.ts — never a real image, never a real
 * secret, no network calls.
 *
 * Finding #1 (gate.ts ~line 76): the gate previously took
 * index.manifests[0] as "the" manifest unconditionally. The build
 * action's real output (provenance/SBOM enabled) is an INDEX with one
 * IMAGE manifest + one ATTESTATION manifest per platform — this file
 * pins that shape is now resolved correctly by media type/annotation,
 * not position, and that attestation content is never scanned as image
 * bytes (the owner-ruled, documented policy in types.ts).
 *
 * Finding #3 (gate.ts ~line 78): the gate previously validated the
 * config descriptor's SHAPE only, never read/verified the blob against
 * digest+size, and never scanned the config JSON. This file reproduces
 * the owner's EXACT two local repro cases:
 *   (a) config blob replaced with valid JSON containing a synthetic
 *       GitHub-token-shaped string in config.Env, digest/size updated
 *       to match — must now be REJECTED (was: SUCCESS).
 *   (b) the config blob entirely deleted from the layout — must now be
 *       REJECTED (was: SUCCESS).
 */
import { describe, expect, it } from 'vitest';
import { scanPlatformLayout, ContentGateError } from '../src/oci-gate/gate.js';
import { buildFakeOciLayoutTar, sha256Digest } from './helpers/oci-fixtures.js';
import { parseTar, buildTar } from '../src/oci-gate/tar.js';

const CLEAN_FILES = [{ name: 'usr/bin/app', content: 'binary-stand-in content, not a real ELF\n' }];

describe('finding #1: nested index with image manifest + attestation manifest (real buildx --provenance shape)', () => {
  it('passes a layout shaped exactly like the real build action output (image manifest + attestation manifest)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      includeAttestation: true,
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    expect(result.layerCount).toBe(1);
  });

  it('never treats the attestation manifest as the scanned image manifest (platform stays linux/amd64, not unknown/unknown)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      includeAttestation: true,
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.manifestDescriptor.platform?.os).toBe('linux');
    expect(result.manifestDescriptor.platform?.architecture).toBe('amd64');
  });

  it('rejects a layout with ONLY an attestation manifest and no image manifest (malformed_layout, never a false pass)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      includeAttestation: true,
      mutateBlobs: (blobs) => blobs, // blobs stay; we strip the image entry from index below via a second pass
    });
    // Reach into the index.json and drop the image-manifest entry so
    // only the attestation manifest remains — simulates a corrupted/
    // truncated index that lost its runnable manifest.
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    index.manifests = index.manifests.filter((m: { annotations?: Record<string, string> }) =>
      m.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest',
    );
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
    expect((err as ContentGateError).code).toBe('malformed_layout');
  });

  it('attestation manifest blob is still structurally validated: a tampered attestation blob rejects fail-closed', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      includeAttestation: true,
    });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const attestationEntryDesc = index.manifests.find(
      (m: { annotations?: Record<string, string> }) => m.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest',
    );
    const attestationHex = attestationEntryDesc.digest.replace('sha256:', '');
    const rebuilt = buildTar(
      entries.map((e) =>
        e.name === `blobs/sha256/${attestationHex}` ? { name: e.name, data: Buffer.concat([e.data, Buffer.from(' tampered')]) } : { name: e.name, data: e.data },
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

  it('rejects more than one image-classified manifest in a single-platform layout', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    // Duplicate the single image manifest entry — two image-classified
    // descriptors is malformed, never silently pick the first.
    index.manifests.push({ ...index.manifests[0] });
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
    expect((err as ContentGateError).code).toBe('malformed_layout');
  });
});

describe('finding #3: image CONFIG blob digest/size validation and content scan', () => {
  it('owner repro (a): config blob replaced with a synthetic GitHub-token-shaped Env value — must now REJECT', () => {
    // Build a clean layout, then swap the config blob for new valid
    // JSON carrying a credential-shaped string in Env, with the
    // descriptor's digest+size updated to match the new bytes exactly
    // (so this exercises the CONTENT SCAN, not a digest-mismatch path —
    // the owner's point: the gate must read the config and reject on
    // its CONTENT, a tampered-but-internally-consistent config blob is
    // not caught by blob-integrity checks alone).
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestHex = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestHex}`)!;
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    const oldConfigHex = manifest.config.digest.replace('sha256:', '');

    const syntheticTokenShape = `ghp_${'a'.repeat(36)}`;
    const newConfigBytes = Buffer.from(
      JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Env: [`GITHUB_TOKEN=${syntheticTokenShape}`] } }),
      'utf8',
    );
    const newConfigDigest = sha256Digest(newConfigBytes);
    manifest.config.digest = newConfigDigest;
    manifest.config.size = newConfigBytes.length;
    const newManifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const newManifestDigest = sha256Digest(newManifestBytes);
    index.manifests[0].digest = newManifestDigest;
    index.manifests[0].size = newManifestBytes.length;

    const rebuilt = buildTar([
      { name: 'oci-layout', data: entries.find((e) => e.name === 'oci-layout')!.data },
      { name: 'index.json', data: Buffer.from(JSON.stringify(index), 'utf8') },
      { name: `blobs/sha256/${newManifestDigest.replace('sha256:', '')}`, data: newManifestBytes },
      { name: `blobs/sha256/${newConfigDigest.replace('sha256:', '')}`, data: newConfigBytes },
      ...entries.filter(
        (e) => e.name.startsWith('blobs/sha256/') && e.name !== `blobs/sha256/${manifestHex}` && e.name !== `blobs/sha256/${oldConfigHex}`,
      ).map((e) => ({ name: e.name, data: e.data })),
    ]);

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err, 'gate must REJECT a config.Env entry shaped like a GitHub token — it previously returned SUCCESS').toBeInstanceOf(
      ContentGateError,
    );
    expect((err as ContentGateError).code).toBe('secret_found');
  });

  it('owner repro (b): referenced config blob deleted entirely — must now REJECT (missing blob = invalid image)', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestHex = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestHex}`)!;
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    const configHex = manifest.config.digest.replace('sha256:', '');

    // Delete the config blob entry from the layout tar entirely — the
    // manifest and index still reference it by digest, but the blob
    // itself is simply absent (the owner's exact repro).
    const rebuilt = buildTar(
      entries.filter((e) => e.name !== `blobs/sha256/${configHex}`).map((e) => ({ name: e.name, data: e.data })),
    );

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err, 'gate must REJECT when the referenced config blob is missing — it previously returned SUCCESS').toBeInstanceOf(
      ContentGateError,
    );
    expect((err as ContentGateError).code).toBe('missing_blob');
  });

  it('rejects when the config blob bytes do not match the descriptor digest (tampered-but-still-present config)', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestHex = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestHex}`)!;
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    const configHex = manifest.config.digest.replace('sha256:', '');

    const rebuilt = buildTar(
      entries.map((e) =>
        e.name === `blobs/sha256/${configHex}` ? { name: e.name, data: Buffer.concat([e.data, Buffer.from(' x')]) } : { name: e.name, data: e.data },
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

  it('a clean config with ordinary Env/Labels/Cmd/history content still passes', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      configExtra: {
        config: {
          Env: ['PATH=/usr/bin', 'NODE_ENV=production'],
          Labels: { 'org.opencontainers.image.source': 'https://github.com/cwdcwd/vector-sigma' },
          Cmd: ['node', 'dist/index.js'],
          Entrypoint: ['/usr/local/bin/entrypoint.sh'],
        },
        history: [{ created_by: '/bin/sh -c npm install' }],
      },
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
  });

  it('rejects a secret-shaped value hiding in config.Labels (not just Env)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      configExtra: { config: { Labels: { built_with: `ghp_${'b'.repeat(36)}` } } },
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

  it('rejects a secret-shaped value hiding in history[].created_by', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      configExtra: { history: [{ created_by: `AWS_ACCESS_KEY_ID=AKIA${'A'.repeat(16)}` }] },
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

  it('rejects a topology literal (tailnet FQDN) hiding in config.Cmd', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
      configExtra: { config: { Cmd: ['node', '--edge=master-node.example-tailnet.ts.net'] } },
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
  });
});
