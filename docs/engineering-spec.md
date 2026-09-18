# Vector Sigma — engineering spec

Device identity registrar for autonomous agent fleets. A fleet device
boots empty, calls the registrar with its bootstrap key, and receives the
complete identity bundle that makes it itself. Delivery is exactly once
per slot; identity persists on the device's data partition; rotation
happens without reflash.

Companion projects: this spec is generic — it names no agents, hosts, or
specific deployments. Fleet-specific wiring lives outside this repo.

## Components

| Component | Stack | Role |
|---|---|---|
| Registrar | TypeScript · Fastify · Node.js LTS · Postgres 16 | REST API: stores identity bundles, delivers once, audit log; admin console |
| Registrant | TypeScript · Node.js LTS | Device-side caller: bootstrap, bundle write, config assembly, rotation watcher |
| Device app | docker-compose multi-container | Agent runtime + registrant on balenaOS, shared persistent volume |
| Shared | TypeScript types | Bundle-contract schema, one source of truth for both ends |

## Registrar

### Data model (Postgres — dedicated database, least-privilege role)

```sql
CREATE TABLE devices (
  balena_uuid        UUID PRIMARY KEY,     -- the device UUID injected by the platform
  agent_name         TEXT NOT NULL UNIQUE,
  registrar_key_hash TEXT NOT NULL,        -- argon2id hash, never plaintext
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','revoked')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes              TEXT
);

CREATE TABLE identity_blobs (
  device_id   UUID PRIMARY KEY REFERENCES devices(balena_uuid),
  bundle      JSONB NOT NULL,             -- full identity bundle
  version     INTEGER NOT NULL DEFAULT 1, -- bumped on rotation
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_slots (
  device_id        UUID PRIMARY KEY REFERENCES devices(balena_uuid),
  state            TEXT NOT NULL DEFAULT 'armed'
                   CHECK (state IN ('armed','consumed')),
  delivered_at     TIMESTAMPTZ,
  auto_rearm_after INTERVAL NOT NULL DEFAULT '1 hour',
  delivery_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE delivery_log (              -- append-only audit
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES devices(balena_uuid),
  outcome     TEXT NOT NULL,             -- 'delivered' | 'denied' | 'admin'
  reason      TEXT,
  key_id      TEXT,
  source_ip   INET,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_keys (
  id    BIGSERIAL PRIMARY KEY,
  hash  TEXT NOT NULL,                   -- argon2id
  label TEXT NOT NULL
);
```

### REST API (versioned `/v1`, JSON, Bearer per-device registrar key)

| Method | Path | Purpose | Status |
|---|---|---|---|
| `POST` | `/v1/bootstrap` | Identity fetch (device) | 200 / 401 / 403 / 425 / 429 |
| `GET` | `/v1/status` | Device self-check: slot state, bundle version | 200 / 401 |
| `POST` | `/v1/re-arm` | Immediate re-arm (owner) | 200 / 401 / 404 |
| `POST` | `/v1/rotate` | Replace bundle, bump version, re-arm (owner) | 200 / 401 / 404 |
| `GET` | `/healthz` | Liveness, no auth | 200 |

- **`POST /v1/bootstrap`** — request body `{ "balena_uuid": "…" }` +
  Bearer key. Flow: argon2id hash-compare → device row must exist and be
  `active` → slot must be `armed` (else `425 Too Early` + `Retry-After`)
  → deliver bundle → slot `consumed`, counters bump → audit row → 200
  with bundle. Auto re-arm: slot returns to `armed` after
  `delivered_at + auto_rearm_after`.
- **Two-factor:** the Bearer key AND the body UUID must both match the
  device row. A stolen key yields at most its own device's bundle; a
  spoofed UUID alone yields nothing.
- **Owner actions** (`/v1/re-arm`, `/v1/rotate`) authenticate with an
  owner admin key (argon2id hash in `admin_keys`).
- Keys stored hashed only — a database leak cannot impersonate devices.
- Every request audited; denials include reason; secrets never logged.
- Rate limiting: per-IP on auth endpoints; lockout after repeated
  failures.

### Admin console (lightweight, same Fastify process)

- Server-rendered HTML, zero-framework (no React/Vue build chain), one
  small vanilla-JS island for the bundle-editor diff preview.
- Session: HMAC-signed cookie (`HttpOnly; Secure; SameSite=Strict`),
  12h TTL, in-memory sessions. Rate-limited login with lockout.
- CSRF token on every mutation; role separation at the auth middleware
  (device keys structurally rejected on all admin routes).
- Pages: devices dashboard, device detail, bundle editor, new device,
  re-arm, revoke/activate, per-device key regeneration (shows once),
  read-only audit log.
- Secret fields write-only: masked on display, never rendered into HTML;
  blank means keep existing.
- Bundle save = version bump + slot armed + audit row — same code path
  as `POST /v1/rotate`, so console and API cannot drift.
- Console edits what gets delivered; it never mints upstream
  credentials (LLM keys, chat tokens, VCS keys) — those stay with the
  operator at their sources.

## Registrant (device side)

Runs as its own container in the device's compose app, sharing the
agent's persistent data volume (balenaOS: `/data/<agent>/`).

1. **Clock gate** — wait for NTP convergence before any TLS call
   (devices have no RTC; skewed clocks fail TLS and token auth).
2. **Identity check** — if the data volume already holds a delivered
   bundle, write the ready marker immediately and skip the fetch
   (provisioned devices never re-fetch at boot).
3. **Bootstrap call** — `POST REGISTRAR_URL + /v1/bootstrap` with the
   device UUID (from platform env) + Bearer bootstrap key (from platform
   env). Refused bundles (partial, malformed) are never partially
   applied.
4. **Bundle write** — 0600 on the data volume.
5. **Config assembly** — render `.env`/config files from repo templates
   + delivered secrets.
6. **Ready marker** — the agent container's entrypoint blocks on this
   marker before starting the agent process. No identity = no agent.
7. **Rotation watcher** — stays resident; on owner-triggered rotation
   (`balena restart` or supervisor restart), re-fetches the fresh bundle
   and rewrites config.

Platform env consumed: device UUID (auto-injected), `REGISTRAR_URL`,
`REGISTRAR_KEY`, plus non-secret config variables.

## Device app (balenaOS multi-container)

```yaml
services:
  agent:
    image: <agent-runtime-image>
    volumes:
      - agent-data:/data/agent
    # entrypoint blocks on ready marker
  registrant:
    build: ./registrant
    environment:
      - REGISTRAR_URL
      - REGISTRAR_KEY
    volumes:
      - agent-data:/data/agent
volumes:
  agent-data:
```

- Both containers share the persistent volume; the agent is its data
  partition and survives container OTA and host OS updates.
- Builds via platform remote builders only — never device-side.
- Graceful shutdown: `stop_grace_period` generous; the agent runtime
  must trap SIGTERM, finish in-flight work, flush its write-ahead logs,
  and exit clean. Evidence standard: zero-byte or absent `-wal` files
  after a supervised stop, checked on every state database.
- Restart contract: platform supervisor auto-restart on exit replaces
  systemd `Restart=always`; a container health check replaces
  exit-code-75 self-restart (catches alive-but-broken). Verified on the
  canary device by kill-test before fleet rollout.
- Updates: fleet pinned to a release; advance one canary device first,
  verify, then move the fleet pin.

## Security model (summary)

- Bootstrap key per device, stored argon2id-hashed; the only secret in
  platform variables.
- One-shot delivery with bounded auto re-arm; replay window is small
  and audited.
- Secrets delivered once, live on the device's encrypted-at-rest data
  partition, never in image layers or build args.
- The registrar never mints upstream credentials; admin actions are
  owner-key authenticated and fully audited.
- Residual (accepted): both bootstrap factors are visible to the
  platform account holder; mitigation is per-device blast-radius capping.

## Off-LAN deployments

TAGGED FOR LATER REVIEW — not designed yet. `REGISTRAR_URL` is
per-device, so pointing devices at a public endpoint is a
configuration change; the open questions (public ingress, public TLS,
admin exposure, full-fleet reachability for third-party devices) are
deliberately undecided.

## Build order

1. Repo scaffolding: `shared/` bundle-contract types, `registrar/`
   Fastify skeleton with DB schema + migrations, `registrant/` caller.
2. Registrar: bootstrap + status endpoints, slot logic, audit; console
   login + dashboard + bundle editor.
3. Self-host deploy example; end-to-end test with a compose-simulated
   device.
4. Balena device app; canary device; kill-test and SIGTERM/WAL
   evidence; then fleet.