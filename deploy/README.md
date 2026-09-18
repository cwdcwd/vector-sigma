# Self-host deploy example — registrar + Postgres

This directory is the reference self-host deployment for the Vector Sigma
registrar, plus a compose-simulated device E2E (fleet-ops-f57.5):

```
deploy/
├── Dockerfile          # one image: registrar | seed | device entrypoints
├── compose.yaml        # self-host: postgres + registrar (the example)
├── compose.e2e.yaml    # E2E overlay: + seed + simulated device
├── .env.example        # self-host variables (copy to .env, fill secrets)
├── .env.e2e            # deterministic E2E values (committed; no secrets)
├── e2e.sh              # AC-by-AC assertion driver
├── seed/seed.ts        # idempotent E2E seeder (device + bundle + short slot)
└── README.md
```

## Self-host quickstart

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env        # set POSTGRES_PASSWORD, SESSION_SECRET (required)
docker compose -f deploy/compose.yaml up -d --build
curl http://127.0.0.1:3000/healthz   # → {"status":"ok"}
```

Notes:

- **Fail-closed config**: every required variable is `${VAR:?}`-interpolated;
  `docker compose ... config` aborts if `deploy/.env` is missing a value.
- **Migrations**: the registrar runs drizzle migrations on start
  (`MIGRATE_ON_START=true`); no manual migration step.
- **Exposure**: the registrar publishes on `127.0.0.1` only. Put your
  reverse proxy of choice (Caddy/nginx/Tailscale) in front for LAN/TLS
  exposure; the API and admin console ride the same port.
- **Least privilege**: the Postgres container is dedicated to this stack
  (its own role + database). Do not point `DATABASE_URL` at a shared
  superuser-owned instance in production.

## Postgres on an existing host (optional variant)

The example bundles its own Postgres for turnkey operation. To reuse an
existing Postgres instead, remove the `postgres` service, set
`DATABASE_URL` directly in the registrar environment, and drop the
`depends_on` block. The registrar needs schema-owner rights on its
database and nothing else.

## E2E — compose-simulated device (fleet-ops-f57.5)

Requires docker compose v2. Deterministic: the seeder resets the slot and
audit rows each run, and `.env.e2e` is committed with simulation-only
values.

```bash
# from the repo root:
deploy/e2e.sh --up     # fresh stack + all AC assertions (transcript on stdout)
deploy/e2e.sh --down   # teardown (removes volumes)
```

What the E2E proves, in order (the bead's acceptance criteria):

1. **Cold boot**: a device with an empty data volume bootstraps and
   receives its bundle (ready marker + `delivered` audit row).
2. **Replay refusal**: a second bootstrap with the same key gets
   `425 Too Early` with a `Retry-After` header and body field.
3. **Auto re-arm**: the device volume is wiped and the registrant restarted
   *inside* the re-arm window — the real client hits 425, honors
   `Retry-After`, and re-delivers once the window elapses
   (`delivery_count=2`).
4. **Status**: `GET /v1/status` reports `bundle_version=1` and the slot
   counters.
5. **Audit completeness**: delivered + slot-consumed denials all present,
   every row carrying `key_id`, `source_ip`, `occurred_at`.
6. **Volume state**: bundle files on the data volume are mode `0600` with
   the expected contents; `ready.marker` present (the agent entrypoint's
   gate).

The device service runs the real registrant image (`registrant/dist/index.js`)
— the same container shape the balenaOS device app uses (f57.6), with
platform env provided by compose instead of the balena supervisor.

## Image

One image (`deploy/Dockerfile`), three entrypoints:

| Service   | Command                                    |
|-----------|--------------------------------------------|
| registrar | `node registrar/dist/index.js`             |
| seed      | `node --import tsx deploy/seed/seed.ts`     |
| device    | `node registrant/dist/index.js`             |

Build context is the repo root (see `.dockerignore`); all three workspaces
are built by the root npm workspaces install. The container runs as
non-root `vsigma` (uid 1000) — the device data volume must be writable by
that uid (compose named volumes are).