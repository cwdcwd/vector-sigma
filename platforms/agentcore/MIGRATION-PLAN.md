# AgentCore state and identity migration plan (design — authorizes nothing)

**Status: planning document only.** This is the epic's staged child for
state/identity migration planning. It records the inventory of Vector
Sigma's existing state and identity surfaces, the default policy that
**nothing migrates**, the runbook *shape* a future migration run would
follow, and the owner decision points and authorization gates that guard
each step. It contains no deployable CDK, no workflow, no AWS account
references, no credential values, and no executable commands. Nobody
executes this plan as part of the current epic, and this document
authorizes nothing — a future run needs every gate below separately
granted.

Authoritative sources for this document (read this session, from the
current repo at `main` plus the epic plan):

- Epic scope plan: `docs/plans/agentcore-platform-plan.md` at commit
  `4a36665908675ee233800605ea391f439071785e` on branch
  `docs/agentcore-platform-plan` (open PR
  [#140](https://github.com/cwdcwd/vector-sigma/pull/140)). This plan is a
  git-reference citation rather than a relative link until that branch
  merges; its staged-child list is the source of the sequencing here.
- Adapter design: [`README.md`](README.md) in this directory (merged design
  pass) — the AgentCore boundary, three identity planes, and the explicit
  divergence from the example identity-delivery sketch floated in
  [`../README.md`](../README.md).
- Current deployment facts: [`../../docs/balena-architecture.md`](../../docs/balena-architecture.md),
  [`../../docs/device-environment.md`](../../docs/device-environment.md),
  [`../../docs/vs-environment.md`](../../docs/vs-environment.md),
  [`../../docs/credential-rotation-runbook.md`](../../docs/credential-rotation-runbook.md),
  [`../../docs/a2a-conventions.md`](../../docs/a2a-conventions.md),
  [`../../docs/queue-conventions.md`](../../docs/queue-conventions.md),
  and the bundle contract in [`../../shared/src/index.ts`](../../shared/src/index.ts).

## 1. Standing policy: nothing migrates by default

1. **Both Balena fleets keep operating unchanged.** The registrar fleet and
   the devices fleet, their release workflows, their images, and all of
   their state are untouched by this epic. This is not a transition state —
   it is the steady state, and the AgentCore adapter exists *alongside* it
   as parallel support.
2. **The default state of a future AgentCore-hosted agent is
   `balena twin keeps running`.** Any per-agent transition is opt-in,
   per-agent, and owner-approved (gate 3 below); a device never loses its
   Balena operation as a side effect.
3. **No state leaves today's deployment.** The registrar's PostgreSQL,
   the Dolt queue, device identity bundles, and all gateway keys stay
   exactly where they are. Nothing in the epic creates an AWS-side copy
   of any of them, and a future migration run adds nothing durable on the
   AWS side except the runtime resources the migrating agent itself needs.
4. **No identity value changes hands.** No bundle file, no key, no
   bootstrap credential is copied into AWS Secrets Manager, an image
   layer, CDK context, user data, or logs. Where the adapter design
   accepts outbound credentials (AgentCore Identity), the referenced
   credentials are *separately minted* for that purpose — the existing
   fleet credential classes are never re-homed to AWS.
5. **The untracked bootstrap class stays device-only.** `REGISTRAR_KEY`
   authenticates a device's registrant against
   `POST /v1/bootstrap` (single-shot slot consumption), `/v1/status`,
   and the device report paths. A runtime-hosted agent has no
   balena device UUID and therefore no row, no slot, and no legitimate
   way to present bootstrap identity; never issue, copy, or re-point a
   device bootstrap key to an AgentCore runtime.

## 2. Inventory: today's state and identity boundaries

Everything below is read from the current repo sources (the Balena two-fleet
architecture doc, both environment maps, the rotation runbook, and the
shared bundle contract). Synthetic names are used throughout; no values.

### 2.1 Durable state (where it lives, and that it stays)

| State surface | Lives today | Authority | Migration posture |
|---|---|---|---|
| Device registry rows (balena UUID, status, delivery slots, key hashes) | registrar PostgreSQL (`vsigma`) | compose/Balena registrar | **Stays.** Never mirrored to AWS, never keyed against a runtime. |
| Identity bundles (versioned blobs: `SOUL.md`, `config/agent.env`, `config/secrets.env`, `config/a2a.json`, `config/github-app.pem` — per-file `0600` writes) | registrar PostgreSQL blob + device volume via the registrant | registrar bundle plane | **Stays.** Delivered/rotated only through the existing plane. |
| Delivery slots (single-shot `/v1/bootstrap`, armed/consumed + re-arm window) | registrar PostgreSQL (`delivery_slots`) | registrar | **Stays.** Consumed only by a device's registrant. |
| Rotation registry (deliver-then-revoke state machine, `credential_rotations`) | registrar PostgreSQL | registrar + gateway | **Stays.** Existing tracked flows (`a2a_identity`, `model_key`) unchanged. |
| Delivery/audit history (`delivery_log`, audit rows) | registrar PostgreSQL | registrar | **Stays.** |
| Queue state (the `vs_ops` Dolt database, join config, canonical project id) | master device Dolt server, served to devices on a tailnet TCP forward | queue conventions | **Stays.** A runtime joining the queue is an open question (§4), not part of a default. |
| Agent home state (`$HERMES_HOME` on the device volume: bundle files, derived `.env`/`config.yaml`) | device named volume, rebuilt from the bundle by the image hooks + registrant | bundle plane | **Stays for balena devices.** A runtime-hosted agent's equivalent is the open persistence question (§4). |
| Primus coordinator state (`/data/primus`) | master device named volume | bundle plane | **Stays.** |
| Tailscale state (per-node identity, serve certs) | device hosts' ts-state volumes | tailscale runbook | **Stays.** No runtime agent joins the tailnet by default. |
| Durable state that does NOT exist | — | — | By design, nothing durable is created on AWS for fleet state: the adapter design forbids runtime session state from replacing registrar or queue state. |

### 2.2 Identity and credential classes (who holds them, and that they stay)

| Credential class | Alias / shape | Issued by | Today's holder | Migration posture |
|---|---|---|---|---|
| Device bootstrap credential | `REGISTRAR_KEY` platform variable, shown once, untracked, immediate-cut rotation | owner via console | the device's own registrant only | **Stays device-only.** A runtime is never issued one (no balena UUID — §1.5). |
| A2A mesh identity key | `vs-<agent>-a2a` (versioned `-r<n>`) | registrar's mesh-enroll action | agent runtime via its bundle (`config/a2a.json`), peers via `peer_tokens` | **Stays fleet-side.** Runtime mesh membership is an open gated question (§4), never a default. |
| Gateway model key | `model-<agent>` (`GATEWAY_API_KEY` in `config/agent.env`) | registrar's keyed mint actions | device agent via bundle | **Stays.** Whether a runtime's model traffic uses the same gateway or something else is an open design question (§4). |
| Machine keys (mesh-enroll, scoped) | the `mk_`-prefix scoped machine key (`MESH_ENROLL_KEY`), bundle-delivered (`config/agent.env`) or the primus service variable — distinct from the `vs-<agent>-a2a` sentinel the mesh-enroll flow mints server-side | owner console / registrant | the specific agent runtime | **Stays.** |
| Gateway memory keys | `GATEWAY_MEMORY_SHARED_KEY` / `GATEWAY_MEMORY_PRIVATE_KEY` | owner console | each agent via bundle | **Stays.** |
| GitHub App identity | bundle `config/github-app.pem` | owner provisioning | agent via bundle | **Stays.** |
| Upstream model provider keys | gateway-virtualized | owner (never bot-side) | LiteLLM gateway only | **Stays.** Agents never hold provider keys; that property is preserved on any platform. |
| Release-plane credential | `BALENA_TOKEN` Actions secret | owner | release workflows only | **Stays. Existing release workflows untouched.** |
| Future AWS-side outbound credentials (design) | OAuth client / API key referenced by AgentCore Identity | owner-approved provisioning path, designed in [`README.md`](README.md) — nothing minted yet | not used today | **Default: never minted.** Any future mint is a separately reviewed design change, never a copy of the classes above. |

### 2.3 The boundaries this inventory establishes

- **Control plane** (registrar + PostgreSQL + gateway + queue + edges):
  permanently compose/Balena, per the adapter design. AgentCore hosts no
  part of it.
- **Agent execution plane** (the agent and primus runtime images): the
  *only* surface a future migration could move, per-agent, behind gates.
- **Identity plane**: the registrar stays the identity authority for the
  fleet it serves. An AgentCore runtime executing an agent does not
  implicitly become a fleet device, a mesh member, or a queue client.
- **Network plane**: the tailnet and its serve edges stay exactly as they
  are; how an AgentCore runtime would reach gateway/queue/registrar
  endpoints (public networking, VPC, or neither) is an unresolved adapter
  question documented in the design README, to be answered before any
  deploy authorization.

## 3. Target model under AgentCore (what a migrated agent looks like)

Per the adapter design in [`README.md`](README.md), an AgentCore-hosted
agent is **only** the runtime execution of the agent image: an
ECR-mirrored, digest-pinned copy of the promoted image under an entrypoint
shim that speaks one explicitly chosen AWS protocol. Concretely, the
migration-relevant delta versus a device agent is:

- **Execution**: bounded AgentCore runtime sessions instead of a long-lived
  device container. Session lifetime, persistence, and scaling semantics
  must be selected deliberately at deploy time (open questions in the
  design README apply).
- **Image source**: same promoted digest, mirrored into ECR by digest; the
  runtime execution role gets image-pull scope on that one repository.
- **Identity**: none of the fleet identity classes move. A dev-stack
  verification agent carries only synthetic, non-fleet credentials of its
  own. If (and only if) the owner later approves outbound-credential use,
  that runs through AgentCore Identity's provider flow and is a separately
  minted credential — consistent with the design's divergence from the
  `platforms/README.md` "Secrets Manager read by the registrant" example.
- **What it is NOT**: not a registered device (no row, no bundle, no
  bootstrap key), not a mesh member (no `a2a.json`, no card, no
  `peer_tokens`), not a queue client (no `BEADS_*` env) — until and unless
  each of those becomes a separately designed, separately authorized
  capability (§4).

## 4. Open migration design questions (owner decision points, D#)

These are the decisions a future migration run needs answered by the owner
*before* the corresponding phase starts. None is answered here; each is
tracked as a decision, not as assumed fact.

| # | Decision | Why it is open |
|---|---|---|
| D1 | Target Runtime protocol (HTTP `/invocations` + `/ping`, MCP, or A2A) and the shim's contract | RESOLVED (stage 3): the HTTP contract is implemented — the agent image bakes the invocation listener at `/usr/local/bin/agentcore/` behind the `AGENTCORE_HTTP` gate switch (POST `/invocations`, GET `/ping`, 0.0.0.0:8080; JSON responses; SSE not served). The MCP and A2A alternatives were never shimmed and remain out of scope for the image. |
| D2 | Region, runtime compute configuration, and endpoint strategy for the isolated dev stack | Account-dependent and cost-relevant; nothing exists to check against until gate 1 lands. |
| D3 | ECR repository naming and the exact digest-verification mechanism for the mirror | The design README requires digest-pinned copies of promoted images; the repository/mechanism choice is a deployment decision. |
| D4 | Which agent (if any) ever becomes the first real canary, or whether every phase before cutover stays fully synthetic | Any real agent involvement crosses from verification into migration — the exact line gate 3 exists to draw. |
| D5 | Model routing for a runtime-hosted agent: the existing LiteLLM gateway (delivered `GATEWAY_URL`) versus a Bedrock-direct path | Both are plausible; the gateway path reuses existing keys (a bundle-delivery problem, D7), the Bedrock path is a different outbound-credential design. |
| D6 | Durable-state policy for a runtime-hosted agent (`HERMES_HOME`-equivalent storage) | AgentCore runtime session state is not a durable store the way a device volume is; whether an agent runtime even *needs* persistent home state for the roles in scope is a design decision. |
| D7 | Whether a runtime-hosted agent ever receives fleet identity (mesh membership, queue join, model keys) and by what delivery mechanism | Today's identity delivery is designed around device volumes and balena-keyed routes (`/v1/bootstrap` slots, `balena_uuid`-authenticated report paths, resident rotation watchers). A runtime target needs its own delivery design — a separately scoped implementation, not an edit to this plan's defaults. |
| D8 | Cost/budget caps for any AWS usage (dev stack and beyond) | Nonzero spend starts as soon as gate 2 unlocks a deploy; caps belong in the deployment config before anything runs. |

## 5. The three authorization gates (separate from the epic, each other, and this document)

No gate is granted by this document, by the epic, or by any bead it
mentions. Each gate is a separate owner authorization, granted (if ever)
in its own words on its own clock. This is the done-when requirement of
the bead restated: the three gates are called out *separately* because
they are separately scoped.

| Gate | What it covers | What it unlocks | Explicit non-coverage |
|---|---|---|---|
| **G1 — AWS dev-account authorization** | Approving an isolated AWS account (or sandbox) for Vector Sigma use, plus the non-secret scope record that accompanies it (region intent, budget cap, no fleet traffic) | Existence of a place to `cdk synth` against docs, and later to deploy the dev stack | Not a permission for any bot or workflow to hold AWS credentials; account/credential handling stays owner-side. |
| **G2 — deploy-go for the dev stack** | A written "deploy the dev stack" decision, authorizing the first real CDK deploys in the dev account | Phase 1 execution below (mirror artifacts, CDK apply in the dev account, contract probes) | Still zero Balena impact, zero fleet traffic, zero production resources; still no identity of any fleet agent in scope. |
| **G3 — migration-run authorization** | Authorizing an actual migration run: designating the agent(s) and the target state, and executing the sequencing of §6 against a real agent | Moving any real agent's execution plane; any real identity delivery to a runtime (D5/D7 materializing) | Never covers both Balena fleets' steady state (§1); never covers registrar, gateway, or queue changes without their own separate authorization. |

## 6. Runbook shape for a future migration run (not executed here)

Sequenced phases. Each phase names its entry gate, its verification, and
its rollback. Phases 0-2 are verification-in-isolation; the first phase
that touches anything real is phase 3, under gate 3 only. Today, the epic
executes **none** of this.

```text
Phase 0  gate: G1 (dev account)            — prerequisites, no runtime work
Phase 1  gate: G2 (deploy-go)              — build + deploy + probe the dev stack
Phase 2  gate: G2                          — synthetic agent exercises on the dev stack
Phase 3  gate: G3 (migration-run)          — parallel canary of a named agent
Phase 4  gate: G3 + separate epic          — (only if ever approved) cutover/retire
```

### Phase 1 — dev stack bring-up (gate G2)

1. Mirror the single needed component image to ECR: resolve the promoted
   multi-arch index on GHCR, take the arm64 child, copy by digest, and
   prove equality of the served ECR digest against the promoted digest
   (the same digest-identity standard the image pipeline enforces).
2. Apply the CDK stack for the dev runtime: one runtime, one endpoint, the
   least-privilege execution role, image pull scoped to the one
   repository. The CDK deploy definition itself is produced by the
   separately scoped implementation stage of the epic (no CDK artifacts or
   synth checks exist in the repo yet); phase 1 cannot start until they
   exist and gate G2 has been granted. No other resources.
3. Contract verification, all against the dev stack only: the chosen
   protocol's listener (port + paths), health endpoint, one real
   invocation round-trip, expected error shapes, and the image's
   non-AWS entrypoint path (the shim is env-switched; a device-composed
   container must still boot the classic way).

Rollback (phase 1): delete the runtime + endpoint + the copied ECR
artifact; delete nothing else because nothing else was created. A phase-1
failure costs at most the mirrored image bytes.

### Phase 2 — synthetic agent exercises (gate G2)

1. Run a *synthetic* agent workload (its own throwaway identity, no fleet
   names, no mesh, no queue) on the dev runtime: startup, health, session
   behavior, teardown. Confirm the runtime's session model matches what
   the agent needs (D6 remains open for real agents until owner-ruled).
2. If outbound-credential use is part of the experiment: only
   AgentCore-Identity-referenced, separately minted synthetic credentials
   (never a copied fleet credential). Verify: the runtime retrieves only
   the scoped credential; nothing fleet-shaped appears anywhere.

Rollback (phase 2): delete the synthetic provider/runtime pieces.
No fleet or Balena state existed, so none is restored.

### Phase 3 — parallel canary of a real agent (gate G3, opt-in per agent)

1. **The agent's Balena operation does not pause.** The device keeps its
   release pin, its bundle, its identities. The canary is a *side-by-side*
   runtime execution of the same agent role, not a move.
2. Route only what gate 3's written authorization names (e.g. a read-only
   role with synthetic scope, or the model-routing decision D5 in a
   canary configuration). Fleet-facing surfaces — mesh membership, queue
   join — are excluded unless phase 4's separate epic has shipped and been
   authorized (§4, D7).
3. Verification: the runtime's behavior is compared against the
   concurrently running device twin (same prompts, same routing
   decisions), all traffic synthetic-in-scope per the gate's written
   boundaries, with budget caps (D8) live before the first invocation.

Rollback (phase 3): stop/delete the canary runtime and its endpoint. The
device twin never stopped; the registrar row never changed; there is no
identity window to reconcile because no fleet identity ever moved. This
structural property is why the parallel-support design keeps rollback
cheap: **rollback is a deletion of test resources, not a restoration of
fleet state.**

### Phase 4 — cutover (out of this epic and this plan's defaults)

A device-to-runtime *cutover* — actually retiring a device's fleet role
after its runtime twin takes over — is not planned by this document. It
would require: a shipped, reviewed identity-delivery implementation for
runtimes (D7), a separately approved epic, its own rollout and rollback
plans, and explicit handling of the device's mesh/queue/model identities
(deliver-then-revoke per the existing rotation runbook, adapted). This
plan deliberately does not sketch that epic's content; it only asserts
the boundary that no phase of this plan slides into it.

## 7. Verification policy for any future run (why the epic's checks can stop here)

- Within this epic: documentation checks only. This document and the
  adapter design pass the repo's checks (build + unit suites + structural
  tests); no AWS-side artifact exists to verify, and none is claimed.
- In a future run: every phase's verification list above; the digest
  identity proof for any mirrored image; the chosen-protocol contract
  probes; the synthetic-identity posture (zero fleet-shaped strings in
  dev-stack resources); the twin-comparison for phase 3; and the negative
  calibrations the rotation runbook already established (a deliberately
  wrong-credential probe must surface as a rejection, so an absence of
  failures proves the probes actually ran).

## 8. What this plan deliberately does not do

- It inspects no credential, discloses no value, and names no fleet,
  device, tailnet, account, or ARN — every example is synthetic
  (`<agent>` placeholders and the names above).
- It performs no AWS call of any kind and configures no AWS CLI anywhere.
- It changes no Balena file, no release workflow, no platform variable.
- It does not alter the bundle contract (`BUNDLE_SCHEMA_VERSION` stays
  1; no bundle field exists for a runtime target).
- It does not mint anything, including the "future AWS-side outbound
  credentials" row of §2.2, which is a design row only.
- It does not schedule, trigger, or pre-authorize any phase; the gates
  in §5 are the only way any phase starts.