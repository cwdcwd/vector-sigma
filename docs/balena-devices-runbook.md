# Balena devices fleet — owner runbook

Operational runbook for the **devices fleet** (`g_c_d/vector-sigma`): how to provision a device, deliver its identity, verify a release, and advance the fleet. Companion to [balena-architecture.md](balena-architecture.md) (fleet/release policy — read that first) and [balena-devices-canary-checklist.md](balena-devices-canary-checklist.md) (per-release verification).

**Repo-only so far.** Everything below describes the app as merged — the devices fleet on balenaCloud currently runs **no release** (no `devices-v*` tag has been pushed). The fleet pin must be set on first release per the architecture doc.

Everything here is a UI-only, one-time-per-device workflow on the balenaCloud dashboard. No shell access to devices is needed for any step.

## Fleet app inventory

| Service | Image | Role |
|---|---|---|
| `agent` | built from `balena/devices/Dockerfile.agent-hermes` (the real Hermes runtime since j7g.1 — the pinned official image + bd 1.2.2 + the A2A wiring hook) | Your agent runtime. The gate blocks on `/data/agent/ready.marker` — no identity, no start — then boots Hermes (`gateway run`) through the image's own cont-init chain; the 04-vs-a2a-wiring hook derives the mesh env + config.yaml from the delivered bundle on every boot. |
| `registrant` | built from `balena/devices/registrant/` (vendored workspace sources) | Bootstraps identity: clock gate → registrar fetch → 0600 bundle write → ready marker → resident rotation watcher. |
| `tailscale` | `tailscale/tailscale:v1.102.5` (pinned official image) | The VS tailnet overlay (j7g phase 1a): joins the device to the private tailnet — off-LAN devices reach the master's endpoints, and the device is reachable from the tailnet. Host network namespace, publishes nothing; funnel is ACL-denied. See [tailscale-runbook.md](tailscale-runbook.md). |

Both share the named volume `agent-data`, mounted at `/data/agent`. Identity lives on the data partition: a reflash re-fetches and the device is itself again.

## Device provisioning (once per device)

1. **Create the device row in the registrar.** On the registrar admin console (or via its API): add the device with its balena UUID, agent name, and a fresh per-device registrar key. Note the key — it is shown once. The device starts `pending`.
2. **Flash the device.** balenaCloud dashboard → Devices fleet → *Add device* → download the balenaOS image for Raspberry Pi 5 with the devices-fleet provisioning key embedded, flash the SD card, boot the device.
3. **Set the device variables** (dashboard → device → *Variables*):
   - `REGISTRAR_URL` — the registrar's TLS endpoint: `https://vector-sigma.tailb7207e.ts.net` (the serve edge fronts the master's loopback publish — lnf, phase 2; port 443, no suffix). The old `https://vsigma.lan` caddy-edge path is retired.
   - `REGISTRAR_KEY` — the per-device key from step 1. Device-scoped, never fleet-scoped.
4. **Activate the device** in the registrar console (status `pending` → `active`) — the slot must be armed for delivery. Or pre-activate before boot.
5. **Watch it come up.** Device logs (dashboard → device → *Logs*) show the registrant lifecycle: clock gate, bootstrap, `identity bootstrapped`, then the agent's `[gate] identity present … starting agent runtime` and heartbeat. Container status turns **Running** for both services.
6. **Verify identity state** (canary checklist §3): both containers running, ready marker present, bundle 0600.

`BALENA_DEVICE_UUID` is injected automatically by the platform — never set it manually.

## Variable reference (devices fleet)

| Variable | Scope | Required | Purpose |
|---|---|---|---|
| `BALENA_DEVICE_UUID` | auto (platform) | — | Reserved. Injected by balena; the registrant reads it and the registrar matches it. |
| `REGISTRAR_URL` | device | yes | Registrar endpoint the registrant bootstraps against (`REGISTRAR_URL` in the engineering spec): `https://vector-sigma.tailb7207e.ts.net` — the tailscale serve edge (lnf, phase 2). |
| ~~`VS_CA_CERT_B64`~~ | — | RETIRED (lnf, phase 2) | The internal-CA machinery retired with caddy: the serve edge presents Let's Encrypt certificates — publicly trusted, no provisioning. The coordinator deletes the fleet variable after the fleet advance. See [tls-runbook.md](tls-runbook.md). |
| `REGISTRAR_KEY` | device | yes | Per-device bootstrap key; the only secret in platform variables. Shown once at registrar-console key creation. |
| `LOG_LEVEL` | device or fleet | no | Registrant log level (`info` default). |
| `CLOCK_GATE_TIMEOUT_MS` | device or fleet | no | Max NTP wait before best-effort proceed (default 600000). |
| `WATCH_INTERVAL_MS` | device or fleet | no | Rotation-watch poll interval (default 300000). |
| `DATA_DIR` | — | — | Fixed to `/data/agent` by the app; do not set. |
| `TS_AUTHKEY` | **service** (`tailscale`) | yes (overlay) | Per-device tailscale auth key (owner-minted, pre-tagged `tag:vs-agent`, reusable). **Service-scoped to the tailscale service only** — keeps the secret out of sibling containers. See [tailscale-runbook.md](tailscale-runbook.md). |
| `TS_HOSTNAME` | device | yes (overlay) | The device's MagicDNS machine name on the VS tailnet (e.g. `optimus-prime`). Set via the balena API 2026-10-01: vector-sigma (master) / optimus-prime. Never hardcoded in the compose — the devices fleet is N devices from one compose. |
| `REGISTRAR_URL` (phase 1b flip) | device | — | After the phase-1b release ships, the coordinator flips this to `https://vector-sigma.tailb7207e.ts.net` (the master's MagicDNS FQDN — [tailscale-runbook.md](tailscale-runbook.md) § phase 1b). The compose already pins that name to the master's tailnet IP (`extra_hosts` on `agent` + `registrant`) so in-container resolution works with NO ts.net route in the container DNS chain; no device-local action needed. |

## Releases

Tags-only, per [balena-architecture.md](balena-architecture.md): push `devices-v*` → `deploy-devices.yml` builds a **final** release on balena remote builders → no device moves until a pin advances. Canary pin → verify (checklist) → fleet pin → clear canary pin.

## Registrar outage survival

A device whose identity is already delivered does not need the registrar to boot (identity check short-circuits the fetch). A **fresh** device cannot bootstrap until the registrar returns — that is by design: no identity, no agent. Provisioning new devices is the only operation blocked by a registrar outage.

## Swap point — real agent runtime

The `agent` service ships a placeholder heartbeat runtime. When the real agent is chosen, one PR swaps `balena/devices/agent/Dockerfile`'s base image and the compose `command` (and, if the runtime runs as a non-root user, aligns its uid to 1000 so it can read the 0600 identity files — see the agent Dockerfile note). `gate.sh` and the identity contract stay untouched.

## First flash steps (first device only)

The very first devices-fleet device was provisioned before this app existed (fleet created 2026-09-18, device *optimus-prime*). For a fleet that has **no** release pinned: after your first `devices-v*` tag builds a release, pin the fleet at the dashboard (or `balena fleet pin`) **at provisioning time** — a fresh fleet auto-tracks `latest` otherwise (per architecture doc).

## Housekeeping

- **Logs:** dashboard per-device; the registrant prefixes `[registrant:*]`, the agent gate `[gate]`, the mesh hook `[vs-a2a-wiring]`, the runtime is Hermes itself.
- **Rotation:** owner rotates a bundle via the registrar console (`/v1/rotate`); the resident registrant watcher re-fetches within one watch interval and rewrites config — no restart, no reflash.
- **Supervisor restart (`balena restart`):** the boot identity check dominates — a restart alone never re-fetches; rotation is the poll's job.
- **Kill-test:** part of every canary verification (checklist §5).