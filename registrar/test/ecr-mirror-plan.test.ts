import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMirrorPlan, createMirrorPlanFromRecord, ECR_REPOSITORIES } from '../../scripts/ecr-mirror-plan.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/promoted-agent-mirror.json', import.meta.url), 'utf8'));
const digest = `sha256:${'a'.repeat(64)}`;

describe('ECR mirror planning is digest-pinned and dry-run only', () => {
  it('maps each supported component to one explicit ECR repository and preserves the source digest', () => {
    for (const [component, targetRepository] of Object.entries(ECR_REPOSITORIES)) {
      expect(createMirrorPlan(component, digest)).toEqual({
        architecture: 'linux/arm64',
        source: `ghcr.io/cwdcwd/vector-sigma/${component}@${digest}`,
        targetRepository,
        targetDigest: digest,
        mode: 'dry-run',
      });
    }
  });

  it('rejects a missing or malformed promoted digest', () => {
    for (const invalid of [undefined, '', 'latest', 'sha256:ABC', `sha256:${'a'.repeat(63)}`]) {
      expect(() => createMirrorPlan('agent', invalid)).toThrow(/digest/);
    }
  });

  it('rejects unknown and ambiguous component inputs', () => {
    for (const invalid of ['', 'all', 'agent,registrar', '../agent']) {
      expect(() => createMirrorPlan(invalid, digest)).toThrow(/component/);
    }
  });

  it('selects the immutable arm64 child digest from exactly one matching promotion record entry', () => {
    const plan = createMirrorPlanFromRecord('agent', fixture);
    expect(plan.source).toBe(`ghcr.io/cwdcwd/vector-sigma/agent@${digest}`);
    expect(plan.targetDigest).toBe(digest);
    expect(plan.architecture).toBe('linux/arm64');
  });

  it('fails closed on missing, mismatched, or ambiguous arm64 promotion records', () => {
    expect(() => createMirrorPlanFromRecord('agent', null)).toThrow(/JSON object/);
    expect(() => createMirrorPlanFromRecord('agent', {
      registry: 'docker.io', repository: 'cwdcwd/vector-sigma/agent', perPlatform: [],
    })).toThrow(/registry or repository/);
    expect(() => createMirrorPlanFromRecord('agent', {
      registry: 'ghcr.io', repository: 'cwdcwd/vector-sigma/agent', perPlatform: [],
    })).toThrow(/exactly one linux\/arm64/);
    expect(() => createMirrorPlanFromRecord('agent', {
      registry: 'ghcr.io', repository: 'cwdcwd/vector-sigma/agent',
      perPlatform: [{ platform: 'linux/arm64', digest }, { platform: 'linux/arm64', digest }],
    })).toThrow(/exactly one linux\/arm64/);
  });
});
