# balena/registrar — registrar-fleet app

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

The registrar's admin console + API ride the same container port (3000),
published as **host port 80** on the device LAN interfaces (standard HTTP
port, fleet-ops-f57.9): `http://<device-LAN-IP>/` — no port suffix. The
balenaCloud public URL tunnels to device port 80, so the same release
serves the public URL and the LAN front door.

> **Deploy sequencing (read before tagging a release):** the release that
> carries fleet-ops-f57.9 stops publishing `:3000` and starts publishing
> `:80`. From the moment it lands on the registrar device, the devices
> fleet's `REGISTRAR_URL` dashboard variable must drop the `:3000` — a
> device bootstrapping between the release landing and the variable flip
> fails to register. Tag → confirm the registrar device pulled the
> release → flip `REGISTRAR_URL` → verify LAN + public URL.

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

## First flash

Per [balena-architecture.md](../../docs/balena-architecture.md): flash
the spare Pi 5 with the registrar-fleet image, pin the fleet at
provisioning, push the first `registrar-v*` tag (owner action), then
provision devices per the devices runbook.