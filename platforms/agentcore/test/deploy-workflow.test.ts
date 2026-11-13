import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The manual AWS deploy workflow lives at the repo root, two levels above this package.
const workflow = readFileSync(new URL('../../../.github/workflows/deploy-agentcore-aws.yml', import.meta.url), 'utf8');

test('deploy workflow is workflow_dispatch-only (no push, PR, tag or schedule trigger)', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|pull_request_target|schedule|workflow_run|release|create|tags):/m);
});

test('deploy workflow uses OIDC chaining with no static AWS keys', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /role-to-assume: \$\{\{ vars\.AWS_FRONTDOOR_ROLE_ARN \}\}/);
  assert.match(workflow, /role-chaining: true/);
  assert.match(workflow, /role-to-assume: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}/);
  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\.AWS_/);
});

test('deploy workflow is least-privilege by default and targets the pinned account and region', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /TARGET_ACCOUNT_ID: '126384392823'/);
  assert.match(workflow, /AWS_REGION: us-east-1/);
});

test('account validation runs before the CDK deploy step', () => {
  const validate = workflow.indexOf('Validate the target account before deploying');
  const deploy = workflow.indexOf('Deploy the AgentCore stack');
  assert.ok(validate > 0 && deploy > validate, 'account validation must precede cdk deploy');
});
