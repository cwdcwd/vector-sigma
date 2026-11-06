# Console roadmap — from identity registrar to factory console

Status: **proposal** (design doc for review; nothing here is built yet).

Vector Sigma's end goal is a console where a human works with a **master
agent** (primus) that coordinates **independent role agents** (builder,
tester, reviewer, red-teamer, architect) running on any workload
substrate, as a well-lit software factory. Balena is the first substrate;
AWS AgentCore and others follow.

Today's admin console is a solid, hardened *identity registrar* UI. This
doc proposes how it grows into the factory console, in phases, without
giving up the security posture that got it here.

## Where the console is today

- **Pages:** device table (agent, UUID, status, bundle version, delivery
  slot, created), device detail (bundle, logo, key and mesh actions),
  structured bundle editor with the persona pre-fill picker, audit log,
  A2A mesh (strict switch + per-device readiness), admin keys, mesh-enroll
  keys.
- **Stack:** server-rendered HTML from Fastify (`admin-html.ts`), one
  small same-origin script (`editor.js`), strict CSP (`default-src
  'none'; script-src 'self'; frame-ancestors 'none'`), CSRF tokens,
  admin-key sessions.
- **Model:** an agent *is* a balena device. `devices.balena_uuid` is the
  primary key; the UI speaks device vocabulary (UUID, re-arm slot).
- **Signals that exist but are not surfaced as fleet health:**
  `a2a_public_keys.guard_status`, `reported_bundle_version`, `reported_at`
  (the A2A page derives "fresh" and "applied current" from them).
- **Invisible:** the work queue (`vs_ops` in the master stack's Dolt), what
  each agent is doing, whether an agent is alive, what needs a human
  decision, and anything primus is planning.

## Product decisions this doc assumes

| Decision | Choice |
|---|---|
| Audience | A **product for other organizations**, not only the original operator |
| Delivery | **Self-hosted per organization first**, with a path to a hosted multi-tenant console later |
| Relationship to primus | **Full command surface**: give primus goals, see and steer its plans from the console |
| Human sign-in | **Passkeys (WebAuthn) by default, optional OIDC** for organizations that want SSO |
| Frontend | **Stay server-rendered.** Partial updates and live views via self-hosted htmx + server-sent events; no SPA |

## Principles (unchanged, extended)

1. **Secrets are delivered, never baked or displayed.** Write-only fields
   stay write-only; nothing in a live view ever renders a secret.
2. **The console never bypasses the queue.** Approvals and goals go to
   primus (the queue curator) and are audited; the console does not write
   beads directly.
3. **Substrate-neutral UI.** Every page and action works through an
   adapter interface; Balena-specific wording lives only in the Balena
   adapter.
4. **Strict CSP survives.** htmx and the SSE client are served from
   `'self'`; no inline script, no third-party origins.
5. **Everything is audited per workspace,** including reads of sensitive
   views (bundle contents) and every command sent to primus.

## Information architecture

```
┌ Vector Sigma ─ [workspace ▾] ─────────────────────── [⌘K primus] [user ▾] ┐
│ Control room │ Factory floor │ Approvals (3) │ Agents │ Substrates │ Audit │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Control room** (home): fleet health and the attention strip.
- **Factory floor:** the pipeline board over the queue.
- **Approvals:** every decision waiting on a human.
- **Agents:** list → agent detail (identity, bundle, history, logs,
  actions); "New agent" flow.
- **Substrates:** connected deploy targets (Balena fleet, AgentCore
  account, Compose host) and their credentials/health.
- **Audit:** today's log, filterable by agent, user, and action.
- **⌘K primus:** the command pane, reachable from every page (Phase 3).
- Today's A2A mesh, admin keys and mesh-enroll keys move under
  **Settings → Security**.

## Phases

### Phase 0 — Foundations

Everything later depends on these; none is user-visible on its own.

**0.1 Agent and substrate model.** Rename *device* to *agent* in the
schema and UI and stop keying on balena:

```sql
agents (
  id            uuid primary key,          -- was devices.balena_uuid
  workspace_id  uuid not null,
  agent_name    text not null,             -- unique per workspace
  role          text,                      -- from persona: coordinator|builder|tester|...
  substrate_id  uuid not null references substrates(id),
  substrate_ref text not null,             -- balena device UUID, AgentCore runtime ARN, ...
  status        text not null,
  ...
)
substrates (id, workspace_id, kind,        -- 'balena' | 'agentcore' | 'compose'
            name, config jsonb, created_at)
```

Migration keeps existing rows working: each device becomes an agent on a
`balena` substrate with `substrate_ref = balena_uuid`; the device API
(`/v1/bootstrap`, `/v1/rotate`, ...) accepts the old identifier
unchanged.

**0.2 Substrate adapter interface.** One small TypeScript interface; the
console calls only this:

```ts
interface SubstrateAdapter {
  kind: 'balena' | 'agentcore' | 'compose';
  provision(spec: AgentSpec): Promise<{ substrateRef: string }>;
  deliverIdentity(agent: Agent): Promise<DeliveryPlan>; // bootstrap key, secret ref, ...
  status(agent: Agent): Promise<RuntimeStatus>;         // online, last seen, version, restarts
  logs(agent: Agent, opts: { tailLines: number }): AsyncIterable<string>;
  restart(agent: Agent): Promise<void>;
  decommission(agent: Agent): Promise<void>;
}
```

The **Balena adapter** wraps today's behaviour and replaces operator SSH
(`balena-engine restart`) with the balena API for restart and logs.

**0.3 Heartbeat.** Formalize the existing report into a periodic
heartbeat from the registrant (and from AgentCore's shim later): agent
id, running bundle version, guard status, model route, uptime, current
bead (if any). Stored as latest-state plus a short history.

**0.4 Accounts, workspaces, roles.**
- Users sign in with **passkeys**; **OIDC** is optional per workspace.
- Roles: **viewer** (read), **approver** (decide approvals), **operator**
  (agent lifecycle, restart, bundles), **admin** (users, substrates,
  security settings).
- Existing admin keys become **API tokens** scoped to a workspace and role.
- Self-hosted installs default to one workspace; the schema is
  multi-workspace from day one so the hosted path needs no migration.

**0.5 Live plumbing.** Self-hosted htmx for partial updates and an SSE
endpoint per view (`/admin/stream/<view>`), CSP-compatible, with
server-side role checks on every stream.

### Phase 1 — Control room and new-agent flow

**Control room** replaces the device table:

```
Attention ─────────────────────────────────────────────────────────────────
 ! 2 agents running an older bundle than delivered   [review]
 ! 1 agent pending activation                         [activate]
 ! mesh strict mode ready to enable                   [open]

Agents ────────────────────────────────────────────────────────────────────
 ┌ optimus-prime ─────────┐ ┌ wheeljack ─────────────┐ ┌ bumblebee ─────────┐
 │ coordinator · balena   │ │ builder · balena       │ │ tester · agentcore │
 │ ● online · 12s ago     │ │ ● online · 30s ago     │ │ ○ offline · 2h ago │
 │ bundle v7 (current)    │ │ bundle v4 → v5 pending │ │ bundle v3 (current)│
 │ guard: strict ok       │ │ guard: strict ok       │ │ guard: —           │
 │ on: vs-12.3 (build)    │ │ on: vs-14.1 (build)    │ │ idle               │
 └────────────────────────┘ └────────────────────────┘ └────────────────────┘
```

- Cards update live over SSE; filter by role, substrate, state.
- Agent detail gains **Apply and restart** (bundle save → adapter
  restart → wait for heartbeat with the new version), **recent logs**,
  and **bundle history** with diff and rollback (keep prior versions,
  not only the latest).

**New-agent flow** replaces the bare form:

1. **Role & persona** — pick from the persona library (pre-fill stays
   advisory; the operator reviews).
2. **Substrate** — Balena (live), AgentCore and others shown, disabled
   until their adapter ships.
3. **Secrets** — write-only fields, with what each one is for.
4. **Review & create.**
5. **Bring-up tracker** — created → identity armed → delivered → ready
   marker → mesh-enrolled → first heartbeat, each step with its error and
   a retry where safe.

On a fresh install this same flow is **onboarding**: create the
workspace, connect a substrate, bring up primus, add the first role
agents.

### Phase 2 — Factory floor and approvals

**Factory floor**: a read-only board over `vs_ops`.

```
Epic: area:payments ─────────────────────────────────────────────────────────
 Ready (4)        Build (2)            Test (1)           Review (1)    Done (12)
 vs-14.3          vs-14.1 wheeljack    vs-13.9 bumblebee  vs-13.7       ...
 vs-14.4          vs-14.2 wheeljack    ⚠ no evidence 6h   ultra-magnus
```

- Columns come from bead status and the pipeline role labels; each card
  links its PR and CI state.
- **Stuck detection:** claimed with no evidence for N hours, CI red for
  N hours, review requested with no reviewer.
- Throughput and cycle time per epic and per role.
- Read access via a least-privilege Dolt user; the console never writes
  the queue.

**Approvals inbox**: every item waiting on a human (`needs:owner-approval`
beads, gated deploys, strict-mode switches, persona sign-off).

- Approve / decline / ask-for-changes with a short reason.
- Decisions are sent to **primus**, which records them on the bead; the
  console audits the request and shows primus's acknowledgement.
- Approver role required; nothing is decided by viewing.

### Phase 3 — Primus command pane

A pane on every page (and ⌘K) where a user works with the master agent:

- **Goals in:** "ship X", "fix the flaky Y test". Primus turns a goal into
  an epic with child beads; the pane shows the plan as it forms.
- **Steer:** reorder, cut scope, pause or resume an epic, reassign a role,
  answer primus's questions.
- **Threads** per goal, persisted and searchable; each thread links its
  epic and beads on the factory floor.
- **Transport:** the console gets its own signed A2A identity (same
  signed-identity scheme as agents, see `a2a-signed-identity.md`) and
  talks to primus over A2A; replies stream to the browser over SSE.
- **Boundaries:** the pane relays *work* requests. Primus keeps its own
  rules: credential, config and soul changes are refused over A2A and stay
  owner actions in the console's own forms.

### Phase 4 — AgentCore adapter

The UI already shows AgentCore as a substrate option; this phase makes
it work (scope per [platforms/README.md](../platforms/README.md#adding-aws-agentcore-next)):

- ECR mirror of promoted digests (copied by digest).
- Entrypoint shim for AgentCore's invocation contract, behind an env
  switch in the agent image.
- Identity delivery through AWS Secrets Manager, read by the registrant.
- Deploy definition under `platforms/agentcore/` plus a release workflow.
- Adapter: `provision`, `status`, `logs` (CloudWatch), `restart`,
  `decommission` mapped to AgentCore Runtime APIs.

## Hosted multi-tenant path (later)

Designed for now, built later:

- Workspace isolation in every query, stream and audit row (already
  required by 0.4).
- Per-workspace encryption keys for stored bundles.
- Substrate credentials held per workspace; agents always run on the
  customer's substrate, never on shared infrastructure.
- Billing, quotas and usage reporting (model spend per agent is already
  visible through the gateway).

## Related spike: secrets management

Central rotation and audit, bring-your-own secret stores, and keeping
secret values off agents are investigated in
[secrets-management-spike.md](secrets-management-spike.md). Its outcome
adds a **Secrets** section to the console (catalog, grants, rotation
fan-out, usage) and feeds the substrate adapter's identity delivery.

## Security notes

- New attack surface: user sign-in, SSE streams, the primus pane. Each
  gets role checks server-side, CSRF on every write, and rate limits like
  today's login.
- Live views must never render secret material; bundle contents stay on
  the explicit bundle page with an audited read.
- The primus pane is a prompt-injection path *into* primus: messages are
  attributed to the signed-in user, rate limited, and primus treats them
  as work requests, never as authority over its own config.
- Logs streamed from substrates can contain secrets; the adapter runs the
  existing credential scanner over log lines before they reach the
  browser.

## Open questions

1. **Workspace = one factory?** Or can a workspace hold several factories
   (several primus instances)?
2. **Queue access for Phase 2:** read Dolt directly with a read-only user
   (simplest), or go through primus for everything (one path, slower)?
3. **Heartbeat cadence and retention** (proposal: 30 s, 7 days of history).
4. **Bundle history depth** (proposal: last 20 versions, secrets
   redacted).
5. **Which OIDC providers first** (proposal: GitHub and Google, then
   generic OIDC).

## Suggested first slice

Phase 0.1 + 0.2 (agent model + Balena adapter) and 0.3 (heartbeat),
then the Phase 1 control room cards. That is the smallest set that makes
the factory visibly "lit" and unblocks every later phase.
