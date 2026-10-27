# Epic plan 0007: AgentCore platform adapter for Vector Sigma (AWS, CDK)

- **Status:** Owner-approved for plan commit and Beads intake — 2026-10-26.
- **Owner decision:** Scope confirmed in Slack on 2026-10-26; the plan and board items do not authorize AWS deployment or migration execution.
- **Owner scope answers (decided, do not re-litigate):**
  1. Deliverable = platform adapter + deployment design only. Deployment execution deferred.
  2. AWS is parallel support; no Balena changes.
  3. CDK in TypeScript.
  4. First deploy/test environment = isolated AWS dev stack, never production, never fleet traffic.
  5. Least-privilege IAM + Secrets Manager for identity; the epic includes a written state/identity migration plan.
- **Reference inspected:** [aws-samples/sample-host-hermesagent-on-amazon-bedrock-agentcore](https://github.com/aws-samples/sample-host-hermesagent-on-amazon-bedrock-agentcore) — useful shapes (phased deploy, Secrets Manager pattern, agentcore invocation contract, cost/budget config), but its Python CDK + Hermes monkey-patch approach is NOT ours: Vector Sigma images are platform-neutral already, so the agent image stays one artifact with an env-switched entrypoint shim.

## Goal

Add `platforms/agentcore/` — a CDK-defined (TypeScript) AgentCore adapter that
runs the platform-neutral agent (and, in the design, primus) images on AWS
Bedrock AgentCore Runtime — while the registrar stack stays on the existing
compose/balena adapters. The epic ends at reviewed, buildable, CI-tested code
and docs. Nothing is deployed to AWS in this epic.

## Architecture (first cut per platforms/README.md "Adding AWS AgentCore (next)")

- **ECR mirror:** the current workflow validates a successful promotion record,
  selects the promoted arm64 digest, and produces an explicit ECR mirror plan
  only. It does not authenticate to AWS/ECR or copy images. Any real copy and
  target provisioning remain separately authorized.
- **Entrypoint shim:** the agent image includes an env-switched AgentCore
  **HTTP** invocation listener (`POST /invocations`, `GET /ping`, port 8080;
  JSON responses). It is not an A2A or MCP runtime shim. The classic
  Compose/Balena entrypoint remains the default path.
- **Identity:** the existing registrant remains on Compose/Balena and keeps
  its current registrar-configured device-bootstrap flow. No bootstrap key,
  bundle credential, or fleet identity moves to AWS. AgentCore Identity may
  reference a separately provisioned Secrets Manager credential for an
  AgentCore runtime's outbound calls; neither the registrant nor the runtime
  receives direct Secrets Manager access by default. This follows
  [`platforms/agentcore/README.md`](../../platforms/agentcore/README.md) and
  [`platforms/agentcore/MIGRATION-PLAN.md`](../../platforms/agentcore/MIGRATION-PLAN.md).
  Any change to the registrant, bootstrap flow, bundle contract, or Balena
  behavior is outside this scope and requires a separately owner-approved
  scope change.
- **Deploy definition:** a TypeScript CDK stack and tag-validation workflow
  exist. The stack is synth-only, uses placeholder/default references, and
  has structural tests; workflows do not deploy or publish to ECR.
- **What stays off AWS:** registrar, registrant, PostgreSQL, gateway, queue,
  Scotty, and existing device applications. The registrar stack remains on
  Compose/Balena. AgentCore hosts agent + Primus only.

## Stages (children, in dependency order)

1. **Design doc — completed at the current main base:** `platforms/agentcore/README.md` records current AgentCore requirements, IAM boundaries, and open account-dependent questions. It places the registrant on the existing Compose/Balena control plane, keeps its current registrar-configured device bootstrap flow, and gives neither the registrant nor the runtime direct Secrets Manager access. Secrets Manager-backed credentials are an optional AgentCore Identity mechanism for separately provisioned runtime outbound credentials; they do not replace the device bootstrap key. Any request to change the registrant, device bootstrap flow, bundle contract, or Balena behavior is a separately owner-approved scope change. No infrastructure is deployed.
2. **Migration plan doc — completed at the current main base:** `platforms/agentcore/MIGRATION-PLAN.md` inventories state and identity boundaries and defaults to no migration. Device bootstrap identity stays device-only; any future runtime identity is a separate design and owner-gated. It is documentation only and authorizes no execution.
3. **Entrypoint shim — implemented at the current main base:** the agent image has an env-switched HTTP listener (`POST /invocations`, `GET /ping`, port 8080, JSON responses); the existing Compose/Balena entrypoint remains the default. It is not an A2A or MCP listener. Repo tests exercise the shim and classic path.
4. **ECR mirror — dry-run planning only:** the workflow validates a successful promotion record and produces a digest-pinned mirror plan; it performs no AWS/ECR login, copy, or write. Real ECR provisioning/copy remains separately authorized.
5. **TypeScript CDK app — synth-only:** the app defines the AgentCore runtime with least-privilege image-pull permissions and structural assertions. The secret ARN is a placeholder/reference parameter only; it is not wired to the registrant or runtime as direct Secrets Manager access. CI typechecks, tests, and synthesizes without AWS credentials; no deploy job exists.
6. **Release validation workflow — implemented at the current main base:** tag-triggered tests and synth only. It does not publish to ECR or deploy. Any real deployment remains a separate, owner-authorized action.

## Standing limits (bind every child)

- No AWS account access, no `cdk deploy`/diff against a real account, no
  credential creation or rotation, no AWS CLI configuration on any host —
  these need separate owner authorization.
- **No Balena or device identity changes in this epic:** no device application,
  registrant, device-bootstrap flow, bundle contract, Balena fleet, or existing
  release workflow changes. Any such change requires a separate,
  owner-approved scope decision before implementation.
- No production or fleet-facing traffic in this epic, ever.

## Owner gates (after the epic)

1. AWS account + billing for the isolated dev stack (needed first if
   deployment is later authorized; stage 4's real run and any deploy waits on
   it).
2. A written "deploy the dev stack" go — separate from this epic's close.
3. Migration execution — separate authorization; the plan doc inside this
   epic authorizes nothing.

## Risks / honesty

- AgentCore's exact port/protocol/arch requirements are summarized secondhand
  here; stage 1 must verify against current AWS docs before design merge.
- Nothing infra-touching is verifiable without an AWS account — workflow and
  CDK children must state plainly what was synth-tested vs never exercised.
- Cost: even a dev-stack AgentCore runtime + Bedrock use is nonzero; budget
  caps (mirror the reference repo's daily cap pattern) belong in the stage 5
  config when deployment is separately authorized.
- Current `main` contains design documents and synth-only validation
  infrastructure, not a deployed AgentCore service. The migration plan and
  adapter design explicitly keep the registrant on Compose/Balena and do not
  replace or export its device-bootstrap identity to AWS. This PR aligns the
  original epic plan with that settled design; it authorizes no implementation,
  credential changes, AWS account access, or deployment.