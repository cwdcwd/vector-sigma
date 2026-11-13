# AgentCore CDK app (platforms/agentcore)

Synth-only CDK project for the Vector Sigma Bedrock AgentCore runtime.
Bead `fleet-ops-1py.55.5`. Complements the design docs in this directory
(`README.md`, `MIGRATION-PLAN.md`) — no AWS credentials, deployment, or
live account access are used by this project.

## Layout

- `bin/agentcore.ts` — CDK app entrypoint (`npx tsx bin/agentcore.ts`).
- `lib/agentcore-stack.ts` — `AgentCoreStack`: L1 `AWS::BedrockAgentCore::Runtime` (HTTP protocol, `PUBLIC` network mode, digest-pinned `ContainerConfiguration`), least-privilege execution role, and an AgentCore Identity secret **ARN reference** (`IdentitySecretArn` parameter + output).
- `test/agentcore-stack.test.ts` — `node:test` + `aws-cdk-lib/assertions` coverage.
- `cdk.json` — CLI/app config; context pins the aws-cdk-lib recommended feature flags of the installed version (CDKv1-removed flags are excluded explicitly).

## Commands

```sh
npm ci            # install (platform-scoped; root manifests untouched)
npm run build     # tsc --noEmit
npm run synth     # cdk synth (template only; never deploys)
npm test          # node:test via tsx
```

## Design constraints

- **Digest-pinned artifacts.** The stack rejects `imageUri` values that are
  not `...@sha256:<64 hex>`; mutable tags can never be configured.
- **Least-privilege runtime role.** ECR `BatchGetImage`/`GetDownloadUrlForLayer`
  scoped to the promoted `vector-sigma/agent` ECR repository (the
  GHCR→ECR mirror lane's agent target, `scripts/ecr-mirror-plan.mjs`
  `ECR_REPOSITORIES.agent`) plus `GetAuthorizationToken`. The role
  assumes `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount` /
  `aws:SourceArn` conditions. It has **no** Secrets Manager permission:
  AgentCore Identity owns provider-secret retrieval.
- **ARN reference only.** `IdentitySecretArn` is a CloudFormation parameter
  (ARN pattern validated) surfaced through an output. The parameter is
  intentionally not `NoEcho` (it holds an ARN, not secret material) — the
  `CloudFormation-Validate::W2509` warning is acknowledged through
  `cdk.Validations` on the stack (W2509 is a WASM-linter plugin violation
  attributed at the stack construct; `Annotations`-level acknowledges do
  not suppress plugin findings), so `cdk synth` runs without CDK
  validation warnings.
- **Non-deployable placeholders.** The default image digest and secret ARN
  use example account/region values; account-specific values require
  separate owner authorization.

## Manual AWS deploy (fleet-ops-210.5)

`.github/workflows/deploy-agentcore-aws.yml` is the only path that deploys this
stack. It is `workflow_dispatch`-only: no push, PR, tag, or schedule trigger.
It runs the same locked build, structural tests, and synth as CI, then deploys
`VectorSigmaAgentCore` to account `126384392823` in `us-east-1`.

**Environment setup (owner, in GitHub; the agent does not create these):**

1. Create environment `agentcore-dev` with required reviewers and a deployment
   branch rule limiting it to `main`.
2. Add environment **variables** (not repository variables, not secrets):
   - `AWS_FRONTDOOR_ROLE_ARN`: tools-account role that trusts GitHub OIDC only
     for this environment.
   - `AWS_DEPLOY_ROLE_ARN`: target-account role that trusts only the front-door
     role.
3. Confirm the CDK bootstrap for account `126384392823` / `us-east-1` exists.
   The workflow does not create it.

Auth is keyless: OIDC into the front-door role, then `role-chaining` into the
deploy role. The workflow validates that the resolved account equals
`126384392823` before `cdk deploy`.

**Manual invocation:** Actions → "Deploy AgentCore to AWS (manual, OIDC)" →
Run workflow, on `main`, with:

- `image_uri`: digest-pinned ECR URI (`<acct>.dkr.ecr.us-east-1.amazonaws.com/vector-sigma/agent@sha256:<64 hex>`).
- `identity_secret_arn`: existing Secrets Manager ARN (reference only, never a value).

Approve the environment gate when prompted. The post-deploy step fails unless
the stack is `CREATE_COMPLETE` or `UPDATE_COMPLETE`. Rollback is a redispatch
with the last-known-good digest.

This workflow supersedes the synth-only CI boundary for this lane only;
`agentcore-cdk.yml` and `release-agentcore.yml` remain synth-only.

Dependencies are pinned to `aws-cdk-lib` 2.275.0 / `constructs` 10.8.1 /
`aws-cdk` CLI 2.1146.1 (the minimum CLI that reads the lib's cloud-assembly
schema v55).