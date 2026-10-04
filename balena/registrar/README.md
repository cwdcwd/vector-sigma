# balena/registrar — registrar-fleet app

Registrar + Postgres + the VS fleet's own LiteLLM gateway (f57.12), on
balenaOS. The app runs on the `registrar` balena fleet (1 device: Raspberry
Pi 5, aarch64) — the vector-sigma master device. Per the owner ruling
(2026-09-20, "option 1"): the VS fleet runs identity AND gateway AND mesh
on its own hardware; it never couples to the origin fleet's ai.lan (clean-start
principle). The gateway serves the models front door, virtual keys, and the
/a2a/* agent mesh — devices point `GATEWAY_URL` and `A2A_PUBLIC_URL` at
    UIs at the MagicDNS names (lnf, phase 2: the serve-only edge — see below).

The balena multi-container app for the **registrar fleet**: the Vector
Sigma registrar API + admin console, backed by its own Postgres, on one
dedicated balenaOS device (Raspberry Pi 5). Built by balena remote
builders when a `registrar-v*` tag is pushed (`deploy-registrar.yml`).
Deployed fleet: `g_c_d/vector-sigma-master`.

```
balena/registrar/
├── docker-compose.yml        # registrar + postgres + gateway + queue + primus + tailscale (the serve edge)
├── README.md
└── registrar/                 # VENDORED workspace sources (context dir)
    ├── Dockerfile            # multi-stage: build → runtime (non-root)
    ├── package.json          # exact-pinned deps, workspaces: shared
    ├── tsconfig.json
    ├── drizzle/              # migrations (MIGRATE_ON_START=true)
    ├── shared/               # vendored @vector-sigma/shared
    └── src/                  # vendored registrar sources
```

## Why the sources are vendored

Same constraint as [balena/devices/](../devices/README.md): balena
build contexts are confined to the app source dir, so the registrar +
shared sources live here byte-for-byte identical to the workspace
originals, pinned by `registrant/test/vendored-drift.test.ts` in the
root test suite. Regenerate on upstream change:

```bash
cp -f registrar/package.json balena/registrar/registrar/package.json  # then re-pin versions to the lockfile
cp -f registrar/tsconfig.json balena/registrar/registrar/tsconfig.json
cp -f shared/tsconfig.json balena/registrar/registrar/shared/tsconfig.json
cp -f shared/src/index.ts balena/registrar/registrar/shared/src/index.ts
cp -f registrar/src/*.ts balena/registrar/registrar/src/        # flat src/
cp -f registrar/src/db/*.ts balena/registrar/registrar/src/db/
cp -f registrar/drizzle/*.sql balena/registrar/registrar/drizzle/
cp -f registrar/drizzle/meta/* balena/registrar/registrar/drizzle/meta/
```

Note: the vendored `package.json` is NOT byte-identical to the
workspace one (the workspace manifest carries vitest/pg-mem/drizzle-kit
dev tooling the image does not need, and `workspaces` is scoped to the
vendored `shared/`); the drift test pins its dependency versions to
the root lockfile instead.

## Runtime configuration

Owner-set surface is **two secrets** (owner ruling, 2026-09-19:
"There should actually be very little set from the outside by
myself"). Everything structural ships in the compose file as static
environment entries; balenaCloud **dashboard variables override** the
compose `environment:` values for the same variable name (the balena
supervisor applies dashboard values on top of the per-release compose
env).

### Owner-set (balenaCloud dashboard variables)

| Variable | Service | Required | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | **fleet-wide** | **yes — no default** | Postgres role password. Fleet-scoped: both the postgres service (role creation) and the registrar service (URL part) must see the same value. **No secrets in compose or image layers.** |
| `SESSION_SECRET` | registrar | **yes — no default** | Admin-console HMAC session secret (≥16 chars). **The registrar refuses to boot without it** — missing or short fails startup with the variable name; there is no fallback secret. Set it on the fleet before the first `registrar-v*` release ships. |
| `LITELLM_MASTER_KEY` | **fleet-wide** | **yes — no default** (f57.12) | LiteLLM gateway master key — mints virtual keys, unlocks the Admin UI (`https://vector-sigma.tailb7207e.ts.net:8443/ui` — the serve edge). **Must start with `sk-`** (LiteLLM requirement). 600-equivalent custody: it IS the gateway; never in image layers, compose, chat, or the database. Fleet scope per the bead's variable contract (service scope would be a hardening option — see "Gateway variable scoping" below). |
| `LITELLM_PG_PASSWORD` | **fleet-wide** | **yes — no default** (f57.12) | Password for the gateway's dedicated least-privilege postgres role. The `postgres` service's wrapper image provisions the `litellm` role + `litellm` database on every boot and re-asserts this value (ALTER ROLE) — rotating it needs no manual psql step, just a release re-deploy or service restart. |
| `OLLAMA_CLOUD_API_KEY` | **fleet-wide** | **yes — no default** (f57.12) | Ollama Cloud credential — the gateway's model upstream (OpenAI-compatible `https://ollama.com/v1`). Held only by the gateway container; devices never see it. |
| `DOLT_PASSWORD` | dolt + scotty | **yes — no default** (f57.15) | Dolt auth for the VS queue's app user `vs` (database `vs_ops`). The dolt image creates the user at first boot of the `doltdata` volume; VS device bd clients join with the SAME value. 600-equivalent custody. |
| `DOLT_ROOT_PASSWORD` | dolt | **yes — no default** (f57.15) | Dolt superuser password (the image requires it to bootstrap; root stays localhost-only by image default — never a LAN login). |
| `BEADS_DOLT_PASSWORD` | scotty + hermes | **yes — no default** (f57.15; hermes added b1r) | SAME secret value as `DOLT_PASSWORD`, under the env key bd reads (bd and the dolt image read different keys). Lets the scotty container's in-image bd join the queue read-only; since b1r it also reaches the hermes container's in-image bd — primus's queue CURATION client (full read-write). Fleet-scoped: it cascades to every service by default; no static value in the compose (f57.8). |
| `PRIMUS_REGISTRAR_KEY` | registrant-own | **yes — no default** (f57.14) | The registrar key for the master device's own row (agent_name=primus). Mint/insert per the device-key flow; never reuse another row's key. Set as the `REGISTRAR_KEY` device variable (the name the vendored registrant reads — `PRIMUS_REGISTRAR_KEY` is the balenaCloud device-variable name used at the f57.14 rollout; the registrant's config layer maps it). |
| ~~`TLS_HOSTNAME`~~ | — | RETIRED (lnf, phase 2) | The caddy edge is gone; the serve edge fronts the MagicDNS names with Let's Encrypt certs. Delete the fleet variable (docs/tls-runbook.md). |
| `TS_AUTHKEY` | **service** (`tailscale`) | **yes — no default** (j7g 6c2) | Per-device tailscale auth key (owner-minted, pre-tagged `tag:vs-master`, reusable). **Service-scoped to the tailscale service only** — keeps the secret out of sibling containers. Custody: 600-equivalent, never in image layers or compose. See [docs/tailscale-runbook.md](../../docs/tailscale-runbook.md). |
| `TS_HOSTNAME` | device | **yes — no default** (j7g 6c2) | The master device's MagicDNS machine name on the VS tailnet (e.g. `vector-sigma`; already set via the balena API 2026-10-01). Device-scoped so the value composes cleanly across future fleet members. |
| ~~`SCOTTY_BASIC_AUTH_HASH`~~ | — | RETIRED (lnf, phase 2) | basic_auth died with caddy — scotty's lock is the tailnet ACL tag + TLS identity alone (owner GO). Delete the fleet variable. |
| ~~`TS_MASTER_DNS`~~ | — | RETIRED (lnf, phase 2) | The serve config bakes the MagicDNS FQDN literally (serve-config.json); the extra_hosts pins carry the same literal. Delete the fleet variable. |
### Static in compose (override only if you know why)

| Variable | Service | Value | Purpose |
|---|---|---|---|
| `POSTGRES_USER` | postgres + registrar | `vsigma` | Postgres role name created at first init of the data volume. |
| `POSTGRES_DB` | postgres + registrar | `vsigma` | Database name. |
| `DB_HOST` | registrar | `postgres` | Host the registrar connects to — the compose service name, deterministic within the composition (f57.8: the db URL is based on the docker host name of the container). |
| `DB_PORT` | registrar | (default 5432) | Postgres port; override via dashboard variable if non-standard. |
| `MIGRATE_ON_START` | registrar | `true` | `true` = migrations run on boot. Absent/false = migrations are **skipped** with a WARN log — the API still boots, but against whatever schema the volume last had. |

### Optional registrar overrides (dashboard variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(unset — built from parts)* | Whole-URL override; wins over the parts entirely. Set only to point the registrar at an external Postgres. |
| `PORT` | 3000 | Registrar listen port. |
| `LOG_LEVEL` | `info` | Fastify log level. |
| `TRUST_PROXY` | `false` | `true` only if a reverse proxy sits in front (not in this LAN-only topology). |

When `DATABASE_URL` is unset, the registrar builds it from
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `DB_HOST` /
`DB_PORT`; any missing part fails startup naming the variable(s) and
the fix path (balena fleet/service variable). The compose file pins
the structural parts, so the owner only ever supplies the password
secret.

The registrar's admin console + API ride the same container port (3000).
Since lnf (j7g phase 2) the composition's published surface is the
**tailscale serve edge**: `https://vector-sigma.tailb7207e.ts.net/`
(port 443) for the admin console + API,
`https://vector-sigma.tailb7207e.ts.net:8443/` for the VS gateway, and
`https://vector-sigma.tailb7207e.ts.net:8444/` for the scotty queue UI
(the tailnet ACL is the lock — basic_auth retired with caddy). Every
service publishes on 127.0.0.1 loopback ONLY; the LAN front door
(80/443/8443/8444) is dark from this release on. Only dolt's `:3326`
stays LAN-reachable (the bd queue contract). See docs/tls-runbook.md
(rewritten for the serve-only edge) and docs/tailscale-runbook.md.


> **lnf (phase 2) — the caddy retirement is SHIPPED.** The serve edge
> fronts the MagicDNS names; the f57.13 deploy-sequencing note above
> (CA extract → variable staging → flip) is historical — the flipped
> fleet variables already point at the MagicDNS names this release
> serves, and Let's Encrypt needs no CA staging. The owner checklist
> now: (1) enable tailnet HTTPS (admin console — once); (2) tag
> `registrar-v*`; (3) canary from a tailnet client; (4) advance the
> fleet; (5) tag `devices-v*`; (6) delete the retired fleet variables
> (`VS_CA_CERT_B64`, `SCOTTY_BASIC_AUTH_HASH`, `TLS_HOSTNAME`,
> `TS_MASTER_DNS`). Full sequence: docs/tailscale-runbook.md § phase 2.

## First admin key

The admin console (`/admin/login`) authenticates against rows in the
`admin_keys` table. **Mint the first key from the browser (fleet-ops-w5d):
browse to `http://<device-LAN-IP>/admin/setup`** — the route exists ONLY
while `admin_keys` is empty, so a fresh database has exactly one
bootstrap window. Enter a label (e.g. `bootstrap`), submit, and the
plaintext `ak_…` key is displayed **once** on the confirmation page. The
mint creates a session, so you land logged-in; the route 404s from that
moment on (there is no second bootstrap).

**Key management (console, session-gated):** the console's
[Admin keys](http://<device-LAN-IP>/admin/admin-keys) page lists every
key row. Mint additional keys there (label + show-once semantics,
identical custody), and revoke old rows with the per-row Revoke button.
**Rotation** = mint the new key → log in with it → revoke the old row —
no shell access anywhere in the flow.

The CLI mint tool remains for break-glass use (container terminal):
`node dist/admin-key.js <label>` prints the plaintext key, its argon2id
hash, and a ready-to-paste `INSERT INTO admin_keys ...` statement for a
psql session (`psql -U vsigma -d vsigma`). The normal path is the
console — the manual INSERT is no longer required (owner pain point
2026-09-29: "manual db inserts are dumb").

**Never store the plaintext** anywhere — not in balena variables, env
files, chat, or the database (only the argon2id hash is stored). If a
plaintext key leaks, rotate immediately and delete the leaked row.

## Password resets & the pgdata trap

Postgres consumes `POSTGRES_PASSWORD` **exactly once**, at the first
initdb of the `pgdata` volume. After that, the role's password lives in
the database — changing the balena variable does nothing until the
database is told. If the registrar reports `28P01 password
authentication failed for user "vsigma"`:

- **Before the registrar holds real data (bootstrap window):** device
  page → ⋯ actions → **Purge data**. This wipes `pgdata` and re-runs
  initdb with the *current* dashboard values — password mismatch gone.
- **After the registrar holds real identity bundles:** NEVER purge.
  Rotate inside the running postgres instead — `ALTER ROLE vsigma
  PASSWORD '<new>';` (via the balena device terminal on the postgres
  service), then update the `POSTGRES_PASSWORD` balena variable to
  match and restart the registrar service. Purging here destroys
  every device's identity bundles.
- Also check for a **service-scoped `POSTGRES_PASSWORD`** shadowing the
  fleet-wide one (a service-scoped variable silently beats the fleet
  value for that service — one more way auth can disagree).

## Failure domain & recovery

This device is the **identity source and the entire reflash-recovery
path**: a devices-fleet device without identity cannot recover until
this registrar returns (accepted residual — the registrar fleet exists
precisely to give it its own failure domain). Its Postgres data lives on
the balena named volume `pgdata` — survives container updates and host
OS updates. balenaOS host recovery does NOT preserve `pgdata` in every
disaster scenario: the registrar runbook covers a Postgres dump
cadence as an owner step.

The f57.12 gateway widens this failure domain by owner-accepted design
(SPOF accepted: master Pi carries identity + gateway + mesh — mirrors the
existing devpi05 posture): if the gateway is down, devices keep their
identities and cached bundles but cannot mint/renew keys, call models, or
mesh A2A until it returns. Gateway state (virtual keys, spend logs, A2A
registry) lives in the `litellm` database **inside the same `pgdata`
volume** — it shares the registrar's dump cadence and its recovery story.
Virtual keys can be re-minted from the master key at any time; the master
key itself is the crown jewel (see "Key minting & the re-mint runbook").

## The VS gateway (LiteLLM) — f57.12

The `litellm` service is the VS fleet's own AI gateway, baked from
`Dockerfile.litellm` (pinned `ghcr.io/berriai/litellm:1.100.1` + the
in-repo `litellm-config.yaml` — the balena supervisor cannot bind-mount,
so the config ships in the image; deploy/ self-host builds the same image,
so there is exactly one config artifact, no twin drift). Model routes per
the config: explicit `ollama-cloud/glm-5.3` + `ollama-cloud/glm-5.2`
groups with glm↔glm cross-fallbacks, a `*` pass-through wildcard to
Ollama Cloud (routes, never a fallback target — j9f lesson verbatim), and
a commented future `gw-sonnet` anthropic lane. The gateway is compose-
internal since f57.13 — no host publish; the Admin UI is served through
the serve edge at `https://vector-sigma.tailb7207e.ts.net:8443/ui`.

### First-boot sequence

Release lands → the `postgres` container boots its wrapper entrypoint
(fleet-ops-anc): the stock postgres entrypoint starts as its child, the
wrapper waits for readiness, then idempotently provisions
`CREATE ROLE litellm LOGIN` + `CREATE DATABASE litellm OWNER litellm`,
re-asserts the role password (ALTER ROLE every boot — kills the pgdata
password trap for this role), and revokes `PUBLIC` CONNECT on the
registrar's database (least privilege: the gateway role can reach ONLY
its own database). Provisioning runs on EVERY boot — fresh volume and
live volume alike. → `litellm` boots, its entrypoint shim assembles
`DATABASE_URL` from the same parts (URL and role can never disagree — the
f57.8 trap closed by construction), prisma migrates the fresh `litellm`
database (tens of seconds), then serves. If the gateway container
crash-loops in that window, `restart: always` closes the gap — logs name
the missing variable if a fleet var is absent (fail-loud).

The old one-shot `litellm-init` service no longer exists (owner ruling
2026-09-29: consolidate — one less container on a resource-strapped
device; the wrapper runs the identical SQL bytes the one-shot ran). The
graceful-shutdown contract is a hard gate: the wrapper translates the
container's stop signal into a postmaster FAST shutdown (its own SIGTERM
becomes SIGINT for the postgres child — postmaster SIGTERM is SMART
shutdown, which waits for clients that hold lifetime pool connections
and never completes inside the grace) so postgres checkpoints and
flushes WAL inside the 60s `stop_grace_period` — the balena
supervisor's stop never SIGKILLs an unwarned postgres at the deadline
(that is the corruption path this design closes).

**Live-volume note:** the master device's pgdata already holds device
bundles — a fresh initdb cannot run there and MUST NOT; the wrapper
operates on the live volume (idempotent SQL, no data touched outside the
new role/database), which is precisely why the provisioning lives in
the postgres service's own wrapper rather than initdb.d magic.

### Gateway variable scoping (hardening option)

The bead's variable contract puts the gateway secrets at fleet scope
(POSTGRES_PASSWORD precedent: shared by two services — init needs the
superuser credential, litellm needs the role password). Trade-off: fleet
scope means the registrar and postgres containers also carry
`LITELLM_MASTER_KEY` in their environment. If that ever bothers you,
re-scope `LITELLM_MASTER_KEY` and `OLLAMA_CLOUD_API_KEY` to the
`litellm` service only (dashboard: service scope) — no compose change
needed; the service reads them the same way.

### A2A mesh through the gateway

The gateway serves `/a2a/*` pass-through natively (same pattern ai.lan
serves the origin fleet): each VS device's Hermes points `A2A_PUBLIC_URL` at
`https://vector-sigma.tailb7207e.ts.net:8443`, and its agent card is served by the VS
gateway — peer traffic rides the master device, never ai.lan. The
structured bundle editor's A2A fields (`a2a_identity_key`,
`a2a_trusted_peers`, and since j7g.1 `a2a_public_url` +
`a2a_peer_tokens`) document this in their hints; the DEVICE-SIDE wiring
lands with j7g.1:

- **Bundle contract**: `config/a2a.json` carries `identity_key` (the
  agent's own mesh key), `trusted_peers` (the resolved identities that
  may run tasks), `public_url` (the PROXY-DIALABLE origin of this agent
  — the gateway's proxy follows it to deliver peer traffic; the edge
  there would loop, so it is compose-internal for primus and the
  device's LAN/tailnet address for a device), and `peer_tokens`
  (name→key: the OTHER mesh agents' keys this agent accepts inbound).
- **Runtime derivation** (the 04-vs-a2a-wiring boot hook, baked into
  BOTH Hermes images — primus's and the devices' agent): the hook
  re-derives `A2A_PEER_TOKENS`, `A2A_TRUSTED_PEERS`,
  `A2A_PUBLIC_URL`, `A2A_OWN_IDENTITY_KEY`, `A2A_HOST/PORT` and the
  config.yaml `a2a_agents` section from the bundle on EVERY boot — a
  mesh rotation the console delivers lands on the next container
  recreate with zero hands. No identity in the bundle ⇒ the inbound
  server stays OFF (bind-safety).
- **Gateway registration**: each agent's row on the VS gateway
  (`POST /v1/agents`, master-key auth) carries
  `agent_card_params.url` = the agent's A2A origin and
  `extra_headers: ["Authorization"]` — the proxy forwards the CALLER's
  credential upstream, so the mesh needs no stored secret on the row:
  a caller presenting peer X's key is X at the target.

No `PROXY_BASE_URL` is set: with no
reverse proxy in front, LiteLLM derives card URLs from the request Host
header — correct on a plain-HTTP LAN; set it as a dashboard variable
only if a proxy ever fronts the gateway.

### Key minting & the re-mint runbook

The gateway's virtual keys (device keys like `vs-optimus-prime`, A2A
keys) are minted with the master key against THIS gateway — the
ai.lan-minted `vs-optimus-prime` alias is obsolete by design (owner
ruling: re-mint on the new gateway post-deploy; delete the ai.lan alias
once the new one exists).

1. Set the three fleet vars (`LITELLM_MASTER_KEY`,
   `LITELLM_PG_PASSWORD`, `OLLAMA_CLOUD_API_KEY`) on the balenaCloud
   dashboard BEFORE tagging the first release carrying f57.12 — the
   gateway fail-louds without them.
2. Tag the release (owner action, e.g. `registrar-v1.1.0`); wait for the
   device to pull it and the gateway to come up (`/health/liveliness`
   at `https://vector-sigma.tailb7207e.ts.net:8443/health/liveliness` → 200 — from a tailnet client).
3. Mint `vs-optimus-prime` (gateway key) and `vs-optimus-prime-a2a`
   (A2A identity key) against the new gateway — LiteLLM Admin UI
   (`/ui`, login with the master key) or `POST /key/generate` with
   `Authorization: Bearer <LITELLM_MASTER_KEY>`. Record nothing
   plaintext beyond the owner's password-manager entry.
4. Delete the obsolete ai.lan `vs-optimus-prime` alias (owner action,
   ai.lan side).
5. Point the device bundle at the new gateway: registrar bundle
   `config/agent.env` gains `GATEWAY_URL=https://vector-sigma.tailb7207e.ts.net:8443`
   and `config/a2a.json` documents `A2A_PUBLIC_URL` per the editor hints
   (the `a2a_public_url` structured field, j7g.1). The device-side
   wiring — the 04-vs-a2a-wiring boot hook (bundle → runtime env +
   config.yaml) — ships in BOTH Hermes images since j7g.1; the mesh
   round-trip is the e2e's AC14.
6. **j7g.1 mesh rows**: for each mesh agent, register its card row —
   `POST /v1/agents` with the master key,
   `agent_card_params.url` = the agent's A2A origin (`http://<agent-host>:9900`
   compose-internal for primus; the device LAN/tailnet address for a
   device), and `extra_headers: ["Authorization"]` so the proxy forwards
   each caller's own credential (per-caller identity — the ai.lan
   shape; no secret stored on the row).

### Gateway health

Healthcheck parity with the registrar service (`kill -0 1` process
liveness — the stock litellm image ships no curl); real HTTP liveliness
is asserted externally: the deploy E2E smoke (AC9) polls
`/health/liveliness` for 200 and asserts the explicit model groups in
`/v1/models`. On-device spot check: `curl -s
https://vector-sigma.tailb7207e.ts.net:8443/health/liveliness` from any tailnet client (or
the balenaCloud public URL path if the owner enables it).

The daily health pass, fallback verification, and the live-vs-file
discipline live in [docs/gateway-ops.md](../../docs/gateway-ops.md)
(fleet-ops-e5o.6): process liveness alone is a heartbeat, not health —
the pass asserts a real completion through a working key on top.

## The VS queue (dolt + scotty) — f57.15

The master composition also carries the VS fleet's own work queue:
the `dolt` service (Dolt SQL server, database `vs_ops`, LAN :3326)
and the `scotty` dashboard (Bead Me Up Scotty v0.3.0 `cc55734` + the
fleet's 8ea deep-link patch + bd pinned at 1.2.2 + the `bd-readonly`
wrapper, LAN :3306). VS devices run bd clients against the dolt
server; the dashboard serves the queue READ-ONLY (two layers:
`SCOTTY_READ_ONLY=1` server-side + the `bd-readonly` BD_BIN wrapper
allowlisting `export --json` / `show <id> --json` / `--version` only).

One-time bring-up, device joins, and the `bd init --server` landmine
(a second init rewrites the shared project_id and locks every other
client out — the 2026-09-09 fleet lockout) are documented in
[scripts/vs-queue-bootstrap.md](../../scripts/vs-queue-bootstrap.md);
queue conventions (epic-per-project, claim discipline, the
cross-fleet A2A-only rule) in
[docs/queue-conventions.md](../../docs/queue-conventions.md).

### Queue health

The dolt healthcheck runs Dolt's documented liveness query
(`dolt sql -q "select current_timestamp();"`); the scotty healthcheck
polls `/api/projects` for HTTP 200. The deploy E2E (AC10) additionally
round-trips a real bd client against the compose dolt: init → create
→ list → close on a throwaway volume.

## primus — the VS coordinator Hermes (f57.14)

The master device runs its own agent: **primus**, the Vector Sigma fleet
coordinator. This is the dogfood proof at the heart of the architecture —
the coordinator bootstraps through the SAME chain every device uses:

```
registrar (started) → registrant-own (fetch + apply bundle) → hermes (started)
```

- **`registrant-own`** — a vendored twin of the devices app's registrant
  (byte-pinned by `registrant/test/vendored-drift.test.ts`). It polls the
  compose-internal registrar (`http://registrar:3000` — pre-TLS by the
  bead's contract; the https flip rides the same sequencing as the
  devices fleet) and applies the primus bundle to the shared
  `primus-data` volume, writing `ready.marker` last. Ordering safety is
  in the poll loop, not a compose condition (f57.20): the balena
  supervisor rejects long-form `depends_on` conditions outright (only
  `service_started` is supported), so both depends_on entries here are
  short-form service lists; the registrant's bounded 425 retry +
  permanent-error grace poll + `restart: always` make it safe to start
  at any point in the registrar's lifecycle.
- **`hermes`** — primus's custom image (b1r): the pinned official
  `nousresearch/hermes-agent` image (the SAME `v2026.9.21` tag this
  service pulled before) built from `Dockerfile.hermes` with bd 1.2.2
  baked FULL READ-WRITE (primus is the queue CURATOR — the scotty
  `bd-readonly` wrapper posture does NOT apply here), the config-only
  queue join (canonical project_id), the environment docs at
  `/opt/vs/docs`, and the `03-vs-queue-join` boot hook that seeds
  `$HERMES_HOME/vs-queue` on first boot. Owner ruling 2026-09-29:
  fully rebuildable from the repo + a fresh release, zero manual
  steps. `HERMES_HOME=/data/primus` on the same volume. The image has
  NO marker gate (f57.20 finding: zero `ready.marker` references
  anywhere in the image's v2026.9.21 source — the marker gate belongs
  to the devices app's own `gate.sh`, not this image). `HERMES_GATEWAY_BOOTSTRAP_STATE=running` starts the
  supervised gateway on first boot (the image's first-boot-only seed
  contract); the persisted state wins on every later boot, and the
  bundle's operator-provided files are never clobbered — so an early
  hermes start (before registrant-own has applied the bundle) costs at
  most one restart-loop cycle on an unprovisioned device, never a
  broken provisioned one. The ready marker is the fleet's assertion
  signal (E2E AC12), not an image-side gate.

### Hermes config contract (AC4)

The bundle IS the config delivery:

| Bundle file | Hermes consumer |
|---|---|
| `config/agent.env` | `AGENT_NAME=primus`, `MODEL_ROUTE`, `GATEWAY_API_KEY`, + `GATEWAY_URL` pointing at the composition's litellm (`http://litellm:4000` compose-internal today; the fleet variable carries `https://vector-sigma.tailb7207e.ts.net:8443` (the serve edge — lnf, phase 2)) |
| `config/secrets.env` | `SLACK_BOT_TOKEN` etc. (owner-side custody, per the origin-fleet pattern) |
| `SOUL.md` | The VS coordinator SOUL: queue curator (docs/queue-conventions.md), cross-fleet contact A2A-only, credential/install/self-config mutations owner-gated (the ADR-0001 clause mirror) |
| `config/a2a.json` | `identity_key` + `trusted_peers` + `public_url` + `peer_tokens` (the mesh — j7g.1) |
| `config/github-app.pem` | GitHub App credential (owner-side custody) |

The image's stage2 hook seeds `config.yaml` / `.env` / `SOUL.md` only
when absent — operator-provided values win, so the bundle's files are
never clobbered by a container update.

### Owner steps (before the f57.14 release)

1. **Pre-create the row** in the admin console: device UUID = the
   master's own `BALENA_DEVICE_UUID` (device page → UUID),
   `agent_name=primus`, status active, `PRIMUS_REGISTRAR_KEY` minted and
   inserted as its key hash.
2. **Fill the bundle** via the structured editor: gateway key
   (`vs-primus`, minted on the new gateway per the f57.12 runbook),
   `MODEL_ROUTE`, the SOUL contents (the coordinator clauses above),
   A2A identity key (`vs-primus-a2a`, sentinel-gated), Slack + GitHub
   App credentials (owner-side custody).
3. **Set the device variables**: `BALENA_DEVICE_UUID` +
   `PRIMUS_REGISTRAR_KEY` on the registrar fleet (device scope for the
   key — f57.8 pattern).
4. Tag the release; the chain self-bootstraps. The deploy E2E (AC12)
   proves the chain end-to-end in CI: the REAL official image + the REAL
   vendored registrant + the seeded full bundle.

### primus health

Process liveness (`kill -0 1`) — the identity gate is structural: an
unprovisioned primus shows `hermes` **Exited** in the dashboard (the
entrypoint's marker gate), not "Running" with nothing inside. The
ready-marker + bundle artifacts + stage2 boot are asserted by the
deploy E2E (AC12) in CI on every push.

## First flash

Per [balena-architecture.md](../../docs/balena-architecture.md): flash
the spare Pi 5 with the registrar-fleet image, pin the fleet at
provisioning, push the first `registrar-v*` tag (owner action), then
provision devices per the devices runbook.