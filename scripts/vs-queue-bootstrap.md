# VS Queue Bootstrap (fleet-ops-f57.15)

One-time bring-up of the Vector Sigma fleet's own work queue: the Dolt server
container on the master device + `bd` server-mode clients + the Scotty
dashboard. Owner ruling: **the VS queue is fully self-contained** — VS devices
run bd clients against the master's Dolt; cross-fleet coordination
(primus ↔ ultronbot) is A2A agent-to-agent, NEVER through each other's queues.

## The composition

```
dolt     dolthub/dolt-sql-server:2.3.5, port 3326 (LAN), volume doltdata
scotty   scotty v0.3.0 cc55734 + 8ea patch + bd 1.2.2 + bd-readonly wrapper,
         port 3306 (LAN), SCOTTY_READ_ONLY=1, BEADS_REPO=/queue-join
```

Both balena (`balena/registrar/docker-compose.yml`) and self-host
(`deploy/compose.yaml`) run byte-identical shapes.

## ⚠️ THE LANDMINE: `bd init --server` is a ONE-TIME, ONE-CLIENT act

`bd init --server` does not merely configure the local client — it generates a
fresh project_id and REWRITES the shared database's project_id with it. Every
other client whose metadata points at the previous id is silently locked out.
This is the exact root cause of the 2026-09-09 fleet lockout (doombot's init
stamped the DB; kangbot's later init overwrote it, locking doombot out).

Rules, verbatim from the fleet contract:

1. `bd init --server` runs ONCE, by whoever first connects — the coordinator
   (primus, once f57.14 lands) or the owner. On a brand-new database only.
2. The `project_id` it mints is THE canonical VS queue contract — treat it
   like a credential. Every later client (every VS device, the scotty
   container's queue-join) obtains it from the coordinator or fleet memory and
   pastes it into their join config. NOBODY generates their own.
3. No client EVER runs any `bd init` variant afterwards. Joining is
   config-only (below). A second init is not an idempotent no-op — it is the
   lockout.
4. bd clients are pinned at **1.2.2** (fleet convention `bd-version-pin`):
   bd 1.3+ auto-migrates the shared Dolt schema and locks out every 1.2.2
   client. Never `npm i -g beads@latest`.

## One-time init (coordinator- or owner-run, first connect only)

From any host that can reach `<master-LAN-IP>:3326`, with bd 1.2.2 installed:

```bash
mkdir vs-ops && cd vs-ops          # any scratch dir; the name is cosmetic
export BEADS_DOLT_PASSWORD='<from owner — the DOLT_PASSWORD fleet variable>'
bd init --server \
  --server-host <master-LAN-IP> \
  --server-port 3326 \
  --server-user vs \
  --database vs_ops \
  --non-interactive
```

The init mints the project_id (visible in `.beads/metadata.json` after init).
Immediately:

1. Record the project_id in fleet memory (`fleet/status/vector-sigma-queue`).
2. Paste it into `balena/registrar/queue-join/metadata.json` in-repo (the
   scotty image's join config) and release.
3. Hand it to every VS device join (below). Devices NEVER init — config only.

## Device / client join (config-only — everyone else)

In the workspace directory (the directory name sets the issue-ID prefix —
pick a stable one, e.g. the device hostname):

```bash
mkdir -p .beads
# 1. metadata.json — copy the repo's queue-join/metadata.json, replace the
#    project_id placeholder with the canonical one, and set
#    dolt_server_host to the master's LAN IP (or LAN hostname once Pi-hole
#    DNS lands, f57.13):
cat > .beads/metadata.json <<'EOF'
{
  "database": "vs_ops",
  "backend": "dolt",
  "dolt_mode": "server",
  "dolt_server_host": "<master-LAN-IP>",
  "dolt_server_user": "vs",
  "dolt_database": "vs_ops",
  "project_id": "<canonical — from coordinator>",
  "dolt_server_port": 3326
}
EOF
# 2. port file
echo 3326 > .beads/dolt-server.port
# 3. password (never commit, echo, or log it)
echo "BEADS_DOLT_PASSWORD=<from owner>" > .beads/.env
chmod 600 .beads/.env
# 4. attribution: stamp the AGENT name, never the machine/bot login
bd config set actor <agent-name>   # e.g. primus
# 5. verify the join — you must see the shared issue counts, not zero
BEADS_ACTOR=<agent-name> bd status
```

Zero or near-zero issues on a fresh join is EXPECTED (new queue) — but
`bd status` must connect, not error. A wrong project_id shows as a foreign or
empty project: stop and re-check the contract id, never re-init.

## Scotty (the dashboard)

Nothing to bootstrap — the image is self-contained:

- Two-layer read-only posture: `SCOTTY_READ_ONLY=1` (scotty refuses project
  writes server-side) + `BD_BIN` wrapper (`bd-readonly` allowlists
  `export --json` / `show <id> --json` / `--version` only, exit 77 otherwise).
- The one setup dependency: `queue-join/metadata.json`'s `project_id`
  placeholder must be replaced with the canonical id after the one-time init
  (the image bakes the file as-is).

## Queue conventions (the VS mirror of the Cabal's FLEET.md)

See `docs/queue-conventions.md`.

## Exposure decisions (documented per AC1)

- **Dolt :3326 published to the device LAN** — deliberate: the owner ruling
  makes device-side bd clients load-bearing ("VS devices run bd clients
  against it"); an unpublished port would break the core queue contract. Not
  reachable off-LAN: balenaCloud's public-URL feature tunnels device port 80
  ONLY (fleet-ops-f57.9). Matches the Cabal precedent (central Dolt at LAN
  :3326 serving every fleet bd client).
- **Scotty :3306 published to the device LAN** — the queue UI for the owner
  and VS agents; same LAN-only posture.
- **Dolt root stays localhost-only** (image default); the queue user `vs` is
  the only LAN-reachable account, password via fleet variable.