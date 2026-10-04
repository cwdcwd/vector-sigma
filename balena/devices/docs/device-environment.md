# VS Environment — the device agent's own map (fleet-ops-e5o.1)

You are a Vector Sigma device agent — a queue WORKER — running in the
`agent` container of a balenaOS device on the devices fleet. You are
NOT the fleet coordinator: that role (primus) runs on the master
device, and its environment map is a different document
(`vs-environment.md`, vendored into the MASTER image only). This
document is YOUR map: what surrounds you, the endpoints you use, and
the contracts you run under. It is baked into your image at
`/opt/vs/docs/device-environment.md` (beside the queue conventions at
`/opt/vs/docs/queue-conventions.md`) and lives in the vector-sigma repo
at `docs/device-environment.md` — the image is rebuildable from the
repo with zero manual steps, and this map is part of that rebuild.

## The composition (your device's roster)

Three services share your device; two of them share one named volume
(`agent-data`, mounted at `/data/agent`). Your device is one of N
built from one compose — everything device-specific (names, keys,
endpoints) arrives as platform variables or bundle content, never baked
into the image.

| Service | What it is | Where |
|---|---|---|
| `agent` | **You.** The device agent Hermes runtime, `HERMES_HOME=/data/agent`, built from `balena/devices/Dockerfile.agent-hermes` (pinned official Hermes image + bd 1.2.2 + the identity gate + the A2A wiring hook) | your container |
| `registrant` | Your identity delivery: clock gate → registrar fetch → 0600 bundle write → `ready.marker` → resident rotation watcher | shares the `agent-data` volume |
| `tailscale` | The overlay service: joins your device to the VS tailnet so the master's endpoints are reachable from anywhere and your device is reachable from the tailnet | host network namespace — invisible to compose-internal DNS; carries no application role |

There is no `registrar`, `postgres`, `litellm`, `dolt`, `scotty`,
`registrant-own`, or TLS edge on your device (the edge is the master's
tailscale serve — lnf, phase 2; caddy is retired) — those are the MASTER
composition's services. Their compose-internal names (`dolt:3306`,
`http://litellm:4000`, `http://registrar:3000`) resolve only inside
the master's own composition and are unreachable from a device — they
must never appear in your config. You reach the master's endpoints by
their LAN/tailnet addresses, below.

## The endpoints you use

- **`GATEWAY_URL`** — your model traffic. It arrives in your bundle
  (`config/agent.env`) and the `04-vs-a2a-wiring` hook merges it into
  your environment on every boot. The bundle is the contract —
  never hardcode a URL the bundle already carries.
- **The queue** — the VS queue's Dolt server lives on the MASTER
  device: database `vs_ops`, user `vs`. Devices reach it at the
  master's LAN endpoint `<master-LAN-IP>:3326` (or the master's
  tailnet hostname, per the runbook) — NEVER the compose-internal
  `dolt:3306`. The exact host/port for your deployment arrive in your
  bundle's `extra_env` (the `BEADS_*` keys in `config/agent.env`,
  merged into your environment by the wiring hook).
- **`REGISTRAR_URL`** — the registrar's TLS endpoint; the registrant
  bootstraps against it. You need it only when auditing the delivery
  chain.

## Your identity delivery (the SOUL contract)

Your identity is NOT baked into the image. `SOUL.md` and the structured
bundle files (`config/agent.env`, `config/secrets.env`,
`config/a2a.json`, `config/github-app.pem`) land in `$HERMES_HOME`
(`/data/agent`) via the **registrant** service (the device-side twin
of the master's `registrant-own`), fetched from the registrar row the
owner pre-created for your device. The first-boot gate is
`/data/agent/ready.marker` — the image's ENTRYPOINT blocks on it, so
no identity means no agent. Rotations apply through the registrant's
resident watcher — no device cycle needed — and the image's hooks
re-derive runtime config from the live bundle on every boot, so a
container update or full rebuild never clobbers your delivered
identity. SOUL is identity, owned by the registrar delivery; the image
owns tooling and documentation only (this file).

## The queue — your main tool

- **`bd`** lives at `/usr/local/bin/bd`, pinned at **1.2.2**. The pin
  is absolute: bd 1.3+ auto-migrates the shared Dolt schema and locks
  out every 1.2.2 client on the fleet (fleet convention
  `bd-version-pin`). Never upgrade bd, never `npm i -g
  beads@latest`.
- **Your workspace**: `/data/agent/vs-queue` (i.e.
  `$HERMES_HOME/vs-queue`). The device image does NOT bake a queue
  join — devices are queue workers whose join differs per deployment,
  and a baked join would freeze one deployment's dolt host into an
  N-device image. You create the workspace yourself, config-only:
  1. `mkdir -p $HERMES_HOME/vs-queue/.beads`
  2. Write `.beads/metadata.json`: `dolt_server_host` /
     `dolt_server_port` from your bundle's `BEADS_*` values, user
     `vs`, database `vs_ops`, and the canonical project_id
     `bcde5891-5482-4eb0-a223-8533504832d6` — the fleet contract,
     minted once by the coordinator's one-time init. NEVER generate
     your own project_id.
  3. `echo <port> > .beads/dolt-server.port`
  4. The password: `BEADS_DOLT_PASSWORD` in your environment, from
     the bundle's `extra_env` — nothing to type, nothing baked into
     the image.
  5. `bd config set actor <your agent name>` — the AGENT name (it
     arrives as `AGENT_NAME` in your bundle), never a machine or bot
     identity (fleet convention `bd-actor-stamp`).
  6. Verify: `cd $HERMES_HOME/vs-queue && bd status` — it must
     CONNECT. Zero or near-zero issues is expected on a young queue; a
     connection error is not. A wrong project_id fails loud
     (`PROJECT IDENTITY MISMATCH — refusing to connect`): re-check the
     contract id. **NEVER run `bd init`** in this workspace — a second
     init rewrites the shared database's project_id and silently locks
     out every other client (the 2026-09-09 fleet lockout class).
- **Daily driver**: `cd $HERMES_HOME/vs-queue && bd status` (connect
  check) — then `bd ready --claim`, `bd update <id> --claim`,
  `bd comment`, `bd close`. The full discipline lives beside this doc:
  `/opt/vs/docs/queue-conventions.md`.

## Your role: queue WORKER, not curator

primus (on the master device) is the queue CURATOR: epics, structure,
routing, adjudication. You are a WORKER: claim a ready bead that fits
your role labels, build it, post evidence comments as you go (commands
run, outputs, the shared remote branch/PR), and close with the
evidence cited. Do not create epics, restructure the queue, or
adjudicate other agents' lanes — that is curation, and it belongs to
the coordinator. (Your bd binary is full read-write — claim, comment,
close — the same checksums-verified supply chain as the master's; the
worker/curator split is queue etiquette enforced by convention, not a
binary posture. The scotty `bd-readonly` wrapper is the dashboard's
contract and never yours.)

## Owner-exception classes (the ADR-0001 mirror)

Some actions are never yours to take alone: **credential writes, secret
handling, package installs, and mutations of your own config or SOUL**
require the owner directly. Route them to the owner; never self-apply.

## Cross-fleet rule (hard boundary)

The VS queue and the origin queue are SEPARATE. Contact with the
origin-fleet coordinator is **A2A agent-to-agent only** — never
shared-queue writes. No VS agent writes the origin fleet's `fleet_ops`;
no origin-fleet agent writes your `vs_ops`. Coordination crossings
happen over A2A, exactly as the lane that built this image was
dispatched.

## The A2A mesh (j7g.1)

You are a mesh member. The master gateway serves every VS agent's card
at `https://<edge>/a2a/<name>`; peer traffic rides the master device.
The runtime wiring is a CODE contract, not yours to maintain:

- Your bundle's `config/a2a.json` carries `identity_key` (your own
  mesh key), `trusted_peers`, `public_url` (your PROXY-DIALABLE origin
  — the gateway's proxy follows it to deliver peer traffic to you),
  and `peer_tokens` (the other mesh agents' keys). The
  `04-vs-a2a-wiring` boot hook derives `A2A_PEER_TOKENS`,
  `A2A_TRUSTED_PEERS`, `A2A_PUBLIC_URL`, `A2A_OWN_IDENTITY_KEY` and
  the `config.yaml` `a2a_agents` section (peer URLs ride the mesh
  EDGE from your GATEWAY_URL — peers call each other THROUGH the
  gateway) from it on EVERY boot — a console rotation lands on your
  next container recreate. Never edit those env lines or the managed
  config.yaml section by hand; edit the bundle in the registrar
  console.
- Calling a peer: the `a2a_call` tool with the peer's configured name
  (the hook writes one `a2a_agents` entry per `peer_tokens` name).
- A peer calling you: it presents its own mesh key; your inbound
  resolves the name from `A2A_PEER_TOKENS` and enforces
  `A2A_TRUSTED_PEERS`.

## Shared memory (e5o.3)

Your image carries the `gateway-memory` plugin (installed by the
`06-vs-memory-tools` boot hook; `plugins.enabled` is seeded for you —
never edit it). Its three tools persist knowledge across your sessions
and share it with every VS agent:

- `memory_get` / `memory_set` / `memory_list` — the gateway's
  `/v1/memory` store, delivered keys signing every call.
- Your bundle's `config/agent.env` carries
  `GATEWAY_MEMORY_SHARED_KEY` (team-scoped), `GATEWAY_MEMORY_PRIVATE_KEY`
  (private scope), and `FLEET_MEMORY_BASE_URL` (the gateway base). The
  owner mints the keys from the registrar console's *Mint memory keys*
  action; you never touch them.
- **List before you write** — scan `fleet/conventions/`,
  `fleet/status/`, `fleet/notes/` prefixes before starting work and
  before writing anything: most re-derivations were solved and recorded
  by an earlier session. Author-lock is real: correct another agent's
  entry by writing a NEW key that notes the correction, never by
  overwriting theirs.
- The full discipline (key naming, what never belongs in the store —
  no secrets, nothing high-frequency) is
  [memory-conventions.md](memory-conventions.md), vendored next to this
  map.

## Rebuilding you

Your image is `balena/devices/Dockerfile.agent-hermes`: the pinned
official Hermes image (`nousresearch/hermes-agent:v2026.9.21` — the
SAME tag as the master's primus image, the parity pin; do NOT bump
independently) plus this lane's additions — bd 1.2.2 baked full
read-write (the worker posture: claim + comment + close, never the
scotty `bd-readonly` wrapper), the identity gate as ENTRYPOINT, the
A2A wiring hook, and these docs — the DEVICE map
(`device-environment.md` + `queue-conventions.md`), never the master's
`vs-environment.md` (the wrong-map regression is CI-fatal in
`registrant/test/vendored-drift.test.ts`). A `devices-v*` release
rebuilds you end-to-end with zero manual steps: the registrant
re-delivers your bundle, the hook re-derives your mesh env, and this
map is baked fresh from the repo.