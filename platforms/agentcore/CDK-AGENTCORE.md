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
  scoped to the promoted repository plus `GetAuthorizationToken`. The role
  assumes `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount` /
  `aws:SourceArn` conditions. It has **no** Secrets Manager permission:
  AgentCore Identity owns provider-secret retrieval.
- **ARN reference only.** `IdentitySecretArn` is a CloudFormation parameter
  (ARN pattern validated) surfaced through an output. The parameter is
  intentionally not `NoEcho` (it holds an ARN, not secret material) — the
  `CloudFormation-Validate::W2509` warning is acknowledged in code with this
  rationale.
- **Non-deployable placeholders.** The default image digest and secret ARN
  use example account/region values; account-specific values require
  separate owner authorization.

Dependencies are pinned to `aws-cdk-lib` 2.275.0 / `constructs` 10.8.1 /
`aws-cdk` CLI 2.1146.1 (the minimum CLI that reads the lib's cloud-assembly
schema v55).