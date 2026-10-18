/**
 * Release-evidence ledger tests (fleet-ops-r3v).
 *
 * The ledger is the rollback runbook's source of truth for "what exact
 * bytes were promoted in a release run". These tests pin the fail-closed
 * record validation, the deterministic collation, and the shape the
 * promoter script emits.
 */
import { buildReleaseEvidence, parsePromotionRecord, releaseEvidenceDigest, ReleaseEvidenceError } from '../src/registry/release-evidence.js';
import { describe, expect, it } from 'vitest';

const COMMIT = 'a'.repeat(40);

function promotionRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    repository: 'cwdcwd/vector-sigma/registrar',
    registry: 'ghcr.io',
    index: { tag: COMMIT, digest: `sha256:${'b'.repeat(64)}` },
    perPlatform: [
      { platform: 'linux/amd64', tag: `${COMMIT}-amd64`, digest: `sha256:${'c'.repeat(64)}` },
      { platform: 'linux/arm64', tag: `${COMMIT}-arm64`, digest: `sha256:${'d'.repeat(64)}` },
    ],
    ...overrides,
  };
}

const VALID_INPUT = { commit: COMMIT, refName: 'v9.9.9', runId: '12345' };

describe('parsePromotionRecord', () => {
  it('reduces a well-formed record to its evidence fields', () => {
    const e = parsePromotionRecord('registrar', promotionRecord());
    expect(e.repository).toBe('cwdcwd/vector-sigma/registrar');
    expect(e.indexDigest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(e.perPlatform.map((p) => p.platform).sort()).toEqual(['linux/amd64', 'linux/arm64']);
    expect(e.indexTag).toBe(COMMIT);
  });

  it('rejects a record whose repository does not end in the component id', () => {
    expect(() => parsePromotionRecord('scotty', promotionRecord())).toThrowError(ReleaseEvidenceError);
    expect(() => parsePromotionRecord('scotty', promotionRecord())).toThrowError(/does not end in the component/);
  });

  it('rejects a non-ghcr registry', () => {
    expect(() => parsePromotionRecord('registrar', promotionRecord({ registry: 'docker.io' }))).toThrowError(ReleaseEvidenceError);
  });

  it('rejects a non-sha256 or malformed digest', () => {
    expect(() => parsePromotionRecord('registrar', promotionRecord({ index: { tag: 'x', digest: 'sha256:zz' } }))).toThrowError(/index\.digest/);
    expect(() =>
      parsePromotionRecord('registrar', promotionRecord({ perPlatform: [{ platform: 'linux/amd64', digest: 'not-a-digest' }, { platform: 'linux/arm64', digest: `sha256:${'d'.repeat(64)}` }] })),
    ).toThrowError(/child digest/);
  });

  it('rejects a record missing either platform child', () => {
    expect(() => parsePromotionRecord('registrar', promotionRecord({ perPlatform: [{ platform: 'linux/arm64', digest: `sha256:${'d'.repeat(64)}` }] }))).toThrowError(ReleaseEvidenceError);
  });

  it('rejects non-object input and junk component ids', () => {
    expect(() => parsePromotionRecord('registrar', 'not-an-object')).toThrowError(ReleaseEvidenceError);
    expect(() => parsePromotionRecord('bad component!', promotionRecord())).toThrowError(/component id/);
  });
});

describe('buildReleaseEvidence', () => {
  it('collates records with sorted component keys and a stable schema', () => {
    const scotty = parsePromotionRecord('scotty', promotionRecord({ repository: 'cwdcwd/vector-sigma/scotty' }));
    const evidence = buildReleaseEvidence(VALID_INPUT, new Map([
      ['scotty', scotty],
      ['registrar', parsePromotionRecord('registrar', promotionRecord())],
    ]));
    expect(Object.keys(evidence.components)).toEqual(['registrar', 'scotty']);
    expect(evidence.schema).toBe('vs.release-evidence/1');
    expect(evidence.commit).toBe(COMMIT);
    expect(evidence.rollback.authoritativeTag).toBe(COMMIT);
  });

  it('is deterministic: same inputs, byte-identical JSON output', () => {
    const records = new Map([['registrar', parsePromotionRecord('registrar', promotionRecord())]]);
    const a = JSON.stringify(buildReleaseEvidence(VALID_INPUT, records));
    const b = JSON.stringify(buildReleaseEvidence({ commit: COMMIT, refName: 'v9.9.9', runId: '12345' }, records));
    expect(a).toEqual(b);
  });

  it('omits actor/generatedAt unless supplied, and includes them when supplied', () => {
    const records = new Map([['registrar', parsePromotionRecord('registrar', promotionRecord())]]);
    expect('actor' in buildReleaseEvidence(VALID_INPUT, records)).toBe(false);
    const withActor = buildReleaseEvidence({ ...VALID_INPUT, actor: 'the-cabal-doom-bot', generatedAt: '2026-10-18T00:00:00Z' }, records);
    expect(withActor.actor).toBe('the-cabal-doom-bot');
    expect(withActor.generatedAt).toBe('2026-10-18T00:00:00Z');
  });

  it('refuses an empty component set and a malformed commit', () => {
    expect(() => buildReleaseEvidence(VALID_INPUT, new Map())).toThrowError(/zero promotion records/);
    expect(() => buildReleaseEvidence({ ...VALID_INPUT, commit: 'short' }, new Map([['registrar', parsePromotionRecord('registrar', promotionRecord())]]))).toThrowError(/40-char/);
  });

  it('exposes a deterministic content digest over the sorted collation', () => {
    const records = new Map([['registrar', parsePromotionRecord('registrar', promotionRecord())]]);
    const evidence = buildReleaseEvidence(VALID_INPUT, records);
    const d1 = releaseEvidenceDigest(evidence);
    const rebuilt = JSON.parse(JSON.stringify(evidence)); // round-trip
    expect(releaseEvidenceDigest(rebuilt)).toBe(d1);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});