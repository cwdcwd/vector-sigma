# balena/devices — devices-fleet app

The balena multi-container app for the **devices fleet**: agent runtime
+ registrant sharing the persistent `agent-data` volume. Built by
balena remote builders when a `devices-v*` tag is pushed
(`deploy-devices.yml`). Deployed fleet: `g_c_d/vector-sigma`.

```
balena/devices/
├── docker-compose.yml        # agent + registrant + tailscale serve edge, shared volume, healthchecks
├── Dockerfile.agent-hermes   # the agent runtime (j7g.1): official Hermes image + bd 1.2.2 + gate + A2A hook
├── Dockerfile.tailscale      # the devices' serve edge (j7g.1 serve form): pinned tailscale + baked serve config
├── serve-config.json         # fronts :9900 at ${TS_CERT_DOMAIN} (each node's own MagicDNS name)
├── agent/
│   ├── Dockerfile            # the RETIRED placeholder image (kept for history; not built since j7g.1)
│   ├── gate.sh               # blocks on /data/agent/ready.marker, then execs the image's own entrypoint dispatcher
│   ├── vs-a2a-wiring.sh      # cont-init 04-: bundle → A2A_* env + config.yaml a2a section (j7g.1)
│   ├── vs-github-identity.py # GitHub App token wrapper (e5o.5; vendored from scripts/)
│   ├── vs-github-identity.sh # cont-init 05-: bundle → GIT_CONFIG_* env (e5o.5)
│   ├── gateway-memory/       # the memory plugin (e5o.3; vendored from deploy/gateway-memory/)
│   └── vs-memory-tools.sh    # cont-init 06-: installs the plugin + seeds plugins.enabled (e5o.3)
├── docs/                     # vendored device-environment.md + queue-conventions.md (byte-pinned to docs/; NEVER the master's vs-environment.md — e5o.1)
├── registrant/               # VENDORED workspace sources (see below)
│   ├── Dockerfile            # multi-stage: build → runtime (non-root)
│   ├── package.json          # exact-pinned deps, workspaces: shared
│   ├── tsconfig.json
│   ├── shared/               # vendored @vector-sigma/shared (types + zod)
│   └── src/                  # vendored registrant sources
└── README.md
```

## Why the sources are vendored

balena build contexts are **confined to the app source dir** —
`build.context` must point inside the app (`docs.balena.io/reference/
supervisor/docker-compose`), and this dir is what the deploy workflow
uploads to the remote builders. The registrant + shared sources
therefore cannot reference `../../registrant` the way `deploy/`'s
compose does.

Instead, the sources live here **byte-for-byte identical** to the
workspace originals, pinned by `registrant/test/vendored-drift.test.ts`
in the root test suite (CI fails on drift). To change the registrant:
edit the workspace copy, then regenerate:

```bash
cp registrant/src/*.ts balena/devices/registrant/src/
cp registrant/tsconfig.json balena/devices/registrant/tsconfig.json
cp shared/src/index.ts balena/devices/registrant/shared/src/
cp shared/tsconfig.json balena/devices/registrant/shared/tsconfig.json
```

## Why no package-lock.json

Every dependency retained in the vendored manifest is zero-transitive —
`zod`, `@types/node`, `typescript` resolve to no dependencies of their
own (verified against the root lockfile), and `@vector-sigma/shared`
is vendored adjacent as a `file:` workspace. A lockfile would be
dead weight duplicating what the exact version pins already guarantee;
`npm install` here is deterministic without one. The drift test pins
the versions match the root lockfile.

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
(`Dockerfile.tailscale` + `serve-config.json`) and fronts that
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

Both Hermes images bake the `gateway-memory` plugin (vendored at
`agent/gateway-memory/`, byte-pinned to `deploy/gateway-memory/` by the
drift test) and the `06-vs-memory-tools` boot hook that installs it into
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
— vendored into this app's `docs/` set.
