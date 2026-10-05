#!/command/with-contenv sh
# shellcheck shell=sh
# /etc/cont-init.d/06-vs-memory-tools — VS gateway-memory plugin install hook
# (fleet-ops-e5o.3). Baked into BOTH VS Hermes images:
#   balena/registrar/Dockerfile.hermes      (primus, the master coordinator)
#   balena/devices/Dockerfile.agent-hermes  (every device agent)
#
# WHAT THIS HOOK DOES — installs the VS-repo copy of the gateway-memory
# plugin (deploy/gateway-memory/, byte-pinned by the vendored-drift test)
# into the runtime's $HERMES_HOME/plugins/ and seeds the PluginManager
# allow-list so the plugin's tools actually load:
#
#   1. cp the plugin dir /opt/vs/gateway-memory -> $HERMES_HOME/plugins/
#      (excluding __pycache__ — compiled bytecode from the build host is
#      junk in the image and can shadow a stale module).
#   2. Seed plugins.enabled [<gateway-memory>] into $HERMES_HOME/config.yaml
#      — PluginManager gates every discovered user plugin through the
#      allow-list (hermes_cli/plugins.py: _gate_manifest checks
#      plugins.enabled); a copied-but-unlisted plugin registers NOTHING.
#      Seeding is idempotent and additive: existing enabled entries are
#      preserved, gateway-memory is appended when absent.
#
# CONTRACTS THIS HONORS:
#   - The plugin is CONFIG-ONLY at boot: the memory KEYS arrive via the
#     registrar bundle's extra_env (GATEWAY_MEMORY_SHARED_KEY +
#     GATEWAY_MEMORY_PRIVATE_KEY), never baked, never in the image. The
#     plugin's tools return clear "not set" errors until the bundle
#     delivers them — that is the intended pre-identity state, not a bug.
#   - FLEET_MEMORY_BASE_URL is seeded from the bundle's extra_env too
#     (the wiring hook merges every bundle env line into .env; this hook
#     needs no env of its own).
#   - Runs AFTER 01-hermes-setup (stage2 seeds config.yaml when absent) —
#     lexical 06- keeps it after the queue join (03-), A2A wiring (04-),
#     and GitHub identity (05-), all independent and fail-soft.
#   - s6-overlay cont-init via /command/with-contenv, as root, re-derived
#     on EVERY boot (a fresh volume gets the plugin; an existing install
#     is refreshed from the baked copy — the image is the source of truth).
#   - FAIL-SOFT: a missing plugin dir or a broken config.yaml never bricks
#     the agent — loud log, exit 0, agent starts without memory tools.
#   - Ownership: every written file is chowned to the runtime user
#     (HERMES_UID/HERMES_GID, default 1000 — the stage2 remap contract;
#     root-owned plugins would be unreadable to the agent process).
#
# The 06- hook never touches credentials. It moves files and edits ONE
# config key. If it ever does more, split it.

set -u

HOME_DIR="${HERMES_HOME:-/data/agent}"
PLUGINS_DIR="$HOME_DIR/plugins"
CFG_FILE="$HOME_DIR/config.yaml"
SRC_DIR="/opt/vs/gateway-memory"
PLUGIN_NAME="gateway-memory"
# The runtime user after stage2's remap (the b1r ownership contract).
RUN_UID="${HERMES_UID:-1000}"
RUN_GID="${HERMES_GID:-1000}"

log() { echo "[vs-memory-tools] $*"; }

own_tree() {
  chown -R "$RUN_UID:$RUN_GID" "$1" 2>/dev/null || \
    log "WARN: could not chown $1 to $RUN_UID:$RUN_GID — runtime may not read it"
}

# ── 1: copy the plugin into $HERMES_HOME/plugins/ ─────────────────────────

if [ ! -d "$SRC_DIR" ]; then
  log "no baked plugin at $SRC_DIR — memory tools unavailable this boot (image build skipped the COPY?)"
  exit 0
fi

if ! mkdir -p "$PLUGINS_DIR/$PLUGIN_NAME" 2>/dev/null; then
  log "cannot create $PLUGINS_DIR/$PLUGIN_NAME — memory tools unavailable this boot"
  exit 0
fi

# rm + cp keeps every boot authoritative for the COPY (stale files from an
# old image die); __pycache__ is excluded — build-host bytecode is junk.
rm -rf "$PLUGINS_DIR/$PLUGIN_NAME"
if cp -R "$SRC_DIR" "$PLUGINS_DIR/$PLUGIN_NAME" 2>/dev/null; then
  rm -rf "$PLUGINS_DIR/$PLUGIN_NAME/__pycache__" \
         "$PLUGINS_DIR/$PLUGIN_NAME/skills"/*/__pycache__ 2>/dev/null || true
  own_tree "$PLUGINS_DIR/$PLUGIN_NAME"
  log "plugin installed at $PLUGINS_DIR/$PLUGIN_NAME"
else
  log "ERROR: copy from $SRC_DIR failed — memory tools unavailable this boot"
  exit 0
fi

# ── 2: seed plugins.enabled in config.yaml (the PluginManager gate) ──────

# venv python from the image (the a2a-wiring hook's PY posture: stdlib +
# the image's yaml lib; no new dependency for a boot hook).
PY="/opt/hermes/.venv/bin/python"
if [ ! -x "$PY" ]; then
  # The official image's venv location can move between tags; try the PATH
  # python before giving up (config seeding is required for the plugin to
  # load — a missing interpreter means the plugin stays inert, not fatal).
  if command -v python3 >/dev/null 2>&1; then
    PY="$(command -v python3)"
  else
    log "ERROR: no python found — cannot seed plugins.enabled; memory tools stay inert"
    exit 0
  fi
fi

"$PY" - "$CFG_FILE" "$PLUGIN_NAME" <<'PYEOF'
import os, sys

cfg_path, plugin_name = sys.argv[1], sys.argv[2]

try:
    import yaml
except ImportError:
    print(f"[vs-memory-tools] WARN: no yaml module — cannot seed plugins.enabled; {plugin_name} stays inert")
    sys.exit(0)

existing = {}
try:
    with open(cfg_path) as f:
        existing = yaml.safe_load(f) or {}
    if not isinstance(existing, dict):
        existing = {}
except FileNotFoundError:
    # Stage2 seeds config.yaml on first boot; a missing file here means
    # stage2 hasn't run or uses another path — loud, fail-soft.
    print(f"[vs-memory-tools] WARN: {cfg_path} absent — cannot seed plugins.enabled (stage2 not run yet?)")
    sys.exit(0)
except Exception as e:
    print(f"[vs-memory-tools] WARN: cannot parse {cfg_path}: {e} — leaving config untouched")
    sys.exit(0)

plugins = existing.get("plugins")
if plugins is None:
    plugins = {}
elif not isinstance(plugins, dict):
    # A malformed plugins section must never brick boot: log and leave it.
    print(f"[vs-memory-tools] WARN: plugins section of {cfg_path} is not a mapping — leaving config untouched")
    sys.exit(0)

enabled = plugins.get("enabled")
if enabled is None:
    enabled = [plugin_name]
elif isinstance(enabled, list):
    if plugin_name not in enabled:
        enabled = list(enabled) + [plugin_name]
else:
    # enabled present but not a list: overwrite would destroy operator
    # intent silently; log and skip rather than guess.
    print(f"[vs-memory-tools] WARN: plugins.enabled is not a list — leaving config untouched")
    sys.exit(0)

plugins["enabled"] = enabled
existing["plugins"] = plugins

tmp = cfg_path + ".tmp"
with open(tmp, "w") as f:
    yaml.safe_dump(existing, f, default_flow_style=False, sort_keys=False)
os.replace(tmp, cfg_path)
try:
    os.chown(cfg_path, int(os.environ.get("HERMES_UID", "1000")),
             int(os.environ.get("HERMES_GID", "1000")))
except Exception:
    pass
print(f"[vs-memory-tools] plugins.enabled seeded: {enabled}")
PYEOF

log "done"
exit 0