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
- **Funnel denied.** The tailnet ACLs grant no `funnel` node
  attribute to any VS tag — funnel is opt-in, so the omission IS the
  deny — no VS service is ever exposed to the internet. The overlay is
  reachable only from the tailnet itself.
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
3. **Write the ACLs** (admin console → *Access Controls*): funnel is
   opt-in — an attribute a policy never grants is denied, so the
   belt-and-braces deny is simply to **omit any `funnel` nodeAttr
   entirely** (the original example's explicit-deny block used an
   invalid shape — an `app` object whose `tailscale.com/what` value was
   a string, which the console rejects with an unmarshal error —
   verified live 2026-10-02: the pasted policy throws before it can
   save). Example policy (the shape the owner has live on the tailnet):

   ```json
   {
     "tagOwners": {
       "tag:vs-master": ["autogroup:admin"],
       "tag:vs-agent": ["autogroup:admin"]
     },
     "acls": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:vs-master:*", "tag:vs-agent:*"] },
       { "action": "accept", "src": ["tag:vs-agent"], "dst": ["tag:vs-master:*"] }
     ]
   }
   ```

   The second rule is required: **tagged nodes are not members** — the
   `autogroup:member` src matches the owner's user, never the
   `tag:vs-agent` devices, so without the tag→tag accept the two nodes
   cannot talk to each other over the tailnet (the first overlay
   activation proved it: control-plane pongs while the data plane
   stayed dark). The owner's live policy already carries it; this
   example now matches.
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

## Phase 1b: the MagicDNS endpoint flip (fleet-ops-lrb)

The canary (2026-10-02, evidence on the lane bead) DECIDED the
mechanism — URLs keep the canonical MagicDNS name; in-container
resolution is PINNED, not resolved:

- **Why pinned**: the container DNS chain (embedded 127.0.0.11 →
  host dnsmasq → upstream) has **no ts.net route**, and the tailscale
  resolver at `100.100.100.100` serves ONLY tailnet names (it refuses
  everything else with SERVFAIL — no global resolvers are configured
  tailnet-wide). `accept-dns=true` **cannot fix this**: tailscaled
  runs in its own mount namespace and would rewrite only its own
  container's `resolv.conf`, never the host dnsmasq chain the other
  containers inherit. A plan-B per-device `REGISTRAR_URL=<tailnet-IP>`
  was REJECTED by the same canary verdict: it drags an explicit
  Host/SNI story into the app (Node derives `servername` from the URL
  host — an IP host means cert mismatch against any name cert) and
  multiplies variables per device. The pin achieves the same
  reachability with zero app changes.
- **What ships in the release** (repo-side, this lane):
  1. **Caddy aliases** — all three fronted sites (443 registrar,
     8443 gateway, 8444 scotty) gain the master's MagicDNS FQDN as a
     second site address via the `{$TS_MASTER_DNS:<default>}`
     substitution — provision-then-flip (the f57.9 hazard class): the
     edge serves the name BEFORE any device points at it. The AC2
     pre-flip canary proved the hazard live (TLS alert 80 on 443/8443
     for the MagicDNS SNI).
  2. **extra_hosts pins** — the literal pair
     `vector-sigma.tailb7207e.ts.net:100.124.197.78` on exactly the
     URL consumers: devices compose `agent` + `registrant` (the
     `REGISTRAR_URL` flip), registrar compose `hermes` (the
     `GATEWAY_URL`/`A2A_PUBLIC_URL` flip). `extra_hosts` is
     supervisor-supported (the docs.balena.io compose-fields table);
     it has no `${VAR}` path under the supervisor, so the pair is a
     structural literal (never a secret; the tailnet is ACL-gated).
     The pin test pins all three sites.
- **Owner/coordinator steps, in order** (after the release ships):
  1. Set `TS_MASTER_DNS` **fleet-wide on the registrar fleet** if the
     baked default is ever wrong (structural — the default mirrors
     the live value; the fleet variable wins).
  2. Owner tags `registrar-v*` → master pins the release → **verify
     the alias first** (provision-then-flip): SNI probe
     `https://vector-sigma.tailb7207e.ts.net/healthz` must answer
     200 with the internal CA. THEN tag `devices-v*`.
  3. Coordinator flips the fleet variables (balena MCP):
     devices fleet `REGISTRAR_URL=https://vector-sigma.tailb7207e.ts.net`;
     the gateway/A2A variables on the master per the f57.12 runbook
     naming (`GATEWAY_URL`, `A2A_PUBLIC_URL`).
  4. Verification (the lane's remaining ACs): a device bootstraps
     end-to-end via the MagicDNS URL (registrant fetch + rotation
     watcher, no more ENOTFOUND); no LAN regression
     (`vectorsigma.lan` still serves).

## Phase 2: the serve-only edge (fleet-ops-lnf — EXECUTED, owner GO 2026-10-04)

Caddy is retired from the composition; the master's tailscale service
IS the TLS front door. What shipped:

- **The master's tailscale service becomes a BUILD**:
  `balena/registrar/Dockerfile.tailscale` (FROM the same pinned
  `v1.102.5`) bakes `serve-config.json`; the compose sets
  `TS_SERVE_CONFIG=/serve-config.json`. ~~The devices fleet's tailscale
  service stays on the stock image~~ — superseded by the j7g.1 serve
  form below (the devices now serve their own agent origin).
- **The serve config** (the containerboot v1.102.5 dialect, verified
  from the pinned tag's own source — `cmd/containerboot/serve.go`):
  `TCP` map keyed by port with `HTTPS:true` (443/8443/8444); `Web`
  map keyed `SNI:port` (no implicit 443), each proxying the loopback
  publishes: `:443` → `127.0.0.1:3000` (registrar), `:8443` →
  `127.0.0.1:4000` (gateway), `:8444` → `127.0.0.1:3306` (scotty).
  The MagicDNS FQDN is baked literally — `${TS_CERT_DOMAIN}` is a
  Kubernetes-operator placeholder (outside kube, containerboot
  substitutes an empty domain).
- **Loopback-only publishes**: registrar/litellm/scotty gain
  `127.0.0.1`-prefixed host publishes (the supervisor dialect this
  lane was gated to exercise). The LAN front door (80/443/8443/8444)
  is dark from this release on; only dolt's `:3326` stays
  LAN-reachable (the bd queue contract).
- **Let's Encrypt certificates** auto-provision + renew inside
  tailscaled once the tailnet has **HTTPS enabled** (admin console →
  DNS → MagicDNS → HTTPS Certificates) — the ONE owner prerequisite.
  Browser-trusted everywhere; `VS_CA_CERT_B64` and the whole
  internal-CA machinery are retired.
- **scotty's lock is the tailnet ACL + TLS identity alone**
  (basic_auth died with caddy — owner-accepted consequence).

Deploy sequencing (the standard flow; provision-then-flip does not
apply — the flipped variables already point at these exact
names/ports):

1. Owner: enable tailnet HTTPS (once).
2. Owner tags `registrar-v*` → master pins the release → canary:
   ts.net names answer 200 from a tailnet client; LAN front door
   dark; loopback probes answer on-device; no restart-loops.
3. Fleet pin → clear canary.
4. Owner tags `devices-v*` (the registrant's retired-CA code) →
   devices canary → fleet pin.
5. Coordinator: delete the retired fleet variables
   (`VS_CA_CERT_B64`, `SCOTTY_BASIC_AUTH_HASH`, `TLS_HOSTNAME`,
   `TS_MASTER_DNS`).

Canary additions (per release, from a TAILNET client — a LAN host
cannot resolve ts.net names):

- [ ] `https://vector-sigma.tailb7207e.ts.net/healthz` → 200,
  browser-trusted cert (no `--cacert`).
- [ ] `https://vector-sigma.tailb7207e.ts.net:8443/health/liveliness`
  → 200.
- [ ] `https://vector-sigma.tailb7207e.ts.net:8444/api/projects` →
  200 (no credentials — the ACL is the lock now).
- [ ] LAN front door dark: `80/443/8443/8444` REFUSED from a LAN host
  at the device IP (the AC3 contrast; dolt `:3326` still answers).
- [ ] On-device loopback probes: `127.0.0.1:3000/healthz`,
  `127.0.0.1:4000` (gateway port), `127.0.0.1:3306/api/projects`
  answer from the device's host shell.

Failure modes:

- Serve config never applied → check the tailscale container logs
  for the HTTPS-disabled refusal line (owner prerequisite), and
  confirm the join (`tailscale status` shows the tailnet IP).
- Everything else inherits the phase-1a failure modes (no
  application role; a dead tailscaled costs tailnet reachability
  only).

## Phase 3: the devices' agent-origin serve edge (fleet-ops-j7g.1 — the AC3 serve form, owner decision 2026-10-08)

The owner picked the TAILSCALE SERVE form for the AC3 live-leg
origin ("can't tailscale handle that?" → "get it done, my friend.
Drive this thing home"): the same serve-only TLS edge pattern the
master's phase-2 release established, extended to the devices fleet
for exactly ONE surface — the agent's A2A origin (:9900), the
address the master gateway's proxy dials to deliver peer traffic.
The live enroll's `origin_url` is the SERVE form
(`https://<device>.tailb7207e.ts.net:9900`), never a tailnet IP +
firewall, never a `:9900` host publish.

What ships (repo-side, `balena/devices/`):

- **`Dockerfile.tailscale` + `serve-config.json`** — the devices
  fleet's tailscale service becomes a BUILD (FROM the same pinned
  `v1.102.5`), baking a serve config that fronts `:9900` at the
  node's own MagicDNS name, proxying the agent's loopback publish.
- **The `${TS_CERT_DOMAIN}` placeholder** (the ONE deliberate
  dialect delta vs the master's literal bake): the devices fleet is
  N devices from one compose, so the `Web` map keys on
  `${TS_CERT_DOMAIN}:9900` and containerboot substitutes each node's
  own FQDN at apply time (`readServeConfig`'s `bytes.ReplaceAll`,
  verified at the pinned tag; the cert domain is the netmap's
  `CertDomains[0]`, the master's live LE certs prove the field is
  populated). Each device serves at
  `https://<device>.tailb7207e.ts.net:9900` with its own Let's
  Encrypt certificate — provisioned automatically under the
  tailnet-wide HTTPS enable already live (the lnf owner
  prerequisite).
- **The agent service publishes `127.0.0.1:9900:9900` loopback
  ONLY** (the master's lnf publish pattern) — the LAN front door
  stays dark; the serve edge is the only path to the origin.

Access is the tailnet ACL story: the caller of a device origin is
the MASTER gateway (the mesh proxy), so the policy needs a
`tag:vs-master → tag:vs-agent:*` accept — the REVERSE of the
phase-1a rule the runbook shipped (which covers agent→master). An
ACL gap presents exactly as a dark data plane: disco pongs answer
while TCP to the device's tailnet IP times out and the device's
`ts-input` counter never moves — probe the counter, not the ping
(`tailscale ping` is control-plane evidence only, per the phase-1a
canary lesson).

Deploy sequencing: tag `devices-v*` → canary (optimus-prime) pins →
verify (below) → fleet pin → clear. The tailscale container
recreates on the image change; the serve config applies on the
first netmap update after boot.

Canary additions (on top of the standing per-device set):

- [ ] On-device loopback: `127.0.0.1:9900` answers from the device
  host shell (the publish landed).
- [ ] Served origin from a TAILNET vantage:
  `https://<device>.tailb7207e.ts.net:9900/health` → 200, strict
  TLS (no `-k`; issuer = Let's Encrypt), SNI pinned with
  `--resolve` where the vantage's resolver cannot reach MagicDNS.
- [ ] Serve config read back OUT of the running container
  (`tailscale serve status`) — the container proves the bake landed,
  not the git tree.
- [ ] LAN front door dark: `:9900` at the device's LAN IP REFUSED.

Failure modes:

- Serve config never applied → the HTTPS-disabled refusal line
  (phase-2 prerequisite — already live; the master's certs are the
  proof) or a placeholder substitution failure (the `Web` key
  substituted EMPTY means the node's netmap carried no cert domain
  — re-check the tailnet's MagicDNS/HTTPS posture before touching
  the config).
- An origin probe timing out while `tailscale ping` pongs → the ACL
  gap above; fix the policy, not the device.

## The mesh-enroll proxy-dial pin (fleet-ops-lfk)

The A2A proxy (the master's litellm container) follows a registered
agent's origin card and dials the ADVERTISED url to deliver peer
traffic — the master's own MagicDNS name and each enrolled device's
serve name. Its container DNS chain has no ts.net route (the lrb
canary verdict class — accept-dns cannot reach the host dnsmasq
chain from tailscaled's mount namespace), so EVERY enrolled device
needs a static pin line on the litellm service in
`balena/registrar/docker-compose.yml`:

```
extra_hosts:
  - "vector-sigma.tailb7207e.ts.net:100.124.197.78"   # the master edge host
  - "<device>.tailb7207e.ts.net:<device tailnet IP>"   # one line per enrolled device
```

`extra_hosts` has no `${VAR}` substitution under the supervisor
compose, so ONE LINE PER ENROLLED DEVICE IS THE MECHANISM: each new
enroll = one compose line (the device's tailnet IP; `tailscale
status` on the device host names it) + a master redeploy. This is
the N-devices scaling cost, documented at the compose site and in
the README's enroll section; the pin test
(`registrar/test/magicdns-flip.test.ts`) fails CI when an enrolled
device has no pin line.

Two standing invariants this lane settled (live-proven
2026-10-08):

- `public_url` is the PROXY-DIAL address — the enrollee's OWN serve
  form (`https://<device>...:9900`) for a device, `http://hermes:9900`
  for primus — NEVER the mesh edge: the proxy follows the advertised
  url, so an edge form loops `proxy→edge→proxy` and dies at the
  proxy's DNS wall mid-loop. The registrar refuses loop forms
  server-side (`loop_url`); the CLI derives the serve form by
  default.
- Routing and DNS are separate failures: TCP from litellm to the
  device's tailnet IP was OPEN the whole time the dial died —
  diagnose name resolution FIRST (the extra_hosts read-back inside
  the container: `getent hosts <device>...ts.net`) before touching
  ACLs or firewalls.

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