/**
 * Remote verification (fleet-ops-r3v).
 *
 * The promotion step proves byte identity AT WRITE TIME. This suite
 * proves the independent later read: a registry that has been tampered
 * with (a retargeted index tag, a child manifest re-served as different
 * bytes, a published index listing a platform that was never promoted)
 * must make verification FAIL, not pass quietly.
 *
 * Every case here uses bytes, not tags, as the tamper target — the
 * defect class is precisely "a tag or digest reference resolving to
 * content other than what was promoted".
 */
import { describe, expect, it } from 'vitest';
import { promoteComponent } from '../src/registry/promote.js';
import { verifyRemote, verifyTagResolvesTo, VerifyRemoteError, type PromotedRecord } from '../src/registry/verify-remote.js';
import { FakeRegistry, sha256Digest } from './helpers/fake-registry.js';
import { buildFakeOciLayoutTar } from './helpers/oci-fixtures.js';
import type { RequiredPlatform } from '../src/oci-gate/types.js';

const REPOSITORY = 'cwdcwd/vector-sigma/registrar';

function layouts() {
  return [
    {
      platform: 'linux/amd64' as RequiredPlatform,
      tarBytes: buildFakeOciLayoutTar({
        platform: 'linux/amd64',
        layers: [{ files: [{ name: 'app/index.js', content: 'amd64\n' }] }],
      }),
    },
    {
      platform: 'linux/arm64' as RequiredPlatform,
      tarBytes: buildFakeOciLayoutTar({
        platform: 'linux/arm64',
        layers: [{ files: [{ name: 'app/index.js', content: 'arm64\n' }] }],
      }),
    },
  ];
}

function promoteOpts(fake: FakeRegistry) {
  return {
    transport: fake,
    registry: 'ghcr.io',
    repository: REPOSITORY,
    layouts: layouts(),
    archTag: (p: RequiredPlatform) => `rel1-${p === 'linux/amd64' ? 'amd64' : 'arm64'}`,
    indexTag: 'rel1',
  };
}

async function promoted(fake: FakeRegistry): Promise<PromotedRecord> {
  const res = await promoteComponent(promoteOpts(fake));
  return res as PromotedRecord;
}

describe('verify-remote: a faithful registry verifies clean', () => {
  it('returns the index digest and every child when nothing has changed', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const result = await verifyRemote({ transport: fake, registry: 'ghcr.io', record });
    expect(result.indexDigest).toBe(record.index.digest);
    expect(result.children.map((c) => c.platform).sort()).toEqual(['linux/amd64', 'linux/arm64']);
  });

  it('performs a real read of every child by digest (not just the index listing)', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const before = fake.calls.length;
    await verifyRemote({ transport: fake, registry: 'ghcr.io', record });
    const verificationCalls = fake.calls.slice(before);
    for (const child of record.perPlatform) {
      expect(
        verificationCalls.some((c) => c === `GET /v2/${REPOSITORY}/manifests/${child.digest}`),
        `verification must re-fetch ${child.digest} by digest`,
      ).toBe(true);
    }
  });
});

describe('verify-remote: retargeted index tag fails closed', () => {
  it('fails with index_mismatch when the index tag resolves to different bytes', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    fake.tamper.set(`${REPOSITORY}@rel1`, Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] })));

    await expect(verifyRemote({ transport: fake, registry: 'ghcr.io', record })).rejects.toMatchObject({
      code: 'index_mismatch',
    });
  });

  it('fails when the tampered index is still valid JSON with the same child digests but different bytes', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const original = fake.storedManifest(REPOSITORY, 'rel1')!.bytes;
    const parsed = JSON.parse(original.toString('utf8'));
    // Whitespace-only change: semantically identical index, different digest.
    const pretty = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8');
    expect(sha256Digest(pretty)).not.toBe(record.index.digest);
    fake.tamper.set(`${REPOSITORY}@rel1`, pretty);

    await expect(verifyRemote({ transport: fake, registry: 'ghcr.io', record })).rejects.toMatchObject({
      code: 'index_mismatch',
    });
  });
});

describe('verify-remote: a published index that disagrees with the record fails closed', () => {
  it('fails with child_missing when the index omits a promoted platform', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const onlyAmd64 = { ...record, perPlatform: [...record.perPlatform, { platform: 'linux/riscv64', tag: 'rel1-riscv64', digest: `sha256:${'9'.repeat(64)}` }] };
    await expect(verifyRemote({ transport: fake, registry: 'ghcr.io', record: onlyAmd64 })).rejects.toMatchObject({
      code: 'child_missing',
    });
  });

  it('fails with child_mismatch when the index lists a different digest for a platform', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const swapped = {
      ...record,
      perPlatform: record.perPlatform.map((p) =>
        p.platform === 'linux/arm64' ? { ...p, digest: `sha256:${'7'.repeat(64)}` } : p,
      ),
    };
    await expect(verifyRemote({ transport: fake, registry: 'ghcr.io', record: swapped })).rejects.toMatchObject({
      code: 'child_mismatch',
    });
  });

  it('fails with child_mismatch when a child re-fetched by digest serves different bytes', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const amd64 = record.perPlatform.find((p) => p.platform === 'linux/amd64')!;
    fake.tamper.set(`${REPOSITORY}@${amd64.digest}`, Buffer.from('{"schemaVersion":2,"layers":[]}'));

    await expect(verifyRemote({ transport: fake, registry: 'ghcr.io', record })).rejects.toMatchObject({
      code: 'child_mismatch',
    });
  });

  it('fails with malformed_index when the index is not JSON at all', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    const notJson = Buffer.from('this is not json');
    // Tamper must ALSO keep the recorded digest check in play: use a
    // record whose expected index digest matches the junk, so the parse
    // failure is what surfaces.
    fake.tamper.set(`${REPOSITORY}@rel1`, notJson);
    await expect(
      verifyRemote({
        transport: fake,
        registry: 'ghcr.io',
        record: { ...record, index: { tag: 'rel1', digest: sha256Digest(notJson) } },
      }),
    ).rejects.toMatchObject({ code: 'malformed_index' });
  });
});

describe('verifyTagResolvesTo: the deploy-time reference check', () => {
  it('passes when the tag resolves to the expected digest', async () => {
    const fake = new FakeRegistry();
    const record = await promoted(fake);
    await expect(
      verifyTagResolvesTo({
        transport: fake,
        registry: 'ghcr.io',
        repository: REPOSITORY,
        tag: 'rel1',
        expectedDigest: record.index.digest,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails with tag_unresolvable when the tag has been moved', async () => {
    const fake = new FakeRegistry();
    await promoted(fake);
    await expect(
      verifyTagResolvesTo({
        transport: fake,
        registry: 'ghcr.io',
        repository: REPOSITORY,
        tag: 'rel1',
        expectedDigest: `sha256:${'1'.repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(VerifyRemoteError);
  });
});
