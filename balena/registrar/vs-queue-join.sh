#!/command/with-contenv sh
# shellcheck shell=sh
# /etc/cont-init.d/03-vs-queue-join — VS queue workspace seeding hook
# (fleet-ops-b1r, baked into balena/registrar/Dockerfile.hermes).
#
# Contracts this hook honors:
#   - runs as a s6-overlay cont-init script via /command/with-contenv
#     (the upstream image's own 01-/02- hook shape — /init scrubs env
#     before cont-init, with-contenv rehydrates HERMES_HOME etc.), as
#     root, AFTER 01-hermes-setup (stage2: UID/GID remap + volume chown
#     + config seed). s6 runs cont-init scripts in lexical order, so
#     the 03- prefix runs after 01-, 015- and 02-.
#   - FIRST-BOOT-ONLY seeding: when the workspace already exists, the
#     hook does nothing (agent edits inside the volume win — the same
#     contract as stage2's config seed).
#   - FAIL-SOFT: this hook must never brick the agent. The queue join
#     is tooling; the runtime must start even when dolt is down. Every
#     error path logs loudly and exits 0. The queue's own liveness is
#     the dolt service's healthcheck + the E2E's bd status assertion.
#   - NEVER bd init: the join is config-only (the 2026-09-09 fleet
#     lockout class — a second init rewrites the shared DB's
#     project_id). This hook only copies baked files.
#   - WRITABLE BY THE RUNTIME USER: bd writes inside the workspace
#     (config.yaml, last-touched, interactions.jsonl, locks). The hook
#     runs as root after stage2's remap, so chown to the remapped
#     hermes user — a root-owned workspace would make bd read-only for
#     the agent and break curation (the whole point of this lane).
#   - bd pin 1.2.2 absolute (fleet convention bd-version-pin): a baked
#     bd that answers anything else means the build fetched the wrong
#     release — fail loud at BOOT (container logs), not mid-curation.
set -u

SRC="/opt/vs/queue-join"
HOME_DIR="${HERMES_HOME:-/opt/data}"
WS="$HOME_DIR/vs-queue"

log() { echo "[vs-queue-join] $*"; }

if [ ! -d "$SRC/.beads" ]; then
    log "ERROR: baked queue-join source $SRC/.beads missing — image build broken; skipping seed (agent starts without queue tooling)"
    exit 0
fi

if [ -e "$WS/.beads/metadata.json" ]; then
    log "workspace $WS already seeded — first-boot-only contract, leaving it alone"
    exit 0
fi

if ! mkdir -p "$WS/.beads" 2>/dev/null; then
    log "ERROR: cannot create $WS/.beads — volume not ready; skipping seed (agent starts without queue tooling)"
    exit 0
fi

if ! cp -R "$SRC/.beads/." "$WS/.beads/" 2>/dev/null; then
    log "ERROR: copy from $SRC/.beads failed — skipping seed (agent starts without queue tooling)"
    # Partial copy cleanup: a half-written join config is worse than none
    # (bd would refuse on a malformed metadata.json). The next boot's
    # first-boot-only check sees no metadata.json and retries the seed.
    rm -f "$WS/.beads/metadata.json" 2>/dev/null
    exit 0
fi

# Actor stamp + peer-client backup posture (config-only, hermes-specific —
# scotty's BEADS_REPO never sees this file). The AGENT name is the actor
# (bd-actor-stamp convention); a server-mode peer client silences the
# Dolt-native auto-backup (bd-autobackup-server-mode convention — its
# registration would fail server-side on every invocation).
cat > "$WS/.beads/config.yaml" <<'EOF' 2>/dev/null || log "WARNING: could not write $WS/.beads/config.yaml — actor stamp + backup silencing skipped (bd still works; set with: bd config set actor primus)"
# Seeded by the image's 03-vs-queue-join boot hook (fleet-ops-b1r).
# Actor = the AGENT name (fleet bd-actor-stamp convention).
actor: "primus"
# Server-mode peer client: auto-backup registration fails server-side
# (fleet bd-autobackup-server-mode convention) — silence it.
backup:
  enabled: false
EOF

# Make the workspace the runtime user's: bd writes here. Stage2 has already
# remapped the hermes user when this runs, so id resolves the remapped uid.
h_uid="$(id -u hermes 2>/dev/null || echo 0)"
h_gid="$(id -g hermes 2>/dev/null || echo 0)"
chown -R "$h_uid:$h_gid" "$WS" 2>/dev/null \
    || log "WARNING: chown $WS to $h_uid:$h_gid failed — bd may not write the workspace as the runtime user"

# .beads must be 0700 in the runtime (bd warns on looser perms; the fleet's
# join contract wants the workspace private to the runtime user).
chmod 700 "$WS/.beads" 2>/dev/null || true

# Fail-loud bd pin check (log-only, never exit non-zero — see FAIL-SOFT).
if command -v bd >/dev/null 2>&1; then
    got="$(bd --version 2>/dev/null || echo unknown)"
    case "$got" in
        *"bd version 1.2.2"*) log "bd pin verified: $got" ;;
        *) log "WARNING: baked bd answers '$got' — expected 'bd version 1.2.2 (…)'. The fleet pin is absolute (bd-version-pin); rebuild the image with BD_VERSION=1.2.2." ;;
    esac
fi

log "seeded $WS (queue workspace ready — cd $WS && bd status)"