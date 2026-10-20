/**
 * Exact-byte promotion + remote verification (fleet-ops-r3v).
 *
 * The defect class this suite closes: the release workflows previously
 * ran a SECOND `buildx build --push` after the content scan, so there
 * was no cryptographic link between the scanned bytes and the published
 * bytes. Every test here asserts both halves of the fix —
 *   1. BYTE IDENTITY: what the registry ends up holding equals the exact
 *      bytes of the scanned layouts (never a rebuild).
 *   2. FAIL-STOP ORDERING: no release tag exists unless every staged
 *      byte was read back and verified first, and a verification failure
 *      leaves the registry tagless rather than half-advertised.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promoteComponent, PromotionError } from '../src/registry/promote.js';
import { FakeRegistry, sha256Digest } from './helpers/fake-registry.js';
import { buildFakeOciLayoutTar } from './helpers/oci-fixtures.js';
import type { RequiredPlatform } from '../src/oci-gate/types.js';

const REPOSITORY = 'cwdcwd/vector-sigma/registrar';

function layouts(): Array<{ platform: RequiredPlatform; tarBytes: Buffer }> {
  return [
    {
      platform: 'linux/amd64',
      tarBytes: buildFakeOciLayoutTar({
        platform: 'linux/amd64',
        layers: [{ files: [{ name: 'app/index.js', content: 'amd64 image content\n' }] }],
      }),
    },
    {
      platform: 'linux/arm64',
      tarBytes: buildFakeOciLayoutTar({
        platform: 'linux/arm64',
        layers: [{ files: [{ name: 'app/index.js', content: 'arm64 image content\n' }] }],
      }),
    },
  ];
}

function opts(fake: FakeRegistry, overrides: Partial<Parameters<typeof promoteComponent>[0]> = {}) {
  return {
    transport: fake,
    registry: 'ghcr.io',
    repository: REPOSITORY,
    layouts: layouts(),
    archTag: (p: RequiredPlatform) => `abcd1234-${p === 'linux/amd64' ? 'amd64' : 'arm64'}`,
    indexTag: 'abcd1234',
    ...overrides,
  };
}

describe('exact-byte promotion: the registry stores the scanned bytes, not a rebuild', () => {
  it('stores every layer and config blob at the digest its own bytes hash to', async () => {
    const fake = new FakeRegistry();
    const input = layouts();
    await promoteComponent(opts(fake));

    // Recompute expected digests directly from the scan inputs.
    const expected = new Set<string>();
    for (const l of input) {
      for (const [digest, bytes] of digestsOfLayoutBytes(l.tarBytes)) {
        expected.add(digest);
        expect(fake.storedBlob(digest)?.equals(bytes), `blob ${digest} must be stored verbatim`).toBe(true);
      }
    }
    expect(expected.size).toBeGreaterThan(0);
  });

  it('stores each per-arch manifest byte-for-byte and returns the matching digest', async () => {
    const fake = new FakeRegistry();
    const result = await promoteComponent(opts(fake));
    for (const p of result.perPlatform) {
      const stored = fake.storedManifest(REPOSITORY, p.digest);
      expect(stored, `manifest ${p.digest} must be retrievable by digest`).toBeDefined();
      expect(sha256Digest(stored!.bytes)).toBe(p.digest);
    }
  });

  it('assembles the index from only the scanned child digests and pushes it by digest first', async () => {
    const fake = new FakeRegistry();
    const result = await promoteComponent(opts(fake));
    const indexBytes = fake.storedManifest(REPOSITORY, result.index.digest)?.bytes;
    expect(indexBytes).toBeDefined();
    const parsed = JSON.parse(indexBytes!.toString('utf8')) as { manifests: Array<{ digest: string }> };
    expect(parsed.manifests.map((m) => m.digest).sort()).toEqual(result.perPlatform.map((p) => p.digest).sort());
  });
});

describe('fail-stop ordering: tags are applied strictly after verification', () => {
  it('applies the first tag only after all blobs, both manifests and the index have been verified', async () => {
    const fake = new FakeRegistry();
    const input = layouts();
    await promoteComponent(opts(fake, { layouts: input }));

    const firstTagIndex = fake.calls.findIndex((c) => /^PUT .*manifests\/abcd1234-(amd64|arm64)$/.test(c));
    expect(firstTagIndex, 'a per-arch tag PUT must have occurred').toBeGreaterThan(-1);

    const before = fake.calls.slice(0, firstTagIndex);
    // Every referenced config/layer blob is fetched before the first
    // manifest write; the digest-addressed manifest/index read-backs must
    // also all finish before a human-facing tag can be written.
    const expectedBlobs = new Set(input.flatMap((l) => digestsOfLayoutBytes(l.tarBytes).map(([digest]) => digest)));
    const blobReads = fake.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.startsWith('GET ') && call.includes('/blobs/sha256:') && !call.includes('/blobs/uploads/'));
    expect(new Set(blobReads.map(({ call }) => call.split('/blobs/')[1])).size).toBe(expectedBlobs.size);
    expect(blobReads.every(({ index }) => index < firstTagIndex)).toBe(true);
    // Every staging write must precede the first tag.
    expect(before.filter((c) => c.includes('manifests/') && c.includes('PUT')).length).toBe(3); // 2 manifests + index, by digest
    // And each staging write must have been read back before tagging.
    expect(before.filter((c) => c.includes('manifests/') && c.startsWith('GET')).length).toBe(3);
  });

  it('puts the index TAG last, after both per-arch tags', async () => {
    const fake = new FakeRegistry();
    await promoteComponent(opts(fake));
    const tagWrites = fake.calls.filter((c) => c.startsWith('PUT') && /manifests\/abcd1234(-amd64|-arm64)?$/.test(c));
    expect(tagWrites).toEqual([
      'PUT /v2/cwdcwd/vector-sigma/registrar/manifests/abcd1234-amd64',
      'PUT /v2/cwdcwd/vector-sigma/registrar/manifests/abcd1234-arm64',
      'PUT /v2/cwdcwd/vector-sigma/registrar/manifests/abcd1234',
    ]);
  });

  it('writes no tag at all when a staged manifest fails read-back verification', async () => {
    const fake = new FakeRegistry();
    // Tamper the FIRST per-arch manifest's read-back, addressed by digest.
    const input = layouts();
    const amd64Digest = manifestDigestOf(input.find((l) => l.platform === 'linux/amd64')!.tarBytes);
    fake.tamper.set(`${REPOSITORY}@${amd64Digest}`, Buffer.from('{"schemaVersion":2,"tampered":true}'));

    await expect(promoteComponent(opts(fake))).rejects.toBeInstanceOf(PromotionError);
    expect(fake.calls.filter((c) => c.startsWith('PUT') && c.includes('manifests/abcd1234'))).toEqual([]);
  });

  it('writes no index tag when a per-arch TAG read-back resolves to a different digest', async () => {
    const fake = new FakeRegistry();
    const input = layouts();
    const arm64Digest = manifestDigestOf(input.find((l) => l.platform === 'linux/arm64')!.tarBytes);
    // The digest-addressed read-back passes; only the TAG read-back is wrong.
    fake.tamper.set(`${REPOSITORY}@abcd1234-arm64`, Buffer.from('{"schemaVersion":2,"retargeted":true}'));

    await expect(promoteComponent(opts(fake))).rejects.toMatchObject({ code: 'tag_mismatch' });
    expect(fake.calls.some((c) => c === 'PUT /v2/cwdcwd/vector-sigma/registrar/manifests/abcd1234')).toBe(false);
    expect(arm64Digest).toMatch(/^sha256:/);
  });

  it('fails with index_mismatch rather than tagging when the stored index differs from the local one', async () => {
    const fake = new FakeRegistry();
    const original = fake.send.bind(fake);
    let tampered = false;
    fake.send = async (req) => {
      // After the index lands, corrupt exactly one read-back of it.
      if (!tampered && req.method === 'PUT' && /manifests\/sha256:/.test(new URL(req.url).pathname) && req.body?.toString('utf8').includes('"manifests"')) {
        tampered = true;
        const res = await original(req);
        const m = new URL(req.url).pathname.match(/manifests\/(sha256:[0-9a-f]{64})$/);
        if (m) fake.tamper.set(`${REPOSITORY}@${m[1]}`, Buffer.from('{"schemaVersion":2,"manifests":[]}'));
        return res;
      }
      return original(req);
    };

    await expect(promoteComponent(opts(fake))).rejects.toMatchObject({ code: 'index_mismatch' });
    expect(fake.calls.some((c) => c === 'PUT /v2/cwdcwd/vector-sigma/registrar/manifests/abcd1234')).toBe(false);
  });
});

describe('promotion input validation: fail closed before any registry write', () => {
  it('rejects a duplicate platform without touching the registry', async () => {
    const fake = new FakeRegistry();
    const input = layouts();
    await expect(promoteComponent(opts(fake, { layouts: [...input, input[0]!] }))).rejects.toMatchObject({
      code: 'duplicate_platform',
    });
    expect(fake.calls).toEqual([]);
  });

  it('rejects a missing required platform without touching the registry', async () => {
    const fake = new FakeRegistry();
    await expect(promoteComponent(opts(fake, { layouts: layouts().slice(0, 1) }))).rejects.toMatchObject({
      code: 'missing_platform',
    });
    expect(fake.calls).toEqual([]);
  });

  it('rejects a layout whose manifest bytes do not match its descriptor digest, before any write', async () => {
    const fake = new FakeRegistry();
    const bad = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'app/x', content: 'x\n' }] }],
      mutateBlobs: (blobs) => {
        // Corrupt the manifest blob's BYTES in place at the SAME LENGTH
        // while leaving the index descriptor's digest untouched — so the
        // failure that fires is the digest comparison, not a size check.
        const manifestIdx = blobs.findIndex((b) => b.bytes.toString('utf8').includes('"layers"'));
        const original = blobs[manifestIdx].bytes;
        const text = original.toString('utf8');
        const flipped = text.replace('"schemaVersion":2', '"schemaVersion":9');
        blobs[manifestIdx] = { ...blobs[manifestIdx], bytes: Buffer.from(flipped, 'utf8') };
        return blobs;
      },
    });
    await expect(
      promoteComponent(opts(fake, { layouts: [{ platform: 'linux/amd64', tarBytes: bad }, layouts()[1]!] })),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(fake.calls).toEqual([]);
  });

  it('does not re-upload a blob that already exists in the registry', async () => {
    const fake = new FakeRegistry();
    const input = layouts();
    await promoteComponent(opts(fake));
    const writesAfterFirst = fake.calls.filter((c) => c.startsWith('POST') || c.startsWith('PUT') && c.includes('blobs')).length;
    const callsBefore = fake.calls.length;
    await promoteComponent(opts(fake));
    const writesAfterSecond = fake.calls
      .slice(callsBefore)
      .filter((c) => c.startsWith('POST') || (c.startsWith('PUT') && c.includes('blobs'))).length;
    expect(writesAfterFirst).toBeGreaterThan(0);
    expect(writesAfterSecond).toBe(0);
    expect(input.length).toBe(2);
  });

  it('rejects a pre-existing blob whose bytes do not match its content-addressed digest before tagging', async () => {
    const fake = new FakeRegistry();
    const digest = digestsOfLayoutBytes(layouts()[0]!.tarBytes)[0]![0];
    fake.blobs.set(digest, Buffer.from('wrong bytes at claimed digest'));

    await expect(promoteComponent(opts(fake))).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(fake.calls.some((c) => c.startsWith('PUT') && c.includes('/manifests/abcd1234'))).toBe(false);
  });

  it('rejects a blob corrupted after upload before tagging', async () => {
    const fake = new FakeRegistry();
    const originalSend = fake.send.bind(fake);
    let corrupted = false;
    fake.send = async (req) => {
      const res = await originalSend(req);
      if (!corrupted && req.method === 'PUT' && new URL(req.url).pathname.includes('/blobs/uploads/')) {
        corrupted = true;
        const digest = new URL(req.url).searchParams.get('digest')!;
        fake.blobs.set(digest, Buffer.from('corrupted after upload'));
      }
      return res;
    };

    await expect(promoteComponent(opts(fake))).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(corrupted).toBe(true);
    expect(fake.calls.some((c) => c.startsWith('PUT') && c.includes('/manifests/abcd1234'))).toBe(false);
  });

  // GHCR, run 39357011362 (tailscale-devices config blob): HEAD answered the
  // blob as present while GET in the same repository returned 404 — a blob
  // left dangling by an interrupted earlier push. HEAD is only a hint: the
  // promoter must upload the scanned bytes and read them back.
  // GHCR creates a package on its first MANIFEST push; blobs uploaded into a
  // package that does not exist yet are accepted but not readable until a
  // manifest references them (run 39360749804: tailscale-devices, the one
  // component never published before, failed every read-back). The promoter
  // must push the manifest by digest BEFORE reading blobs back.
  it('promotes into a brand-new package whose blobs are unreadable until a manifest exists', async () => {
    const fake = new FakeRegistry();
    const originalSend = fake.send.bind(fake);
    let packageExists = false;
    fake.send = async (req) => {
      const p = new URL(req.url).pathname;
      if (req.method === 'PUT' && /\/manifests\//.test(p)) packageExists = true;
      if (req.method === 'GET' && /\/blobs\/sha256:/.test(p) && !packageExists) {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      return originalSend(req);
    };
    const log: string[] = [];
    const result = await promoteComponent(opts(fake, { readBackDelaysMs: [0], log: (l) => log.push(l) }));
    expect(result.perPlatform).toHaveLength(2);
    expect(log, 'no recovery path needed: blobs are read only after the manifest push').toEqual([]);
    const firstManifestPut = fake.calls.findIndex((c) => c.startsWith('PUT') && c.includes('/manifests/'));
    const firstBlobGet = fake.calls.findIndex((c) => c.startsWith('GET') && /\/blobs\/sha256:/.test(c));
    expect(firstBlobGet).toBeGreaterThan(firstManifestPut);
  });

  it('re-uploads when HEAD says a blob exists but GET returns 404 (dangling blob)', async () => {
    const fake = new FakeRegistry();
    const dangling = digestsOfLayoutBytes(layouts()[0]!.tarBytes)[0]![0];
    const originalSend = fake.send.bind(fake);
    let linked = false;
    fake.send = async (req) => {
      const p = new URL(req.url).pathname;
      if (p.endsWith(`/blobs/${dangling}`) && !linked) {
        if (req.method === 'HEAD') return { status: 200, headers: {}, body: Buffer.alloc(0) };
        if (req.method === 'GET') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      if (req.method === 'PUT' && new URL(req.url).searchParams.get('digest') === dangling) linked = true;
      return originalSend(req);
    };
    const log: string[] = [];
    const result = await promoteComponent(opts(fake, { readBackDelaysMs: [0, 0], log: (l) => log.push(l) }));
    expect(linked, 'the dangling blob was re-uploaded').toBe(true);
    expect(result.index.digest).toMatch(/^sha256:/);
    expect(log.join('\n')).toContain('HEAD reported it present but GET returned 404');
  });

  it('retries a GET that 404s briefly right after upload, then succeeds', async () => {
    const fake = new FakeRegistry();
    const originalSend = fake.send.bind(fake);
    const misses = new Map<string, number>();
    fake.send = async (req) => {
      const p = new URL(req.url).pathname;
      const m = p.match(/\/blobs\/(sha256:[0-9a-f]{64})$/);
      if (req.method === 'GET' && m && fake.blobs.has(m[1]!) && (misses.get(m[1]!) ?? 0) < 2) {
        misses.set(m[1]!, (misses.get(m[1]!) ?? 0) + 1);
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      return originalSend(req);
    };
    const result = await promoteComponent(opts(fake, { readBackDelaysMs: [0, 0, 0] }));
    expect(result.perPlatform).toHaveLength(2);
    expect([...misses.values()].every((n) => n === 2)).toBe(true);
  });

  it('fails closed with blob_unreadable — and writes no tag — when a blob never becomes readable', async () => {
    const fake = new FakeRegistry();
    const originalSend = fake.send.bind(fake);
    fake.send = async (req) => {
      if (req.method === 'GET' && /\/blobs\/sha256:/.test(new URL(req.url).pathname)) {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      return originalSend(req);
    };
    await expect(promoteComponent(opts(fake, { readBackDelaysMs: [0, 0], log: () => {} }))).rejects.toMatchObject({
      code: 'blob_unreadable',
    });
    // A digest-addressed manifest may exist (it is pushed before read-back),
    // but no human-facing TAG is ever written for unverified bytes.
    expect(fake.calls.some((c) => c.startsWith('PUT') && /\/manifests\/abcd1234/.test(c))).toBe(false);
  });

});

// ── helpers: read a layout tar's blobs without importing gate internals ──
import { parseTar } from '../src/oci-gate/tar.js';

function blobsOf(tarBytes: Buffer): Array<{ digest: string; bytes: Buffer }> {
  const out: Array<{ digest: string; bytes: Buffer }> = [];
  for (const e of parseTar(tarBytes)) {
    const m = e.name.match(/^(?:\.\/)?blobs\/sha256\/([0-9a-f]{64})$/);
    if (!m) continue;
    out.push({ digest: `sha256:${m[1]}`, bytes: e.data });
  }
  return out;
}

/** Layer + config blobs only — excludes manifest/index blobs (checked separately). */
function digestsOfLayoutBytes(tarBytes: Buffer): Array<[string, Buffer]> {
  const manifestDigest = manifestDigestOf(tarBytes);
  return blobsOf(tarBytes)
    .filter((b) => b.digest !== manifestDigest)
    .map((b) => [b.digest, b.bytes]);
}

function manifestDigestOf(tarBytes: Buffer): string {
  for (const b of blobsOf(tarBytes)) {
    const text = b.bytes.toString('utf8');
    if (text.startsWith('{') && text.includes('"layers"') && text.includes('"config"') && text.includes('"schemaVersion"')) {
      return b.digest;
    }
  }
  throw new Error('no manifest blob found in fixture layout');
}

describe('promotion is deterministic: identical scanned bytes produce an identical index digest', () => {
  it('yields the same index digest across two independent promotions of the same layouts', async () => {
    const a = await promoteComponent(opts(new FakeRegistry()));
    const b = await promoteComponent(opts(new FakeRegistry()));
    expect(a.index.digest).toBe(b.index.digest);
    expect(a.index.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});
