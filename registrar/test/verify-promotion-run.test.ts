import { describe, expect, it } from 'vitest';
import { validatePromotionRun } from '../../scripts/verify-promotion-run.mjs';

const goodRun = {
  id: 12345,
  run_attempt: 2,
  repository: { full_name: 'cwdcwd/vector-sigma' },
  path: '.github/workflows/build-images.yml',
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};
const expected = { repository: 'cwdcwd/vector-sigma', runId: '12345', attempt: '2' };

describe('promotion source workflow run is verified before artifact download', () => {
  it('accepts the exact successful main build-images workflow attempt', () => {
    expect(validatePromotionRun(goodRun, expected)).toBe(true);
  });

  it('rejects missing, mismatched, non-main, non-build, and unsuccessful runs', () => {
    expect(() => validatePromotionRun(null, expected)).toThrow(/object/);
    expect(() => validatePromotionRun(goodRun, { ...expected, runId: '999' })).toThrow(/ID or attempt/);
    expect(() => validatePromotionRun({ ...goodRun, repository: { full_name: 'another/repo' } }, expected)).toThrow(/repository/);
    expect(() => validatePromotionRun({ ...goodRun, path: '.github/workflows/release-devices.yml' }, expected)).toThrow(/build-images/);
    expect(() => validatePromotionRun({ ...goodRun, head_branch: 'topic' }, expected)).toThrow(/main-branch/);
    expect(() => validatePromotionRun({ ...goodRun, conclusion: 'failure' }, expected)).toThrow(/successfully/);
  });
});
