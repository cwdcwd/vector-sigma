import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = '.github/workflows/mirror-ghcr-to-ecr.yml';
const workflowText = readFileSync(path.join(repoRoot, workflowPath), 'utf8');
const workflow = parseYaml(workflowText);

describe('GHCR-to-ECR mirror workflow is a CI-safe dry-run', () => {
  it('only dispatches manually and accepts exactly one explicit component', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.component.type).toBe('choice');
    expect(workflow.on.workflow_dispatch.inputs.component.options).toEqual([
      'agent', 'hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale', 'tailscale-devices',
    ]);
  });

  it('checks the source workflow run and downloads the artifact from that run and attempt', () => {
    const steps = workflow.jobs.plan.steps;
    const verification = steps.find((step) => step.run === 'node scripts/verify-promotion-run.mjs');
    expect(verification.env.PROMOTION_RUN_ID).toBe('${{ inputs.promotion_run_id }}');
    expect(verification.env.PROMOTION_RUN_ATTEMPT).toBe('${{ inputs.promotion_run_attempt }}');
    const download = steps.find((step) => step.uses === 'actions/download-artifact@v4');
    expect(download.with.name).toBe('promoted-${{ inputs.component }}');
    expect(download.with['run-id']).toBe('${{ inputs.promotion_run_id }}');
    expect(download.with['run-attempt']).toBe('${{ inputs.promotion_run_attempt }}');
    const planner = steps.find((step) => String(step.name ?? '').includes('Plan digest-pinned mirror'));
    expect(planner.run).toContain('scripts/ecr-mirror-plan.mjs');
    const plan = JSON.parse(execFileSync('node', [
      'scripts/ecr-mirror-plan.mjs',
      'registrar/test/fixtures/promoted-agent-mirror.json',
      'agent',
    ], { cwd: repoRoot, encoding: 'utf8' }));
    expect(plan.source).toBe(`ghcr.io/cwdcwd/vector-sigma/agent@sha256:${'a'.repeat(64)}`);
    expect(plan.targetRepository).toBe('vector-sigma/agent');
    expect(plan.mode).toBe('dry-run');
  });

  it('has no AWS identity, ECR login/write, or publishing permissions', () => {
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(workflow.jobs.plan.permissions).toEqual({ actions: 'read', contents: 'read' });
    for (const forbidden of ['id-token: write', 'aws-actions/configure-aws-credentials', 'aws-actions/amazon-ecr-login', 'ecr:PutImage', 'docker login ghcr.io', 'docker login 123456789012.dkr.ecr.us-east-1.amazonaws.com']) {
      expect(workflowText).not.toContain(forbidden);
    }
    const planner = workflow.jobs.plan.steps.find((step) => step.env?.COMPONENT);
    expect(planner.env.AWS_ACCESS_KEY_ID).toBe('');
    expect(planner.env.AWS_SECRET_ACCESS_KEY).toBe('');
    expect(planner.env.AWS_SESSION_TOKEN).toBe('');
  });
});
