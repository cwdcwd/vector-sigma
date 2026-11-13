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

test('deploy workflow is least-privilege by default', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
});

test('account ID and region come from protected Environment variables, never hardcoded', () => {
  assert.match(workflow, /AWS_ACCOUNT_ID: \$\{\{ vars\.AWS_ACCOUNT_ID \}\}/);
  assert.match(workflow, /AWS_REGION: \$\{\{ vars\.AWS_REGION \}\}/);
  // No 12-digit account ID or concrete AWS region literal anywhere in the workflow.
  assert.doesNotMatch(workflow, /\b\d{12}\b/);
  assert.doesNotMatch(workflow, /\bus-east-1\b|\beu-[a-z]+-\d\b|\bap-[a-z]+-\d\b/);
  assert.doesNotMatch(workflow, /TARGET_ACCOUNT_ID/);
});

test('deploy workflow fails closed when AWS_ACCOUNT_ID or AWS_REGION is unset', () => {
  const failClosed = workflow.indexOf('Fail closed unless the environment target is configured');
  const checkout = workflow.indexOf('Check out');
  assert.ok(failClosed > 0 && checkout > failClosed, 'fail-closed guard must run before checkout and any AWS credential step');
  assert.match(workflow, /if \[\[ -z "\$AWS_ACCOUNT_ID" \]\]; then/);
  assert.match(workflow, /if \[\[ -z "\$AWS_REGION" \]\]; then/);
});

test('account validation compares caller identity to AWS_ACCOUNT_ID before the CDK deploy step', () => {
  const validate = workflow.indexOf('Validate the target account before deploying');
  const deploy = workflow.indexOf('Deploy the AgentCore stack');
  assert.ok(validate > 0 && deploy > validate, 'account validation must precede cdk deploy');
  const block = workflow.slice(validate, deploy);
  assert.match(block, /aws sts get-caller-identity --query Account --output text/);
  assert.match(block, /if \[\[ "\$account" != "\$AWS_ACCOUNT_ID" \]\]; then/);
  assert.match(block, /exit 1/);
});
