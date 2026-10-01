# Tailscale overlay runbook (j7g phase 1a)

The VS tailnet: one private overlay network across the **registrar
(master)** and **devices** fleets, so (a) you reach the management layer
(registrar console, gateway `/ui`, scotty queue UI) from anywhere over
the tailnet, and (b) VS devices may sit in **different physical
locations** and still bootstrap, communicate, and be coordinated by
primus through the master's endpoints.

Everything here is a UI-only workflow on the balenaCloud dashboard and
the Tailscale admin console. No device shell access is needed.

## The overlay design (DECIDED — do not re-litigate)

Per-device tailscale overlay, NOT a subnet router advertising the LAN
(fleet consult unanimous, 2026-10-01; epic fleet-ops-j7g):

- **No subnet routes, no exit node.** Blast radius = the tailnet's
  device IPs only.
- **Funnel denied.** The tailnet ACLs explicitly deny the funnel node
  attribute for all VS tags — no VS service is ever exposed to the
  internet. The overlay is reachable only from the tailnet itself.
- **MagicDNS name is the canonical fleet endpoint** (`REGISTRAR_URL`
  etc. flip to it in phase 1b, canary-verified —
  [fleet-ops-lrb](https://github.com/cwdcwd/vector-sigma)); per-device
  variable fallback only if the canary proves resolver interference
  with the balenaCloud VPN.
- **Owner accepts the master-SPOF for coordination.** Agents retry
  through outages; accepted residual.
- Auth keys: owner-minted, **pre-tagged** (devices `tag:vs-agent`,
  master `tag:vs-master`), **reusable**, balena **SERVICE-scoped**
  variables.

## What shipped in phase 1a (this release)

A `tailscale` service in **both** balena composes, byte-identical
service spec:

| Property | Value | Why |
|---|---|---|
| image | `tailscale/tailscale:v1.102.5` | Official, PINNED tag (never `:latest`); arm64 verified in the registry index 2026-10-01; alpine-based (healthcheck shell exists) |
| `network_mode` | `host` | tailscaled manages the host network namespace (the containerboot contract shape) |
| `cap_add` | `net_admin`, `net_raw` | The containerboot contract |
| env (structural) | `TS_STATE_DIR=/var/lib/tailscale` | The ONLY env in the compose; secrets arrive as dashboard variables |
| volume | `ts-state` → `/var/lib/tailscale` | Tailnet identity survives container restarts — without it every restart mints a NEW tailnet node |
| label | `io.balena.features.kernel-modules: "1"` | Forward-proofing; the `tun` module is builtin on the current balenaOS 8 kernels |
| healthcheck | `kill -0 1` process liveness | Join state is canary evidence (`tailscale status` shows the tailnet IP), not a healthcheck question |
| ports | **none** | Host network + private overlay; funnel is ACL-denied |

`/dev/net/tun` was pre-flighted **before any tag** (6c2 AC1,
2026-10-01): present on both live hosts — `crw-rw-rw- 10,200` on
optimus-prime (192.168.0.210) and the master (192.168.0.164), module
builtin to the `6.12.94-v8` balenaOS 8.0.9 kernel. **However, the
canary on release 4373489 falsified the assumption that this made a
`devices:` passthrough unnecessary**: balenaOS containers do NOT
inherit the host's `/dev` — the container's tailscaled fell back to
`--tun=userspace-networking` (which cannot accept inbound tailnet
traffic). The service therefore ships the passthrough, plus
`TS_USERSPACE: "false"` (containerboot at v1.102.5 defaults userspace
mode TRUE — kernel tun requires the explicit override) and
`TS_BOOT_TIMEOUT: "24h"` (the 60s default makes a keyless first boot
exit-1 restart-loop instead of a benign park).

## Owner steps (once — tailnet + keys + ACLs first; TS_AUTHKEY after the first overlay release)

1. **Create the tailnet** (Tailscale admin console — owner action).
2. **Mint the auth keys** (admin console → *Settings* → *Keys*):
   - one key pre-tagged `tag:vs-master` (the registrar device), and
   - one key pre-tagged `tag:vs-agent` (every devices-fleet device),
   - both **reusable**.
3. **Write the ACLs** (admin console → *Access Controls*): deny the
   `funnel` attribute for all VS tags. Example policy:

   ```json
   {
     "tagOwners": {
       "tag:vs-master": ["autogroup:admin"],
       "tag:vs-agent": ["autogroup:admin"]
     },
     "acls": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:vs-master:*", "tag:vs-agent:*"] }
     ],
     "nodeAttrs": [
       { "target": ["*"], "attr": ["funnel"], "app": { "tailscale.com/what": "denied" } }
     ]
   }
   ```

   (The default ACL may already deny funnel for new tailnets; the
   explicit deny is the belt-and-braces the consult settled on.)
4. **Set the balenaCloud variables** (dashboard → device/service
   pages):
   - `TS_HOSTNAME` — **device-scoped**, per device: the MagicDNS
     machine name. Values already set via the balena API (2026-10-01):
     `vector-sigma` (master), `optimus-prime`.
   - `TS_AUTHKEY` — **service-scoped to the `tailscale` service** on
     each device (`tag:vs-master` key for the registrar device;
     `tag:vs-agent` key for each devices-fleet device), both
     **reusable**. SEQUENCING: a balenaCloud service-scoped variable
     can only be created once the service exists in the fleet's
     current release composition — so this is set AFTER the first
     overlay release builds (step 5 of the tag flow), not before. The
     first boot of the tailscale container without a key is benign:
     containerboot starts tailscaled unauthenticated and parks in
     NeedsLogin — the container stays Running/healthy (the long
     `TS_BOOT_TIMEOUT` in the compose service spec holds the boot
     watch open past the keyless park) but the device is not joined;
     the moment the key lands, the supervisor recreates the container
     with the env and the device joins. Join evidence is only expected
     from that point on. (If you prefer zero unjoined window: set the
     fleet-scoped `TS_AUTHKEY` BEFORE the release instead — the
     tailscale service reads it the same way; re-scope to the service
     afterwards for least privilege.)
5. **Watch it join**: the tailnet device list shows both machines with
   tailnet IPs; `tailscale status` on the canary shows the join (canary
   evidence, below).

## Deploy sequencing

No port or connectivity flips in phase 1a: the overlay service is
additive — existing services, endpoints, and variables are untouched.
Tag `registrar-v*` / `devices-v*` per the usual flow
([balena-architecture.md](balena-architecture.md)); the canary
sequence is the standard pin → verify → fleet pin → clear, plus the
overlay-specific items below.

Phase 1b (MagicDNS endpoint flip, fleet-ops-lrb) and phase 2 (caddy
retirement, fleet-ops-lnf) are separate, gated lanes — phase 1a does
not flip any endpoint.

## Canary evidence (per device, per release)

- [ ] `tailscale` container **Running** and healthy (process-liveness
  healthcheck), no restart-loop (supervisor event log keyed to the
  release id, per the standard stability window).
- [ ] **Join evidence**: `tailscale status` shows the device joined
  with a tailnet IP (the tailnet name matches `TS_HOSTNAME`).
- [ ] `ts-state` volume: identity persisted across a kill-test restart
  — the device is NOT a new tailnet node after restart (same tailnet
  IP / machine in the admin console list).
- [ ] No regression: **caddy edge healthy** (SNI probes
  `https://vectorsigma.lan/healthz` and
  `https://vectorsigma.lan:8443/health/liveliness` — the live name is
  the DEVICE-scoped `TLS_HOSTNAME` variable, probe with SNI), and
  **supervisor VPN connectivity intact** after tailscaled start
  (device online in the balenaCloud dashboard).
- [ ] Funnel posture: no public URL serves any VS service (the overlay
  publishes nothing; the ACL denies funnel).

## Blast radius / failure modes

- The overlay service carries no application role. If tailscaled dies,
  the device loses tailnet reachability only — registrar, gateway,
  queue, agent, identity all keep running; the supervisor restarts it.
- A wiped `ts-state` volume = a new tailnet node: the old machine entry
  goes stale in the admin console (remove it) and the device re-auths
  with its reusable key. Identity bundles, certs, and balena state are
  untouched (separate volumes).
- Tailnet outage = remote reachability only. On-LAN operations are
  unaffected.