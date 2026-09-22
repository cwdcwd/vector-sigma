# Self-host deploy example — registrar + Postgres + the VS gateway (f57.12)

This directory is the reference self-host deployment for the Vector Sigma
registrar **and the VS fleet's own LiteLLM gateway**, plus a
compose-simulated device E2E (fleet-ops-f57.5, extended by f57.12):

```
deploy/
├── Dockerfile          # one image: registrar | seed | device entrypoints
├── compose.yaml        # self-host: postgres + litellm + registrar (the example)
├── compose.e2e.yaml    # E2E overlay: + seed + simulated device
├── .env.example        # self-host variables (copy to .env, fill secrets)
├── .env.e2e            # deterministic E2E values (committed; no secrets)
├── e2e.sh              # AC-by-AC assertion driver
├── seed/seed.ts        # idempotent E2E seeder (device + bundle + short slot)
└── README.md
```

The `litellm` and `litellm-init` services build from
`./balena/registrar/Dockerfile.litellm{,-init}` — the SAME images the
balena app ships. One config artifact (`balena/registrar/litellm-config.yaml`,
baked into the image), one env contract: only the secret delivery differs
(`.env` here, balenaCloud dashboard variables on the device).

## Self-host quickstart

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env        # set POSTGRES_PASSWORD, SESSION_SECRET, LITELLM_* (required)
# TLS material (f57.13): generate with the VS CA script and paste the two
# single-line values into deploy/.env (TLS_HOSTNAME / TLS_CERT_B64 / TLS_KEY_B64):
scripts/gen-vs-ca.sh vsigma.lan           # -> ./vs-tls/b64-cert.env
docker compose -f deploy/compose.yaml up -d --build
curl https://vsigma.lan/healthz --cacert vs-tls/vs-ca.crt          # → {"status":"ok"}
curl https://vsigma.lan:8443/health/liveliness --cacert vs-tls/vs-ca.crt # → 200 (the VS gateway)
```

Notes:

- **Fail-closed config**: every required variable is `${VAR:?}`-interpolated;
  `docker compose ... config` aborts if `deploy/.env` is missing a value.
- **Migrations**: the registrar runs drizzle migrations on start
  (`MIGRATE_ON_START=true`); no manual migration step.
- **Exposure (f57.13)**: the caddy edge is the composition's front door —
  443 (registrar admin + API), 8443 (VS gateway), 80 (redirect). The
  registrar + gateway containers no longer publish host ports at all;
  the TLS edge replaces the "loopback + your own proxy" posture with the
  same Caddyfile + cert contract the balena device ships (one artifact,
  no twin drift). Resolve the hostname to the host (an /etc/hosts line or
  your LAN DNS) and trust the CA per [docs/tls-runbook.md](../docs/tls-runbook.md).
- **Least privilege**: the Postgres container is dedicated to this stack
  (its own role + database). Do not point `DATABASE_URL` at a shared
  superuser-owned instance in production. The gateway follows the same
  discipline: `litellm-init` provisions a dedicated `litellm` role that owns
  ONLY the `litellm` database (and revokes `PUBLIC` CONNECT on the
  registrar's database); the gateway's `DATABASE_URL` is assembled from the
  same parts by the image's entrypoint shim — URL and role cannot disagree.
- **VS gateway (f57.12 + f57.13)**: `LITELLM_MASTER_KEY` (must start `sk-`),
  `LITELLM_PG_PASSWORD`, and `OLLAMA_CLOUD_API_KEY` are required in
  `deploy/.env`. The gateway rides the caddy edge at
  `https://${TLS_HOSTNAME}:8443` (same TLS contract as the registrar —
  one CA, one edge; no separate publish). Model routes: explicit
  `ollama-cloud/glm-5.3` + `glm-5.2` groups
  with glm↔glm cross-fallbacks and a `*` pass-through wildcard to Ollama
  Cloud (never a fallback target — j9f). See `balena/registrar/README.md`
  for the full gateway runbook (key minting, A2A mesh, failure domain).
- **VS queue plane (f57.15)**: `DOLT_PASSWORD`, `DOLT_ROOT_PASSWORD`, and
  `BEADS_DOLT_PASSWORD` (same value as `DOLT_PASSWORD`) are required in
  `deploy/.env`. The `dolt` service (Dolt SQL server, `vs_ops` database)
  publishes :3326 for device bd clients (the queue contract — drop the
  publish only if you accept a queue nobody can join); `scotty` (the
  patched pinned dashboard) publishes :3306 and serves the queue
  READ-ONLY (two layers: `SCOTTY_READ_ONLY=1` + the `bd-readonly` BD_BIN
  wrapper). One-time `bd init --server` + device joins: see
  `scripts/vs-queue-bootstrap.md`; conventions: `docs/queue-conventions.md`.
- **primus, the coordinator (f57.14)**: `PRIMUS_DEVICE_UUID` (the
  master's UUID) and `PRIMUS_REGISTRAR_KEY` (its row's registrar key) are
  required in `deploy/.env`. The `registrant-own` service bootstraps the
  primus bundle from the registrar and gates the `hermes` service
  (official `nousresearch/hermes-agent` image, `HERMES_HOME=/data/primus`)
  on the ready marker — the same chain every device uses, on the master.
  The E2E (AC12) proves it in CI against the REAL image.

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
7. **Console structured save (f57.11)**: the real admin console drives a
   structured-fields save (login → CSRF → form); the re-delivered bundle
   carries the rendered canonicals — merged `config/agent.env`,
   `config/secrets.env` line-merge, verbatim `SOUL.md`, `config/a2a.json`
   object render, verbatim `config/github-app.pem`.
8. **Registrant grace (f57.11)**: a pending (403) device stays resident
   (no crash loop, `ACTION REQUIRED` line in logs); after the console fix
   (activate + bundle) the resident `/v1/status` poll self-heals —
   `ready.marker` appears without a container restart.
9. **VS gateway smoke (f57.12)**: the compose stack brings up the REAL
   LiteLLM gateway (same images as the balena app); `/health/liveliness`
   returns 200 and `/v1/models` (master-key auth) serves the explicit
   `glm-5.3`/`glm-5.2` groups — j9f's fallback-capable groups, verified
   against the live gateway, no upstream completion traffic.
10. **VS queue plane smoke (f57.15)**: the compose stack brings up the REAL
    dolt server + the patched scotty image; the dolt liveness query answers,
    `scotty` serves `/api/projects` 200, and a real bd 1.2.2 client
    round-trips init → create → list → close against the compose dolt
    (throwaway volume — the CI init IS the one-time act by construction).
11. **TLS edge (f57.13)**: port 80 → 308, untrusted clients rejected,
    healthz over TLS with the E2E CA, served cert SAN/issuer match the
    gen-vs-ca.sh material, and the device bootstrapped through the edge.
12. **primus self-bootstrap (f57.14)**: the REAL official Hermes image +
    the REAL vendored registrant bootstrap the coordinator's identity
    through the same chain every device uses — ready marker, every
    structured canonical on the volume (merged agent.env, secrets.env,
    verbatim SOUL.md, a2a.json, github-app.pem), and the hermes
    container's stage2 boot artifacts prove the gated gateway launched.

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
are built by the root npm workspaces install. The container runs as the
base image's built-in non-root `node` user (uid/gid 1000) — the device data
volume must be writable by that uid (compose named volumes are).