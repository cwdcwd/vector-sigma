# balena/registrar — registrar-fleet app

Registrar + Postgres + the VS fleet's own LiteLLM gateway (f57.12), on
balenaOS. The app runs on the `registrar` balena fleet (1 device: Raspberry
Pi 5, aarch64) — the vector-sigma master device. Per the owner ruling
(2026-09-20, "option 1"): the VS fleet runs identity AND gateway AND mesh
on its own hardware; it never couples to the Cabal's ai.lan (clean-start
principle). The gateway serves the models front door, virtual keys, and the
/a2a/* agent mesh — devices point `GATEWAY_URL` and `A2A_PUBLIC_URL` at
`https://<TLS_HOSTNAME>:8443`.

The balena multi-container app for the **registrar fleet**: the Vector
Sigma registrar API + admin console, backed by its own Postgres, on one
dedicated balenaOS device (Raspberry Pi 5). Built by balena remote
builders when a `registrar-v*` tag is pushed (`deploy-registrar.yml`).
Deployed fleet: `g_c_d/vector-sigma-master`.

```
balena/registrar/
├── docker-compose.yml        # registrar + postgres
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

Owner-set surface is **two secrets** (lazybaer ruling, 2026-09-19:
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
| `LITELLM_MASTER_KEY` | **fleet-wide** | **yes — no default** (f57.12) | LiteLLM gateway master key — mints virtual keys, unlocks the Admin UI (`https://<TLS_HOSTNAME>:8443/ui`). **Must start with `sk-`** (LiteLLM requirement). 600-equivalent custody: it IS the gateway; never in image layers, compose, chat, or the database. Fleet scope per the bead's variable contract (service scope would be a hardening option — see "Gateway variable scoping" below). |
| `LITELLM_PG_PASSWORD` | **fleet-wide** | **yes — no default** (f57.12) | Password for the gateway's dedicated least-privilege postgres role. The `litellm-init` service provisions the `litellm` role + `litellm` database on every boot and re-asserts this value (ALTER ROLE) — rotating it needs no manual psql step, just a release re-deploy or service restart. |
| `OLLAMA_CLOUD_API_KEY` | **fleet-wide** | **yes — no default** (f57.12) | Ollama Cloud credential — the gateway's model upstream (OpenAI-compatible `https://ollama.com/v1`). Held only by the gateway container; devices never see it. |
| `DOLT_PASSWORD` | dolt + scotty | **yes — no default** (f57.15) | Dolt auth for the VS queue's app user `vs` (database `vs_ops`). The dolt image creates the user at first boot of the `doltdata` volume; VS device bd clients join with the SAME value. 600-equivalent custody. |
| `DOLT_ROOT_PASSWORD` | dolt | **yes — no default** (f57.15) | Dolt superuser password (the image requires it to bootstrap; root stays localhost-only by image default — never a LAN login). |
| `BEADS_DOLT_PASSWORD` | scotty | **yes — no default** (f57.15) | SAME secret value as `DOLT_PASSWORD`, under the env key bd reads (bd and the dolt image read different keys). Lets the scotty container's in-image bd join the queue read-only. |
| `PRIMUS_REGISTRAR_KEY` | registrant-own | **yes — no default** (f57.14) | The registrar key for the master device's own row (agent_name=primus). Mint/insert per the device-key flow; never reuse another row's key. |
| `TLS_HOSTNAME` | **fleet-wide** | **yes — no default** (f57.13) | The master device hostname the caddy edge serves (must match the Pi-hole DNS record — see [docs/tls-runbook.md](../../docs/tls-runbook.md)). Feeds the Caddyfile's `{$TLS_HOSTNAME:vsigma.lan}` substitution. |
| `TLS_CERT_B64` | **fleet-wide** | **yes — no default** (f57.13) | Base64 (single line, `-w0`) of the leaf cert PEM from `scripts/gen-vs-ca.sh` output. The one-shot `certs-init` service decodes it into the caddy-certs volume; rotation = re-run the script, re-paste, restart `certs-init` + `caddy`. |
| `TLS_KEY_B64` | **fleet-wide** | **yes — no default** (f57.13) | Base64 of the leaf KEY PEM — same paste source (`vs-tls/b64-cert.env`), same rotation path. The CA key itself is NEVER a variable (owner-custodied). |
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
Since f57.13 the composition's published surface is the **caddy TLS
edge**: `https://<TLS_HOSTNAME>/` (port 443) for the admin console + API,
`https://<TLS_HOSTNAME>:8443/` for the VS gateway, and port 80 is a 308
redirect to https — the registrar and litellm containers no longer publish
host ports directly. The balenaCloud public URL tunnels device port 80
and therefore lands on the redirect: plain-HTTP console access through
the tunnel is dead by design (use https from a trusted host; see
[docs/tls-runbook.md](../../docs/tls-runbook.md)).

> **Deploy sequencing (read before tagging a release):** the release that
> carries fleet-ops-f57.9 stopped publishing `:3000` and published `:80`;
> f57.13 supersedes it — the composition's published surface is now caddy
> (80 redirect / 443 registrar / 8443 gateway). **Order (Copilot review):
> provision device trust FIRST** — set `VS_CA_CERT_B64` on the devices
> fleet BEFORE the release lands (a device pulling the f57.13 registrant
> with its OLD http `REGISTRAR_URL` boots unchanged, with the CA already
> staged; there is no window where a device has an https URL but no CA).
> From the moment the f57.13 release lands on the registrar device, the
> devices fleet's `REGISTRAR_URL` dashboard variable must become
> `https://<TLS_HOSTNAME>`. Tag → confirm the registrar device pulled the
> release and caddy serves
> (`curl https://<TLS_HOSTNAME>/healthz --cacert <vs-ca.crt>`) → flip
> `REGISTRAR_URL` → verify a device bootstraps. Full owner checklist:
> [docs/tls-runbook.md](../../docs/tls-runbook.md).

## First admin key

The admin console (`/admin/login`) authenticates against rows in the
`admin_keys` table. There is no default key and no way to mint one from
the console itself — a fresh database has no admin access until you
insert the first key. Mint + insert flow (balenaCloud device terminal):

1. **Mint** — open a terminal on the **registrar** service (device page
   → the *registrar* service → ⋯ → *Select terminal*) and run:

   ```bash
   node dist/admin-key.js <label>
   ```

   Example label: `bootstrap` or `owner-<date>`. The tool prints the
   plaintext admin key (shown **once**), its argon2id hash, and a ready
   to paste `INSERT INTO admin_keys ...` statement.

2. **Insert** — open a terminal on the **postgres** service (same
   device page, *postgres* service) and paste the printed INSERT:

   ```bash
   psql -U vsigma -d vsigma
   ```

   …then paste the INSERT line and `\q` to exit. (No password prompt on
   the local socket inside the container.)

3. **Login** — browse to `http://<device-LAN-IP>/admin/login` (or the
   balenaCloud public URL) and paste the `ak_…` plaintext key. The
   console session lasts 12h.

**Rotation:** mint a new key + insert its row (steps 1–2), log in with
it, then delete the old row from a postgres terminal:
`DELETE FROM admin_keys WHERE label = '<old-label>';`. Keys are
referenced by id in the audit trail, not by the hash — deleting a row
never rewrites history.

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
the TLS edge at `https://<TLS_HOSTNAME>:8443/ui`.

### First-boot sequence

Release lands → `litellm-init` (one-shot, `restart: "no"` — a supported
supervisor restart policy) waits for postgres, then idempotently
provisions `CREATE ROLE litellm LOGIN` + `CREATE DATABASE litellm OWNER
litellm`, re-asserts the role password (ALTER ROLE every boot — kills the
pgdata password trap for this role), and revokes `PUBLIC` CONNECT on the
registrar's database (least privilege: the gateway role can reach ONLY
its own database). → `litellm` boots, its entrypoint shim assembles
`DATABASE_URL` from the same parts (URL and role can never disagree — the
f57.8 trap closed by construction), prisma migrates the fresh `litellm`
database (tens of seconds), then serves. If the gateway container
crash-loops in that window, `restart: always` closes the gap — logs name
the missing variable if a fleet var is absent (fail-loud).

**Live-volume note:** the master device's pgdata already holds device
bundles — a fresh initdb cannot run there and MUST NOT; `litellm-init`
operates on the live volume (idempotent SQL, no data touched outside the
new role/database), which is precisely why the init service exists rather
than initdb.d magic.

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
serves the Cabal): each VS device's Hermes points `A2A_PUBLIC_URL` at
`https://<TLS_HOSTNAME>:8443`, and its agent card is served by the VS
gateway — peer traffic rides the master device, never ai.lan. The
structured bundle editor's A2A fields (`a2a_identity_key`,
`a2a_trusted_peers`) document this in their hints; full mesh wiring
(peer token staging, card registration) is the follow-up bead's lane,
provisioned once the gateway serves. No `PROXY_BASE_URL` is set: with no
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
   at `https://<TLS_HOSTNAME>:8443/health/liveliness` → 200).
3. Mint `vs-optimus-prime` (gateway key) and `vs-optimus-prime-a2a`
   (A2A identity key) against the new gateway — LiteLLM Admin UI
   (`/ui`, login with the master key) or `POST /key/generate` with
   `Authorization: Bearer <LITELLM_MASTER_KEY>`. Record nothing
   plaintext beyond the owner's password-manager entry.
4. Delete the obsolete ai.lan `vs-optimus-prime` alias (owner action,
   ai.lan side).
5. Point the device bundle at the new gateway: registrar bundle
   `config/agent.env` gains `GATEWAY_URL=https://<TLS_HOSTNAME>:8443`
   and `config/a2a.json` documents `A2A_PUBLIC_URL` per the editor hints;
   full device-side wiring rides the follow-up bead.

### Gateway health

Healthcheck parity with the registrar service (`kill -0 1` process
liveness — the stock litellm image ships no curl); real HTTP liveliness
is asserted externally: the deploy E2E smoke (AC9) polls
`/health/liveliness` for 200 and asserts the explicit model groups in
`/v1/models`. On-device spot check: `curl -s
https://<TLS_HOSTNAME>:8443/health/liveliness` from any LAN host (or
the balenaCloud public URL path if the owner enables it).

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
registrar (healthy) → registrant-own (fetch + apply bundle) → hermes (ready-marker gate)
```

- **`registrant-own`** — a vendored twin of the devices app's registrant
  (byte-pinned by `registrant/test/vendored-drift.test.ts`). It polls the
  compose-internal registrar (`http://registrar:3000` — pre-TLS by the
  bead's contract; the https flip rides the same sequencing as the
  devices fleet) and applies the primus bundle to the shared
  `primus-data` volume, writing `ready.marker` last.
- **`hermes`** — the official `nousresearch/hermes-agent` image
  (version-tagged, arm64-published), `HERMES_HOME=/data/primus` on the
  same volume. The image's entrypoint gates on the ready marker: no
  identity, no gateway. `HERMES_GATEWAY_BOOTSTRAP_STATE=running` starts
  the supervised gateway on first boot (the image's first-boot-only seed
  contract); the persisted state wins on every later boot.

### Hermes config contract (AC4)

The bundle IS the config delivery:

| Bundle file | Hermes consumer |
|---|---|
| `config/agent.env` | `AGENT_NAME=primus`, `MODEL_ROUTE`, `GATEWAY_API_KEY`, + `GATEWAY_URL` pointing at the composition's litellm (`http://litellm:4000` compose-internal today; `https://<TLS_HOSTNAME>:8443` after the TLS flip — same sequencing as the devices fleet) |
| `config/secrets.env` | `SLACK_BOT_TOKEN` etc. (owner-side custody, per the Cabal pattern) |
| `SOUL.md` | The VS coordinator SOUL: queue curator (docs/queue-conventions.md), cross-fleet contact A2A-only, credential/install/self-config mutations owner-gated (the ADR-0001 clause mirror) |
| `config/a2a.json` | `identity_key` + `trusted_peers` (the mesh; peer token staging rides the follow-up bead) |
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