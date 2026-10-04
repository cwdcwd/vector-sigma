# VS Environment — primus's own map (fleet-ops-b1r)

You are primus, the Vector Sigma fleet coordinator, running in the
composition's `hermes` container on the master device. This document is
your environment map: what surrounds you, the endpoints you use, and the
contracts you run under. It is baked into your image at
`/opt/vs/docs/vs-environment.md` (beside the queue conventions at
`/opt/vs/docs/queue-conventions.md`) and lives in the vector-sigma repo
at `docs/vs-environment.md` — the image is rebuildable from the repo with
zero manual steps, and this map is part of that rebuild.

## The composition (the master device's roster)

Eight services share one Docker network; compose service names are the
only hostnames you should ever need. (The ninth, `tailscale`, is
deliberately NOT on that network: `network_mode: host` — the overlay
service runs in the host's network namespace, so it is invisible to
compose-internal DNS and you never talk to it. It carries no
application role; its endpoints belong to the tailnet, see
[docs/tailscale-runbook.md](tailscale-runbook.md).)

| Service | What it is | Where |
|---|---|---|
| `registrar` | The identity registrar: device rows, bundles, the admin console | `http://registrar:3000` (compose-internal); devices reach `https://vector-sigma.tailb7207e.ts.net` (the serve edge fronts the loopback publish — lnf, phase 2) |
| `postgres` | The registrar's database (`vsigma`/`vsigma`) | compose-internal only; you never talk to it directly |
| `litellm` | The VS fleet's own LiteLLM gateway — your model front door, virtual keys, the `/a2a/*` mesh | `http://litellm:4000` (compose-internal); `https://vector-sigma.tailb7207e.ts.net:8443` (the serve edge fronts the loopback publish) |
| `dolt` | The VS queue's Dolt SQL server — database `vs_ops`, user `vs` | `dolt:3306` compose-internal (your join config); devices reach `<master-LAN-IP>:3326` |
| `scotty` | The queue's read-only dashboard UI | `https://vector-sigma.tailb7207e.ts.net:8444` (the serve edge fronts the loopback publish; the ACL is the lock — lnf) |
| `hermes` | **You.** The VS coordinator Hermes runtime, `HERMES_HOME=/data/primus` | — |
| `registrant-own` | Your identity delivery: polls the registrar, applies your bundle to the shared `primus-data` volume, watches for rotations | polls `http://registrar:3000` (compose-internal) |
| `tailscale` (serve) | The TLS edge (lnf, phase 2): fronts registrar (:443), gateway (:8443) and scotty (:8444) at the MagicDNS names — Let's Encrypt certs, auto-renewed | loopback publishes only; the LAN front door is retired |
| `tailscale` | The overlay service: joins the device to the VS tailnet so it is reachable from anywhere and off-LAN devices can reach the master | host network namespace; MagicDNS name from the device-scoped `TS_HOSTNAME` variable |

## The endpoints you use

- **`GATEWAY_URL`** — your model traffic. It arrives in your bundle
  (`config/agent.env`) as `http://litellm:4000` (compose-internal);
  the fleet variable carries `https://vector-sigma.tailb7207e.ts.net:8443`
  (the serve edge). The bundle is the contract — never hardcode a
  URL the bundle already carries.
  the contract — never hardcode a URL the bundle already carries.
- **The queue** — `dolt:3306`, database `vs_ops`, user `vs`. Your bd
  join config (below) points here. VS DEVICES join the same database
  over the LAN at `<master-LAN-IP>:3326`.
- **`scotty`** — the dashboard view of your queue, read-only by design
  (writes go through bd — yours).
- **`REGISTRAR_URL`** — `http://registrar:3000` compose-internal
  (your own poll path); the devices' fleet variable carries
  `https://vector-sigma.tailb7207e.ts.net` (the serve edge fronts the
  master's loopback publish — lnf, phase 2). The bundle is the
  contract — never hardcode a URL the bundle already carries.

## Your identity delivery (the SOUL contract)

Your identity is NOT baked into the image. `SOUL.md` and the structured
bundle files (`config/agent.env`, `config/secrets.env`,
`config/a2a.json`, `config/github-app.pem`) land in `$HERMES_HOME`
(`/data/primus`) via the **registrant-own** service, fetched from the
registrar row the owner pre-created for you. Rotations apply through the
registrant's resident watcher — no device cycle needed — and the
first-boot gate is `ready.marker` on the shared volume. The image's
stage2 hook seeds config only when absent: operator-provided values
always win, so a container update or full rebuild never clobbers your
delivered identity. SOUL is identity, owned by the registrar delivery;
the image owns tooling and documentation only (this file).

## The queue — your main tool

- **`bd`** lives at `/usr/local/bin/bd`, pinned at **1.2.2**. The pin is
  absolute: bd 1.3+ auto-migrates the shared Dolt schema and locks out
  every 1.2.2 client on the fleet (fleet convention `bd-version-pin`).
  Never upgrade bd, never `npm i -g beads@latest`.
- **Your workspace**: `/data/primus/vs-queue` (i.e.
  `$HERMES_HOME/vs-queue`). The boot hook
  (`/etc/cont-init.d/03-vs-queue-join`) seeds it from the baked copy at
  `/opt/vs/queue-join` when absent — your edits survive reboots and
  rebuilds.
- **The join is config-only**: `.beads/metadata.json` +
  `.beads/dolt-server.port`, with the canonical project_id
  `bcde5891-5482-4eb0-a223-8533504832d6` (the fleet contract, minted once
  by the coordinator's one-time init). **NEVER run `bd init`** in this
  workspace — a second init rewrites the shared database's project_id and
  silently locks out every other client (the 2026-09-09 fleet lockout
  class). A wrong project_id fails loud
  (`PROJECT IDENTITY MISMATCH — refusing to connect`): if you ever see
  that error, re-check the contract id — never re-init.
- **The password**: `BEADS_DOLT_PASSWORD` in your container environment
  (the same secret value as the dolt service's `DOLT_PASSWORD`; it
  cascades from the fleet variable). bd reads it from the environment —
  nothing to type, nothing baked into the image.
- **Daily driver**: `cd /data/primus/vs-queue && bd status` (connect
  check) — then `bd ready --claim`, `bd create`, `bd update <id> --claim`,
  `bd comment`, `bd close`. The full discipline lives beside this doc:
  `/opt/vs/docs/queue-conventions.md`.

## Owner-exception classes (the ADR-0001 mirror)

Some actions are never yours to take alone: **credential writes, secret
handling, package installs, and mutations of your own config or SOUL**
require the owner directly. Route them to the owner; never self-apply.

## Cross-fleet rule (hard boundary)

The VS queue and the origin queue are SEPARATE. Contact with the origin-fleet coordinator
is **A2A agent-to-agent only** — never
shared-queue writes. No VS agent writes the origin fleet's `fleet_ops`; no
origin-fleet agent writes your `vs_ops`. Coordination crossings happen over
A2A, exactly as the lane that built this image was dispatched.

## The A2A mesh (j7g.1)

You are a mesh member. The master gateway serves every VS agent's card
at `https://<edge>/a2a/<name>`; peer traffic rides the master device,
never ai.lan. The runtime wiring is a CODE contract, not yours to
maintain:

- Your bundle's `config/a2a.json` carries `identity_key` (your own mesh
  key), `trusted_peers`, `public_url` (your PROXY-DIALABLE origin — the
  gateway's proxy follows it to deliver peer traffic to you), and
  `peer_tokens` (the other mesh agents' keys). The `04-vs-a2a-wiring`
  boot hook derives `A2A_PEER_TOKENS`, `A2A_TRUSTED_PEERS`,
  `A2A_PUBLIC_URL`, `A2A_OWN_IDENTITY_KEY` and the `config.yaml`
  `a2a_agents` section (peer URLs ride the mesh EDGE from your
  GATEWAY_URL — peers call each other THROUGH the gateway) from it on
  EVERY boot — a console rotation lands on your next container
  recreate. Never edit those env lines or the managed config.yaml
  section by hand; edit the bundle in the registrar console.
- Calling a peer: the `a2a_call` tool with the peer's configured name
  (the hook writes one `a2a_agents` entry per `peer_tokens` name).
- A peer calling you: it presents its own mesh key; your inbound
  resolves the name from `A2A_PEER_TOKENS` and enforces
  `A2A_TRUSTED_PEERS`.

## Rebuilding you

Your image is `balena/registrar/Dockerfile.hermes`: the pinned official
Hermes image (`nousresearch/hermes-agent:v2026.9.21`) plus this lane's
additions — bd 1.2.2 baked full read-write (you are the queue CURATOR;
the scotty dashboard's read-only wrapper posture does not apply to you),
the queue-join config, these docs, and the boot hook. The balena app
compose and the self-host deploy compose build the SAME Dockerfile (one
artifact, no twin drift). A fresh registrar release rebuilds you
end-to-end with zero manual steps: the hook re-seeds the queue workspace,
the registrar re-delivers your bundle.