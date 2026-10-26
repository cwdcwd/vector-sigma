# platforms/balena/devices — devices-fleet app

The balena multi-container app for the **devices fleet**: agent runtime
+ registrant sharing the persistent `agent-data` volume. Images built on
GHA runners from a `devices-v*` tag push (`release-devices.yml`): GHCR
prebuilts, trivy + smoke gates, digest-pinned compose, `balena deploy`.
Deployed fleet: `g_c_d/vector-sigma`.

```
platforms/balena/devices/
├── docker-compose.yml        # agent + registrant + tailscale serve edge, shared volume, healthchecks
└── README.md
```

The images come from `images/agent/` (`nousresearch/hermes-agent:v0.22.5@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d` — the current stable release, shared with the master's primus image; update both pins together — plus bd 1.2.2 +
`gate.sh` + `hermes-agent-defaults.yaml` + hooks), `registrant/Dockerfile`
and `images/tailscale-devices/` (pinned tailscale + a baked serve config
fronting :9900 at `${TS_CERT_DOMAIN}`).

## Where the images come from

Nothing here is vendored. The three device images are `images.json`
components (`agent`, `registrant`, `tailscale-devices`) that CI builds ONCE
(`.github/workflows/_images.yml`) from the canonical sources and promotes to
GHCR after the content gate and the compose E2E pass on those exact bytes:

- `agent` — `images/agent/Dockerfile`, built from the repo root: it COPYs
  the boot hooks from `images/common/hooks/` (`vs-a2a-wiring.sh` 04-,
  `vs-memory-tools.sh` 06-, `vs-github-identity.sh` 05-), the
  `images/common/gateway-memory/` plugin, the identity CLI from
  `images/common/bin/`, and the WORKER doc set from
  `docs/` (`device-environment.md` — NEVER the master's `vs-environment.md`,
  e5o.1, CI-fatal in `registrar/test/image-build-config.test.ts`).
- `registrant` — `registrant/Dockerfile` at the repo root (installed from
  the root `package-lock.json`); the master's `registrant-own` runs the
  same image.
- `tailscale-devices` — `images/tailscale-devices/Dockerfile` here.

A `devices-v*` tag runs that pipeline, then
`scripts/render-release-compose.mjs` swaps every `build:` block in
`docker-compose.yml` for the promoted arm64 child digest and `balena
deploy` ships the rendered compose — the balena builder never sees source.

`balena push` (or `balena deploy --build`) against `docker-compose.yml` is
**not a supported path**: the `build:` contexts point at the repo root
(`../..`), which the balena CLI refuses — it confines build contexts to the
project dir. Ship by pushing a `devices-v*` tag.

## Runtime configuration

No `${VAR}` substitution — balena compose performs **no variable
substitution**, and every runtime value arrives as a balenaCloud
dashboard variable (`REGISTRAR_URL`, `REGISTRAR_KEY` per device;
`BALENA_DEVICE_UUID` auto-injected). The full table:
[balena-devices-runbook.md](../docs/balena-devices-runbook.md). The
`tailscale` service is the one structural exception: it carries the
static `TS_STATE_DIR` / `TS_USERSPACE` / `TS_BOOT_TIMEOUT` /
`TS_SERVE_CONFIG` env entries (structural, not secrets); its auth
key and MagicDNS name arrive the same dashboard-variable way
(`TS_AUTHKEY` service-scoped to tailscale, `TS_HOSTNAME`
device-scoped — see the tailscale runbook).

**The served agent origin (j7g.1 — the AC3 serve form).** The
`agent` service publishes `127.0.0.1:9900:9900` LOOPBACK ONLY; the
`tailscale` service BUILDS the serve edge
(`images/tailscale-devices/Dockerfile` + `serve-config.json`) and fronts that
origin at each device's own MagicDNS name,
`https://<device>.tailb7207e.ts.net:9900` — the URL the live
enroll's `origin_url` carries (the master gateway's proxy dials it
to deliver peer traffic). The serve config keys on the
`${TS_CERT_DOMAIN}` placeholder: containerboot substitutes the
node's own FQDN at apply time, so N devices serve from one compose.
The LAN front door stays dark — no unprefixed publish exists. See
the tailscale runbook's phase-3 section for the canary checks and
the ACL note (the master→device direction needs its own accept
rule).

## Layout constraints honored

- compose-file **v2.4** semantics (balena's base): no v3 fields used;
  `depends_on` is not used at all (the supervisor orders container
  starts itself, and the agent's gate makes ordering explicit anyway).
- **Named volume only** (`agent-data`; `ts-state` on the tailscale
  service) — no bind mounts.
- Healthchecks are **process liveness** (`kill -0 1`): they catch
  alive-but-broken containers and exec-arch mismatches, but never gate
  on the ready marker (an unprovisioned device legitimately has none).
- Images ship `/data/agent` pre-created owned by uid/gid 1000 so a
  fresh named volume seeds node-user ownership (the registrant runs
  non-root and must write the 0600 bundle + marker).
- Update strategy: balena default (`download-then-kill`), generous
  `stop_grace_period` (60s agent / 30s registrant) for SIGTERM/WAL
  evidence standard.

## Agent memory (e5o.3)

Both Hermes images bake the `gateway-memory` plugin (COPYd from
`images/common/gateway-memory/`) and the `06-vs-memory-tools` boot hook that installs it into
`$HERMES_HOME/plugins/` and seeds `plugins.enabled` — the PluginManager
allow-list gate; a copied-but-unlisted plugin registers nothing.

The plugin's tools (`memory_get` / `memory_set` / `memory_list`) need two
route-restricted gateway keys, delivered via the bundle's
`config/agent.env` extra_env — minted per device by the registrar
console's **Mint memory keys** action (see the registrar README) or by
hand on the gateway (the pre-authorized fallback):

```
GATEWAY_MEMORY_SHARED_KEY=sk-…   # team-scoped, route-locked to /v1/memory
GATEWAY_MEMORY_PRIVATE_KEY=sk-…  # no team scope — private entries
FLEET_MEMORY_BASE_URL=https://<gateway-host>/v1
```

Operating discipline (list before write, key naming, what never belongs
in the store): [docs/memory-conventions.md](../../docs/memory-conventions.md)
— baked into the image's `/opt/vs/docs` set.
