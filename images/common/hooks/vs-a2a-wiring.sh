#!/command/with-contenv sh
# shellcheck shell=sh
# /etc/cont-init.d/04-vs-a2a-wiring — VS A2A mesh wiring hook (fleet-ops-j7g.1),
# baked into the VS devices agent image (images/agent/Dockerfile).
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
#        public_url    -> A2A_PUBLIC_URL (the enrollee's OWN
#                        proxy-dialable origin — the device's serve
#                        form https://<device>...:9900, primus's
#                        compose-internal origin; NEVER the mesh edge:
#                        the gateway's proxy follows it to DELIVER
#                        peer traffic, an edge form loops
#                        proxy->edge->proxy — lfk)
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
#   4. TLS trust: RETIRED with the internal CA (lnf, phase 2) — the edge
#      serves Let's Encrypt certificates (publicly trusted, stock stores
#      verify them); no trust provisioning runs in this hook anymore.
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

# ── 2b: signed identity (docs/a2a-signed-identity.md) ──────────────────
# Every boot: ensure this agent's Ed25519 key exists on the data volume (the registrant reports
# the PUBLIC key; the private key never leaves this volume). When the bundle carries peer_keys,
# switch to signed mode: the a2a-guard s6 service fronts Hermes on :9900, Hermes moves to
# 127.0.0.1:9901 and accepts LOCAL per-peer tokens (generated here, never in a bundle), and
# keyed peers' a2a_agents go through the outbound guard. Without peer_keys, guard.json is
# removed so the service stays down and everything above holds exactly as before.
GUARD_DIR="$HOME_DIR/a2a-guard"
SIGNED_PEERS=""
if [ -x /usr/local/bin/vs-a2a-guard ]; then
  mkdir -p "$GUARD_DIR" && chmod 700 "$GUARD_DIR"
  if _pub="$("$PY" /usr/local/bin/vs-a2a-guard keygen --state-dir "$GUARD_DIR" 2>/dev/null)"; then
    printf '%s\n' "$_pub" > "$GUARD_DIR/pubkey.json.tmp" && mv -f "$GUARD_DIR/pubkey.json.tmp" "$GUARD_DIR/pubkey.json"
    log "a2a identity key: fingerprint $(printf '%s' "$_pub" | sed -n 's/.*"fingerprint": "\([0-9a-f]*\)".*/\1/p')"
  else
    log "WARN: a2a-guard keygen failed — signed identity unavailable this boot"
  fi
  _signed="$("$PY" - "$GUARD_DIR" "$BUNDLE_DIR" "$ENV_FILE" <<'PYEOF'
import json, os, secrets, sys
gd, bundle_dir, env_file = sys.argv[1:4]
def env_val(path, key):
    try:
        for line in open(path):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""
try:
    a2a = json.load(open(os.path.join(bundle_dir, "a2a.json")))
except Exception:
    a2a = {}
keys = a2a.get("peer_keys") if isinstance(a2a.get("peer_keys"), dict) else {}
me = env_val(os.path.join(bundle_dir, "agent.env"), "AGENT_NAME")
edge = env_val(os.path.join(bundle_dir, "agent.env"), "GATEWAY_URL").rstrip("/")
public = a2a.get("public_url") if isinstance(a2a.get("public_url"), str) else ""
cfg = os.path.join(gd, "guard.json")
peers = sorted(n for n, k in keys.items() if isinstance(n, str) and n.strip() and n != me and isinstance(k, str) and k)
if not (a2a.get("identity_key") and peers and me and edge and public.strip()):
    if os.path.exists(cfg):
        os.remove(cfg)
    print("OFF"); sys.exit(0)
def secret(path, value):
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value)
    os.replace(path + ".tmp", path)
tok_path = os.path.join(gd, "local-peer-tokens.json")
try:
    toks = json.load(open(tok_path))
except Exception:
    toks = {}
toks = {n: toks.get(n) or secrets.token_urlsafe(32) for n in peers}
secret(tok_path, json.dumps(toks))
out_path = os.path.join(gd, "outbound-token")
try:
    outbound = open(out_path).read().strip()
except OSError:
    outbound = ""
secret(out_path, outbound or secrets.token_urlsafe(32))
# 1py.47.1: the hub routing target lives in the bundle — a2a.json
# hub_router_agent (the peer name the owner's hub coordinator assigns VS
# work to). Empty or absent = no hub routing: nothing is derived, the
# router service stays idled and the spool just holds.
hub_agent = a2a.get("hub_router_agent") if isinstance(a2a.get("hub_router_agent"), str) else ""
hub_agent = hub_agent.strip()
guard = {"agent_name": me, "state_dir": ".", "bundle_a2a": os.path.join(bundle_dir, "a2a.json"),
         "env_file": env_file,
         "inbound": {"listen_host": "0.0.0.0", "listen_port": 9900, "upstream": "http://127.0.0.1:9901",
                     "public_url": public.strip()},
         "outbound": {"listen_port": 9902, "gateway_key_env": "A2A_OWN_IDENTITY_KEY",
                      "peers": {n: {"url": f"{edge}/a2a/{n}", "gateway_agent_id": n, "aud": n} for n in peers}}}
with open(cfg + ".tmp", "w") as f:
    json.dump(guard, f, indent=1)
os.replace(cfg + ".tmp", cfg)
# line 1: mode + strict; line 2: signed peer names; line 3: LOCAL tokens (secret: never logged);
# line 4: the hub routing target from the bundle (hub_router_agent; empty = none)
print("ON " + ("strict" if a2a.get("strict") else "dual"))
print(",".join(peers))
print(",".join(f"{n}:{t}" for n, t in toks.items()))
print(hub_agent)
PYEOF
)" || _signed="OFF"
  _mode="$(printf '%s\n' "$_signed" | sed -n '1p')"
  if [ "${_mode%% *}" = "ON" ]; then
    SIGNED_PEERS="$(printf '%s\n' "$_signed" | sed -n '2p')"
    _local="$(printf '%s\n' "$_signed" | sed -n '3p')"
    # Hermes listens only on loopback behind the guard; it resolves callers by LOCAL tokens. In
    # dual mode the bundle's legacy peer_tokens stay too (unsigned peers still work until the owner
    # flips strict; the guard enforces strict live, before Hermes sees anything).
    set_env A2A_HOST "127.0.0.1" || true
    set_env A2A_PORT "9901" || true
    if [ "${_mode#ON }" = "strict" ] || [ -z "$PEER_TOKENS" ]; then
      set_env A2A_PEER_TOKENS "$_local" || true
    else
      set_env A2A_PEER_TOKENS "$_local,$PEER_TOKENS" || true
    fi
    set_env A2A_GUARD_OUTBOUND_TOKEN "$(cat "$GUARD_DIR/outbound-token")" || true
    # 1py.47.1: the hub routing target (bundle line 4; empty = none). The
    # s6 vs-hub-router longrun reads this env — unset, the service idles
    # and nothing routes; set, the dispatch spool at $HOME_DIR/vs-hub-queue
    # is delivered through the signed outbound route (queue conventions).
    _hub_agent="$(printf '%s\n' "$_signed" | sed -n '4p')"
    if [ -n "$_hub_agent" ]; then
      set_env VS_HUB_TARGET_AGENT "$_hub_agent" || true
    else
      drop_env VS_HUB_TARGET_AGENT
    fi
    export VS_HUB_TARGET_AGENT
    log "signed identity ON (${_mode#ON } mode; signed peers: $SIGNED_PEERS)"
  else
    drop_env A2A_GUARD_OUTBOUND_TOKEN
    drop_env VS_HUB_TARGET_AGENT
    log "signed identity off (no peer_keys in the bundle) — a2a-guard stays down"
  fi
  chown -R "$RUN_UID:$RUN_GID" "$GUARD_DIR" 2>/dev/null || log "WARN: could not chown $GUARD_DIR"
fi
export SIGNED_PEERS

# ── 2c: the VS hub router spool (1py.47.1) ─────────────────────────────
# Durable spool for hub-assigned dispatches (the s6 vs-hub-router longrun
# delivers when the wiring derived a $VS_HUB_TARGET_AGENT above). Seeded
# every boot, fail-soft; the envelopes inside persist across reboots and
# rebuilds like the rest of $HOME_DIR, so a message queued while the
# route was down is delivered later, never dropped.
HUB_QUEUE_DIR="$HOME_DIR/vs-hub-queue"
if mkdir -p "$HUB_QUEUE_DIR/pending" "$HUB_QUEUE_DIR/sent" "$HUB_QUEUE_DIR/dead" 2>/dev/null; then
  chmod 700 "$HUB_QUEUE_DIR" 2>/dev/null || true
  chown -R "$RUN_UID:$RUN_GID" "$HUB_QUEUE_DIR" 2>/dev/null || log "WARN: could not chown $HUB_QUEUE_DIR"
else
  log "WARN: could not seed $HUB_QUEUE_DIR — the hub router stays idle"
fi
export VS_HUB_QUEUE_DIR="${HUB_QUEUE_DIR}"

# ── 3: config.yaml managed section (model + a2a) ────────────────────────

# The bundle is authoritative for these keys (a device has no operator);
# everything OUTSIDE the managed set is preserved verbatim (the stage2
# operator-wins contract holds for unmanaged keys).
"$PY" - "$CFG_FILE" "$BUNDLE_DIR" <<'PYEOF'
import os, sys, json, re

cfg_path, bundle_dir = sys.argv[1], sys.argv[2]
defaults_path = os.environ.get("VS_HERMES_DEFAULTS_FILE", "/opt/vs/hermes-agent-defaults.yaml")

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
# Signed identity (section 2b): peers with a registered public key are called through the local
# outbound guard, which signs as this agent; in strict bundles they need not appear in peer_tokens.
signed_peers = [n for n in os.environ.get("SIGNED_PEERS", "").split(",") if n]
peer_names = sorted(set(peer_names) | set(signed_peers))
# Outbound peer URLs ride the mesh EDGE from the bundle's GATEWAY_URL (the
# gateway serves every agent's card at /a2a/<name> — peers call each other
# THROUGH the gateway, never origin-to-origin). public_url (A2A_PUBLIC_URL)
# is the OTHER direction: the delivery address the gateway's proxy dials
# (LiteLLM re-discovers the origin card and follows its advertised url —
# pointing THAT at the edge would loop proxy->edge->proxy; it must be the
# proxy-reachable origin, compose-internal or LAN/tailnet).
if ident.strip() and peer_names and gateway_url:
    managed["platforms"] = {"a2a": {"enabled": True}}
    edge = gateway_url.rstrip("/")
    agents = {}
    for name in peer_names:
        if name in signed_peers:
            agents[name] = {
                "url": f"http://127.0.0.1:9902/peer/{name}",
                "auth": {"type": "bearer", "token": "${A2A_GUARD_OUTBOUND_TOKEN}"},
                "timeout": 1200,
            }
            continue
        agents[name] = {
            "url": f"{edge}/a2a/{name}",
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
    # Seed device policy defaults without replacing operator-edited values.
    # Bundle extra_env is the deployment override plane; unresolved placeholders
    # (summary model and gateway URL) remain for Hermes environment expansion.
    try:
        with open(defaults_path) as f:
            raw_defaults = f.read()
        values = dict(os.environ)
        values.update(agent_env)
        raw_defaults = re.sub(
            r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}",
            lambda m: values.get(m.group(1), m.group(2) if m.group(2) is not None else m.group(0)), raw_defaults)
        defaults = yaml.safe_load(raw_defaults) or {}
        def seed_missing(dst, src):
            for key, value in src.items():
                if key not in dst:
                    dst[key] = value
                elif isinstance(dst[key], dict) and isinstance(value, dict):
                    seed_missing(dst[key], value)
        seed_missing(existing, defaults)
        # Explicit knobs remain effective on later boots even after defaults
        # were seeded into the persistent volume. Ordinary config edits still
        # win when their corresponding environment knob is unset.
        overrides = {
            "VS_HERMES_COMPRESSION_THRESHOLD_TOKENS": ("compression", "threshold_tokens"),
            "VS_HERMES_TOOL_OUTPUT_MAX_BYTES": ("tool_output", "max_bytes"),
            "VS_HERMES_FILE_READ_MAX_CHARS": ("file_read_max_chars",),
            "VS_HERMES_MCP_RESULT_SIZE_CHARS": ("tool_budget", "mcp_result_size_chars"),
            "VS_HERMES_CONTEXT_LENGTH": ("model", "context_length"),
            "VS_HERMES_SUMMARY_MODEL": ("auxiliary", "compression", "model"),
            "GATEWAY_URL": ("auxiliary", "compression", "base_url"),
        }
        for env_key, keys in overrides.items():
            if env_key not in values or not values[env_key]:
                continue
            value = yaml.safe_load(values[env_key]) if env_key.startswith("VS_HERMES_") and env_key != "VS_HERMES_SUMMARY_MODEL" else values[env_key]
            target = existing
            for key in keys[:-1]:
                target = target.setdefault(key, {})
            target[keys[-1]] = value
    except FileNotFoundError:
        # The master image intentionally has no device policy template.
        pass
    # Bundle owns model routing, but its managed values must not discard
    # context_length or other default/operator model settings.
    for key, value in managed.items():
        if key == "model" and isinstance(existing.get(key), dict):
            existing[key].update(value)
        else:
            existing[key] = value
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

# ── 4: TLS trust (RETIRED with the internal CA — lnf, j7g phase 2) ────
# The VS_CA_CERT / VS_CA_CERT_B64 -> SSL_CERT_FILE provisioning block is
# GONE: the edge is tailscale serve with Let's Encrypt certificates —
# publicly trusted by every stock trust store, Python's certifi bundle
# included. No trust provisioning runs anywhere in the composition
# anymore; the VS_CA_* variables no longer exist in the bundle or the
# fleet's variable sets. Kept as a numbered section header so the hook's
# doc-comment enumeration stays aligned.

log "done"
exit 0