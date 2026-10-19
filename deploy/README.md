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

The `litellm` service builds from `./balena/registrar/Dockerfile.litellm`
and the `postgres` service from `./balena/registrar/Dockerfile.postgres`
(the stock image + provisioning wrapper, fleet-ops-anc) — the SAME images
the balena app ships. One config artifact
(`balena/registrar/litellm-config.yaml`, baked into the image), one env
contract: only the secret delivery differs (`.env` here, balenaCloud
dashboard variables on the device).

## Self-host quickstart

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env        # set VS_IMAGE_TAG, POSTGRES_PASSWORD, SESSION_SECRET, LITELLM_* (required)
docker compose -f deploy/compose.yaml up -d
# TLS (lnf, j7g phase 2): the caddy edge is RETIRED. Services publish
# 127.0.0.1-only; front them with your own TLS edge (tailscale serve on
# the balena master). Quickstart probes the loopback registrar:
curl http://127.0.0.1:3000/healthz   # → {"status":"ok"}
```

Notes:

- **Fail-closed config**: every required variable is `${VAR:?}`-interpolated;
  `docker compose ... config` aborts if `deploy/.env` is missing a value.
- **Migrations**: the registrar runs drizzle migrations on start
  (`MIGRATE_ON_START=true`); no manual migration step.
- **Exposure (lnf, phase 2)**: every service publishes on 127.0.0.1
  loopback ONLY (the same surface the tailscale serve edge proxies
  at the MagicDNS names on the balena master). Front the loopback
  publishes with whatever TLS edge you run; see docs/tls-runbook.md.
- **Least privilege**: the Postgres container is dedicated to this stack
  (its own role + database). Do not point `DATABASE_URL` at a shared
  superuser-owned instance in production. The gateway follows the same
  discipline: the postgres service's wrapper image (fleet-ops-anc)
  provisions a dedicated `litellm` role that owns ONLY the `litellm`
  database (and revokes `PUBLIC` CONNECT on the registrar's database);
  the gateway's `DATABASE_URL` is assembled from the same parts by the
  image's entrypoint shim — URL and role cannot disagree.
- **VS gateway (f57.12 + f57.13)**: `LITELLM_MASTER_KEY` (must start `sk-`),
  `LITELLM_PG_PASSWORD`, and `OLLAMA_CLOUD_API_KEY` are required in
  The gateway publishes on 127.0.0.1 loopback (lnf,
  phase 2); front it with your own TLS edge (tailscale serve
  fronts it at the MagicDNS name :8443 on the balena master).
  `ollama-cloud/glm-5.3` + `glm-5.2` groups
  with glm↔glm cross-fallbacks and a `*` pass-through wildcard to Ollama
  Cloud (never a fallback target — j9f). See `balena/registrar/README.md`
  for the full gateway runbook (key minting, A2A mesh, failure domain);
  the day-to-day recipes (key audits, route changes with live
  verification, fallback probing, the DB-row shadow trap, the daily
  health pass) live in [docs/gateway-ops.md](../docs/gateway-ops.md).
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
  (primus's custom image since b1r — the pinned official Hermes image
  plus baked bd 1.2.2 + queue join + docs, `HERMES_HOME=/data/primus`)
  on the ready marker — the same chain every device uses, on the master.
  `BEADS_DOLT_PASSWORD` (f57.15, same value as `DOLT_PASSWORD`) now also
  feeds the hermes service's in-image bd — the fail-closed compose
  entry mirrors scotty's. The E2E (AC12 + AC13) proves it in CI against
  the REAL built image.

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
11. **Loopback front door (lnf, phase 2)**: the registrar answers at
    the 127.0.0.1 loopback publish (healthz 200) - the same surface
    the tailscale serve edge proxies at the MagicDNS name on the
    balena master. The caddy TLS edge and its cert checks are
    retired; the https-on-ts.net path is canary evidence (AC4).
12. **primus self-bootstrap (f57.14)**: the REAL primus Hermes image +
    the REAL registrant image bootstrap the coordinator's identity
    through the same chain every device uses — ready marker, every
    structured canonical on the volume (merged agent.env, secrets.env,
    verbatim SOUL.md, a2a.json, github-app.pem), and the hermes
    container's stage2 boot artifacts prove the gated gateway launched.
13. **Gateway memory plane (e5o.3, AC15)**: a REAL route-restricted
    memory key minted on the compose gateway is REFUSED on `/v1/models`
    (the `allowed_routes` hard allowlist bites for every role) and
    round-trips `PUT`/`GET`/`DELETE` on `/v1/memory` byte-equal — the
    live mint-shape + round-trip probe.
14. **Agent memory tools (e5o.3, AC16)**: the 06- boot hook installed
    the baked `gateway-memory` plugin under `$HERMES_HOME/plugins/` (no
    `__pycache__`), `plugins.enabled` carries it (the PluginManager
    gate), and the plugin's own tool handlers write a memory row in one
    process that a FRESH process (same delivered env — the session
    boundary) reads back byte-equal.
15. **Mesh-enroll capability (j7g.1, AC17)**: the REAL machine-auth
    route end to end — the seeded primus machine key (`mk_` class)
    authenticates `POST /v1/mesh-enroll` (a device key bounces 401),
    the registrar mints the `vs-<agent>-a2a` sentinel at the live
    gateway (mesh-only `allowed_routes`, empty `models` — the
    hardcoded shape verified by read-back), registers the card row,
    merges BOTH sides' bundles (audit rows for target + every peer),
    and the 200 body carries `{alias, action, merged, bundle_version}`
    ONLY — key material never crosses to the caller. A re-run is the
    idempotent OPEN heal (`action=open`, no re-mint).

The device service runs the real registrant image (`registrant/dist/index.js`)
— the same container shape the balenaOS device app uses (f57.6), with
platform env provided by compose instead of the balena supervisor.

## Images

Self-host runs the SAME images the balena fleets run. `images.json` lists
every component; CI (`.github/workflows/_images.yml`) builds each one once
from its Dockerfile, credential-scans its inputs, content-gates the OCI
layout, runs the compose E2E on those exact amd64 bytes, and promotes them
to `ghcr.io/cwdcwd/vector-sigma/<component>`, tagged with the commit SHA.

| Service          | Image (`<component>`) | Dockerfile |
|------------------|-----------------------|------------|
| registrar        | `registrar`           | `registrar/Dockerfile` |
| registrant-own   | `registrant`          | `registrant/Dockerfile` |
| hermes           | `hermes`              | `balena/registrar/Dockerfile.hermes` |
| postgres         | `postgres`            | `balena/registrar/Dockerfile.postgres` |
| litellm          | `litellm`             | `balena/registrar/Dockerfile.litellm` |
| scotty           | `scotty`              | `balena/registrar/Dockerfile.scotty` |

Set `VS_IMAGE_TAG` in `deploy/.env` to the commit SHA you run (there is no
floating tag); `VS_IMAGE_REGISTRY` points at a mirror if you keep one.
Images run as the non-root `node` user (uid/gid 1000) where they carry
their own runtime — volumes must be writable by that uid (compose named
volumes are).

The E2E (`deploy/e2e.sh --up`) builds the same Dockerfiles locally under
`vs-e2e/<component>:ci` tags; in CI, `E2E_PREBUILT=1` runs the scanned
images instead and never builds. `deploy/Dockerfile` is only the E2E seed
harness (test tooling, never published).

## Device Hermes context and tool-output defaults (1py.18)

The device image seeds these values into `$HERMES_HOME/config.yaml` on boot
only when an operator has not already set them. Bundle `extra_env` is the
operator override plane; add the listed `VS_HERMES_*` key to the device's
registrar-delivered `config/agent.env`. These are defaults, not hard pins.

| Key | Default | Why | Override knob |
|---|---:|---|---|
| `compression.threshold_tokens` | `128000` | Absolute cap prevents 1M-context turns from waiting for fraction-based compression. | `VS_HERMES_COMPRESSION_THRESHOLD_TOKENS` |
| `tool_output.max_bytes` | `20000` | Tool results refill context rapidly and can stall compression in the protected tail. Oversized output continues to spill to `cache/spillover/` with a pointer, not silently truncate. | `VS_HERMES_TOOL_OUTPUT_MAX_BYTES` |
| `file_read_max_chars` | `40000` | Bounds file reads before they consume the turn context. | `VS_HERMES_FILE_READ_MAX_CHARS` |
| `tool_budget.mcp_result_size_chars` | `20000` | Bounds MCP payload growth. | `VS_HERMES_MCP_RESULT_SIZE_CHARS` |
| `model.context_length` | `1000000` | Matches the gateway's declared default-model window rather than Hermes' smaller unknown-window fallback. | `VS_HERMES_CONTEXT_LENGTH` |
| `auxiliary.compression.model` | `${VS_HERMES_SUMMARY_MODEL}` (operator supplied) | Pin a fast summary model with a window at least as large as the main model; avoids router summaries that took 48–100 seconds. | `VS_HERMES_SUMMARY_MODEL` |
| `auxiliary.compression.base_url` | `${GATEWAY_URL}` (bundle supplied) | Routes summaries through the configured OpenAI-compatible gateway without embedding a deployment host. | bundle `GATEWAY_URL` |

Hermes' default 0.50 compression fraction on a 1M-token model allows roughly
500K-token turns before compression. Tool results can refill that context much
faster than conversation text, stalling compression. An absolute threshold,
bounded result sizes, and a directly pinned summary model address those cases.
