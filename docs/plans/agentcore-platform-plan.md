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

- **ECR mirror:** copy the promoted GHCR digests into ECR *by digest* so the
  scanned bytes are the bytes AgentCore runs. arm64 images only (catalog
  already builds them).
- **Entrypoint shim:** AgentCore's HTTP/A2A invocation contract, added to
  `images/agent/` behind an env switch — one artifact for every platform.
- **Identity delivery:** AWS Secrets Manager read by the registrant replaces
  the balena device bootstrap key. IAM roles scoped to exactly what each
  service reads.
- **Deploy definition:** CDK stack(s) under `platforms/agentcore/` + a release
  workflow beside the balena ones.
- **What stays off AWS:** registrar, postgres, gateway, queue, scotty — the
  registrar stack remains compose/balena. AgentCore hosts agent + primus only.

## Stages (children, in dependency order)

1. **Design doc** — `platforms/agentcore/README.md`: verified AgentCore
   requirements (port, protocol, arch) read from current AWS docs at build
   time; IAM least-privilege table per service; identity-delivery design
   (Secrets Manager layout); open questions listed. No infra.
2. **Migration plan doc** — state/identity migration: what moves from balena
   bootstrap keys to AWS identity delivery, what leaves today's deployment
   (nothing by default), and the runbook shape for a future migration run.
   Document only; nobody executes it in this epic.
3. **Entrypoint shim** — `images/agent/` env-switched shim for the AgentCore
   invocation contract. Existing compose/balena code paths unchanged; CI E2E
   on all platforms must stay green (proves one artifact still serves all).
4. **ECR mirror workflow** — beside the balena release workflows; copies
   promoted GHCR digests to ECR by digest on release tags. Code + dry-run
   verification only; the real ECR target appears when the dev stack is
   authorized (gated, below).
5. **TypeScript CDK app** — `platforms/agentcore/`: runtime + IAM
   (least-privilege) + Secrets Manager wiring + `cdk.json`; `cdk synth` and
   structural assertions run in CI. No `cdk deploy` job, or one that stays
   owner-gated and does not run.
6. **Release workflow** — `release-agentcore.yml` beside the balena ones:
   tag-triggered synth + tests only. Actual deployment stays a separate,
   owner-authorized step that does not exist yet.

## Standing limits (bind every child)

- No AWS account access, no `cdk deploy`/diff against a real account, no
  credential creation or rotation, no AWS CLI configuration on any host —
  these need separate owner authorization.
- No Balena fleet changes of any kind; existing release workflows untouched.
- Bots touch no AWS credentials without the owner's explicit word (same rule
  as 1py.26).
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
  config when deploy is authorized.