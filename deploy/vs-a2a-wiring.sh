#!/command/with-contenv sh
# shellcheck shell=sh
# /etc/cont-init.d/04-vs-a2a-wiring — VS A2A mesh wiring hook (fleet-ops-j7g.1),
# baked into the VS devices agent image (balena/devices/Dockerfile.agent-hermes).
#
# WHAT THIS HOOK DOES — the CODE contract that replaces the f57.14-era HAND
# contract (on the master, primus's .env/config.yaml were hand-shaped from
# the bundle; devices have no hands). The bundle IS the config delivery;
# this hook derives the runtime's process env + config.yaml from it on
# EVERY boot, so a mesh rotation the registrar delivers lands on the next
# container recreate with zero manual steps:
#
#   1. config/agent.env + config/secrets.env lines -> $HERMES_HOME/.env
#      (the bundle line REPLACES any prior line of the same key; managed
#      key-scoped — operator/image-seeded lines like API_SERVER_KEY are
#      preserved untouched).
#   2. config/a2a.json -> the A2A_* env + a2a config.yaml section:
#        identity_key  -> A2A_OWN_IDENTITY_KEY (the agent's OWN mesh key,
#                        presented OUTBOUND via config.yaml a2a_agents
#                        auth interpolation — inert until referenced)
#        peer_tokens   -> A2A_PEER_TOKENS (name:key pairs, INBOUND: a
#                        caller presenting peer X's key resolves to X)
#        trusted_peers -> A2A_TRUSTED_PEERS (the allow-list of resolved
#                        identities that may run tasks — setting it
#                        ACTIVATES enforcement)
#        public_url    -> A2A_PUBLIC_URL (the mesh edge — the master
#                        gateway's served edge; the device's card is
#                        served by the gateway, peers are called through
#                        it: https://<edge>/a2a/<name>)
#        + A2A_PORT=9900 + A2A_HOST=0.0.0.0 written when (and only when)
#          an identity key exists — the A2A platform auto-enables on
#          A2A_PORT, so a bundle with no mesh identity never starts the
#          inbound server (bind-safety: no tokens => localhost-only).
#   3. config.yaml MANAGED SECTION: model.* (from agent.env's
#      MODEL_ROUTE/GATEWAY_URL/GATEWAY_API_KEY), platforms.a2a.enabled,
#      and a2a_agents (one entry per peer_tokens name:
#      url=<public_url>/a2a/<name>, auth ${A2A_OWN_IDENTITY_KEY},
#      timeout 1200 — the fleet standard for agentic peers). Keys OUTSIDE
#      the managed set are preserved verbatim (the stage2 contract:
#      operator-provided values win; the bundle is the operator here).
#   4. VS_CA_CERT_B64 (or VS_CA_CERT) -> SSL_CERT_FILE for the Python TLS
#      stacks (the same CA vs-entrypoint.sh provisions for Node): the
#      post-flip GATEWAY_URL rides TLS under the VS internal CA, and
#      Hermes's model traffic must verify it.
#
# CONTRACTS THIS HOOK HONORS:
#   - s6-overlay cont-init via /command/with-contenv (the 03-vs-queue-join
#     shape), as root, AFTER 01-hermes-setup (stage2) — lexical order.
#   - RE-DERIVED ON EVERY BOOT from the LIVE bundle (the resident rotation
#     watcher applies rotations to the volume). Writes are ATOMIC
#     (tmp + mv) and 0600 — the env file carries the identity keys.
#   - FAIL-SOFT: a broken bundle line or JSON never bricks the agent —
#     it logs loudly and starts WITHOUT the mesh rather than
#     crash-looping a fleet device (the queue-join hook posture).
#   - NEVER a credential source of its own: every value comes from the
#     registrar-delivered bundle (owner custody end to end); the hook
#     only maps file -> process env/config. Nothing plaintext agent-side
#     beyond what the bundle itself carries (0600, device-local).
#   - JSON/YAML handled with the image's own venv python (stdlib json +
#     the image's PyYAML); the base image ships no node and the runtime
#     must not grow a dependency for a boot hook.

set -u

HOME_DIR="${HERMES_HOME:-/data/agent}"
BUNDLE_DIR="$HOME_DIR/config"
ENV_FILE="$HOME_DIR/.env"
CFG_FILE="$HOME_DIR/config.yaml"
CA_FILE="$HOME_DIR/vs-ca.pem"
PY="/opt/hermes/.venv/bin/python"
# The runtime user after stage2's remap (the b1r ownership contract): every
# file this hook writes must stay owned by it — root-owned 0600 files would
# be UNREADABLE to the agent (the queue-join hook's chown discipline).
RUN_UID="${HERMES_UID:-1000}"
RUN_GID="${HERMES_GID:-1000}"

log() { echo "[vs-a2a-wiring] $*"; }

# own_file PATH — re-assert the runtime user's ownership after a write.
own_file() {
  chown "$RUN_UID:$RUN_GID" "$1" 2>/dev/null || \
    log "WARN: could not chown $1 to $RUN_UID:$RUN_GID — runtime may not read it"
}

# ── helpers ──────────────────────────────────────────────────────────────

# set_env KEY VALUE — upsert one KEY= line in $ENV_FILE (0600, atomic).
set_env() {
  _key="$1"; _val="$2"
  case "$_key" in
    *[!A-Za-z0-9_]*) log "ERROR: refusing malformed env key '$_key'"; return 1 ;;
  esac
  touch "$ENV_FILE" 2>/dev/null || { log "ERROR: cannot touch $ENV_FILE"; return 1; }
  _tmp="$ENV_FILE.tmp.$$"
  if grep -q "^${_key}=" "$ENV_FILE" 2>/dev/null; then
    sed "s|^${_key}=.*|${_key}=${_val}|" "$ENV_FILE" > "$_tmp" || { rm -f "$_tmp"; return 1; }
  else
    cp "$ENV_FILE" "$_tmp" || { rm -f "$_tmp"; return 1; }
    printf '%s=%s\n' "$_key" "$_val" >> "$_tmp"
  fi
  mv -f "$_tmp" "$ENV_FILE" || { rm -f "$_tmp"; return 1; }
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  own_file "$ENV_FILE"
}

# drop_env KEY — remove the KEY= line this hook owns from $ENV_FILE.
drop_env() {
  _key="$1"
  [ -f "$ENV_FILE" ] || return 0
  _tmp="$ENV_FILE.tmp.$$"
  grep -v "^${_key}=" "$ENV_FILE" > "$_tmp" 2>/dev/null || { rm -f "$_tmp"; return 0; }
  mv -f "$_tmp" "$ENV_FILE" || { rm -f "$_tmp"; return 1; }
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  own_file "$ENV_FILE"
}

# env_from_file FILE — upsert every KEY=VALUE line of a bundle env file.
env_from_file() {
  _file="$1"
  [ -f "$_file" ] || return 0
  # shellcheck disable=SC2013
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*)
        _k="${line%%=*}"
        case "$_k" in
          *[!A-Za-z0-9_]*) log "WARN: skipping malformed line in $_file: ${_k}"; continue ;;
        esac
        set_env "$_k" "${line#*=}" || log "ERROR: failed to set ${_k} from $_file"
        ;;
      *) log "WARN: non KEY=VALUE line skipped in $_file: $line" ;;
    esac
  done < "$_file"
}

# ── 1: agent.env + secrets.env -> .env ──────────────────────────────────

if [ ! -f "$BUNDLE_DIR/agent.env" ]; then
  log "no bundle at $BUNDLE_DIR yet (identity not delivered?) — wiring skipped this boot"
  exit 0
fi

env_from_file "$BUNDLE_DIR/agent.env"
env_from_file "$BUNDLE_DIR/secrets.env"
log "bundle env lines merged into $ENV_FILE"

# ── 2: a2a.json -> A2A_* env ────────────────────────────────────────────

OWN_KEY=""
PEER_TOKENS=""
TRUSTED=""
PUBLIC=""
if [ -f "$BUNDLE_DIR/a2a.json" ]; then
  # The parser prints four lines: own key, peer tokens (name:key,...),
  # trusted peers (comma-joined), public url. Secrets never appear in
  # logs — only in the 0600 .env write below.
  _parsed="$("$PY" - "$BUNDLE_DIR/a2a.json" 2>/dev/null <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        o = json.load(f)
    if not isinstance(o, dict):
        raise ValueError("not an object")
    ident = o.get("identity_key")
    ident = ident.strip() if isinstance(ident, str) else ""
    tokens = o.get("peer_tokens")
    pairs = []
    if isinstance(tokens, dict):
        for name, tok in tokens.items():
            if isinstance(name, str) and isinstance(tok, str) and name.strip() and tok.strip():
                pairs.append(f"{name.strip()}:{tok.strip()}")
    peers = o.get("trusted_peers")
    trusted = ""
    if isinstance(peers, list):
        trusted = ",".join(p.strip() for p in peers
                           if isinstance(p, str) and p.strip())
    pub = o.get("public_url")
    pub = pub.strip() if isinstance(pub, str) else ""
    print(ident); print(",".join(pairs)); print(trusted); print(pub)
except Exception:
    print(""); print(""); print(""); print("")
PYEOF
)" || _parsed=""
  OWN_KEY="$(printf '%s\n' "$_parsed" | sed -n '1p')"
  PEER_TOKENS="$(printf '%s\n' "$_parsed" | sed -n '2p')"
  TRUSTED="$(printf '%s\n' "$_parsed" | sed -n '3p')"
  PUBLIC="$(printf '%s\n' "$_parsed" | sed -n '4p')"
else
  log "no config/a2a.json in the bundle — A2A inbound stays OFF"
fi

if [ -n "$OWN_KEY" ]; then
  set_env A2A_OWN_IDENTITY_KEY "$OWN_KEY" || log "ERROR: failed to set A2A_OWN_IDENTITY_KEY"
  set_env A2A_HOST "0.0.0.0" || true
  set_env A2A_PORT "9900" || true
  if [ -n "$PEER_TOKENS" ]; then
    set_env A2A_PEER_TOKENS "$PEER_TOKENS" || true
  else
    drop_env A2A_PEER_TOKENS
  fi
  if [ -n "$TRUSTED" ]; then
    set_env A2A_TRUSTED_PEERS "$TRUSTED" || true
  else
    drop_env A2A_TRUSTED_PEERS
  fi
  if [ -n "$PUBLIC" ]; then
    set_env A2A_PUBLIC_URL "$PUBLIC" || true
  else
    drop_env A2A_PUBLIC_URL
  fi
  log "A2A inbound wired (trusted peers: ${TRUSTED:-none}; edge: ${PUBLIC:-unset})"
else
  # No mesh identity in the bundle: the inbound server must never start.
  drop_env A2A_OWN_IDENTITY_KEY
  drop_env A2A_PEER_TOKENS
  drop_env A2A_HOST
  drop_env A2A_PORT
  drop_env A2A_TRUSTED_PEERS
  drop_env A2A_PUBLIC_URL
  log "bundle a2a.json carries no identity_key — A2A inbound stays OFF (bind-safety default)"
fi

# ── 3: config.yaml managed section (model + a2a) ────────────────────────

# The bundle is authoritative for these keys (a device has no operator);
# everything OUTSIDE the managed set is preserved verbatim (the stage2
# operator-wins contract holds for unmanaged keys).
"$PY" - "$CFG_FILE" "$BUNDLE_DIR" <<'PYEOF'
import os, sys, json

cfg_path, bundle_dir = sys.argv[1], sys.argv[2]

def read_env_file(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out

agent_env = read_env_file(os.path.join(bundle_dir, "agent.env"))
a2a = {}
try:
    with open(os.path.join(bundle_dir, "a2a.json")) as f:
        parsed = json.load(f)
    if isinstance(parsed, dict):
        a2a = parsed
except Exception:
    pass

managed = {}
REMOVE_KEYS: list = []  # managed keys to DELETE (authoritative-removal set)
model_route = agent_env.get("MODEL_ROUTE", "").strip()
gateway_url = agent_env.get("GATEWAY_URL", "").strip()
gateway_key = agent_env.get("GATEWAY_API_KEY", "").strip()
if model_route or gateway_url:
    model = {}
    if model_route:
        model["default"] = model_route
    if gateway_url:
        model["base_url"] = gateway_url
    if gateway_key:
        model["api_key"] = "${GATEWAY_API_KEY}"  # bundle line, staged in .env above
    if model:
        managed["model"] = model
ident = a2a.get("identity_key") if isinstance(a2a.get("identity_key"), str) else ""
public = a2a.get("public_url") if isinstance(a2a.get("public_url"), str) else ""
public = public.strip()
tokens = a2a.get("peer_tokens")
peer_names = []
if isinstance(tokens, dict):
    peer_names = sorted(str(k).strip() for k in tokens
                        if isinstance(k, str) and str(k).strip()
                        and isinstance(tokens[k], str) and tokens[k].strip())
if ident.strip() and peer_names and public:
    managed["platforms"] = {"a2a": {"enabled": True}}
    agents = {}
    for name in peer_names:
        base = public.rstrip("/")
        agents[name] = {
            "url": f"{base}/a2a/{name}",
            "auth": {"type": "bearer", "token": "${A2A_OWN_IDENTITY_KEY}"},
            "timeout": 1200,
        }
    managed["a2a_agents"] = agents
else:
    # Authoritative BOTH ways: no mesh identity in the bundle => the managed
    # a2a sections are REMOVED (a stale a2a_agents entry would keep calling
    # peers with a dropped credential; a stale platforms.a2a would keep the
    # inbound flagged enabled in config even with A2A_PORT unset in .env).
    managed["platforms"] = {"a2a": {"enabled": False}}
    REMOVE_KEYS.append("a2a_agents")

try:
    import yaml
    existing = {}
    try:
        with open(cfg_path) as f:
            existing = yaml.safe_load(f) or {}
        if not isinstance(existing, dict):
            existing = {}
    except FileNotFoundError:
        pass
    existing.update(managed)
    for key in REMOVE_KEYS:
        existing.pop(key, None)
    tmp = cfg_path + ".tmp"
    with open(tmp, "w") as f:
        yaml.safe_dump(existing, f, default_flow_style=False, sort_keys=False)
    os.replace(tmp, cfg_path)
    # The ownership contract: stage2 remaps the runtime user; a root-owned
    # config.yaml is unreadable to the agent (the queue-join discipline).
    try:
        os.chown(cfg_path, int(os.environ.get("HERMES_UID", "1000")),
                 int(os.environ.get("HERMES_GID", "1000")))
    except Exception:
        pass
    print(f"[vs-a2a-wiring] config.yaml managed section written: {sorted(managed)}")
except Exception as e:
    print(f"[vs-a2a-wiring] WARN: config.yaml managed write failed: {e} — runtime keeps prior config", file=sys.stderr)
PYEOF

# ── 4: the VS internal CA -> Python TLS trust ──────────────────────────

if [ -n "${VS_CA_CERT:-}" ]; then
  if [ -f "$VS_CA_CERT" ]; then
    set_env SSL_CERT_FILE "$VS_CA_CERT" || true
    log "SSL_CERT_FILE=$VS_CA_CERT (variable-provided CA)"
  else
    log "WARN: VS_CA_CERT set but missing: $VS_CA_CERT — TLS trust unchanged"
  fi
elif [ -n "${VS_CA_CERT_B64:-}" ]; then
  if printf '%s' "$VS_CA_CERT_B64" | base64 -d > "$CA_FILE" 2>/dev/null; then
    if grep -q "BEGIN CERTIFICATE" "$CA_FILE" 2>/dev/null; then
      chmod 600 "$CA_FILE" 2>/dev/null || true
      own_file "$CA_FILE"
      set_env SSL_CERT_FILE "$CA_FILE" || true
      log "SSL_CERT_FILE=$CA_FILE (decoded from VS_CA_CERT_B64)"
    else
      log "WARN: decoded VS_CA_CERT_B64 is not a PEM — TLS trust unchanged"
      rm -f "$CA_FILE"
    fi
  else
    log "WARN: VS_CA_CERT_B64 is not valid base64 — TLS trust unchanged"
  fi
fi

log "done"
exit 0