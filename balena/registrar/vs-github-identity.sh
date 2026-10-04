#!/command/with-contenv sh
# shellcheck shell=sh
# /etc/cont-init.d/05-vs-github-identity — VS GitHub App identity wiring
# hook (fleet-ops-e5o.5), baked into BOTH VS agent images (the master's
# Dockerfile.hermes and the devices' Dockerfile.agent-hermes).
#
# WHAT THIS HOOK DOES — the CODE contract that makes a VS agent's git
# writes land as <app-slug>[bot] with zero hand-shaped config:
#
#   1. When the registrar-delivered bundle carries a GitHub App identity
#      (config/github-app.pem present, GH_APP_ID + GH_APP_SLUG lines in
#      config/agent.env), derives into $HERMES_HOME/.env:
#        GH_APP_PEM_PATH     where the wrapper finds the PEM
#        GIT_CONFIG_COUNT=3  + GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n:
#            credential.helper = !/usr/local/bin/vs-github-identity cred
#            user.name        = <slug>[bot]
#            user.email       = <id>+<slug>[bot]@users.noreply.github.com
#      The GIT_CONFIG_* channel is git's ENV configuration (no local
#      config file owned by the hook): plain git clone/pull/push over
#      https://github.com/... then authenticate as the App with the
#      credential helper minting short-lived installation tokens on
#      demand. Commits attribute to <slug>[bot] via the identity lines.
#
#   2. When the identity is ABSENT (no PEM, or missing id/slug), the
#      hook REMOVES the whole managed block — a dropped identity never
#      leaves a stale credential path behind.
#
# CONTRACTS THIS HOOK HONORS (the 04-vs-a2a-wiring posture, verbatim
# discipline):
#   - s6-overlay cont-init via /command/with-contenv (the 03-vs-queue-join
#     shape), as root, AFTER 01-hermes-setup (stage2) and AFTER the A2A
#     wiring hook (04-) — lexical order.
#   - RE-DERIVED ON EVERY BOOT from the LIVE bundle (the resident
#     rotation watcher applies rotations to the volume). Writes are
#     ATOMIC (tmp + mv) and 0600 — the env file carries identity keys.
#   - FAIL-SOFT: a broken bundle line or a missing file never bricks the
#     agent — it logs loudly and starts WITHOUT GitHub identity rather
#     than crash-looping a fleet device.
#   - NEVER a credential source of its own: every value comes from the
#     registrar-delivered bundle (owner custody end to end); the hook
#     only maps file -> process env. Nothing plaintext agent-side
#     beyond what the bundle itself carries (0600, device-local).
#   - Pure POSIX sh + grep/sed — no python needed at boot.
#   - The PEM is never read into a variable, never logged, never copied
#     by this hook — it is only tested for existence; the wrapper reads
#     it at mint time.
#
# FLEET-AGNOSTIC: no agent names, host names, or gateway names appear
# here — identity values come from the bundle, structure from the repo.

set -u

HOME_DIR="${HERMES_HOME:-/data/agent}"
BUNDLE_DIR="$HOME_DIR/config"
ENV_FILE="$HOME_DIR/.env"
PEM_FILE="$BUNDLE_DIR/github-app.pem"
WRAPPED="/usr/local/bin/vs-github-identity"
# The runtime user after stage2's remap (the b1r ownership contract):
# every file this hook writes must stay owned by it.
RUN_UID="${HERMES_UID:-1000}"
RUN_GID="${HERMES_GID:-1000}"

# The env keys this hook owns, wholesale. Removal drops every one.
MANAGED_KEYS="GH_APP_PEM_PATH
GIT_CONFIG_COUNT
GIT_CONFIG_KEY_0
GIT_CONFIG_VALUE_0
GIT_CONFIG_KEY_1
GIT_CONFIG_VALUE_1
GIT_CONFIG_KEY_2
GIT_CONFIG_VALUE_2"

log() { echo "[vs-github-identity] $*"; }

# own_file PATH — re-assert the runtime user's ownership after a write.
own_file() {
  chown "$RUN_UID:$RUN_GID" "$1" 2>/dev/null || \
    log "WARN: could not chown $1 to $RUN_UID:$RUN_GID — runtime may not read it"
}

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

# remove_managed — drop every key this hook owns (idempotent).
remove_managed() {
  for _k in $MANAGED_KEYS; do
    drop_env "$_k" || log "ERROR: failed to drop $_k"
  done
}

# env_get FILE KEY — echo the value of KEY from a bundle env file.
env_get() {
  _file="$1"; _key="$2"
  [ -f "$_file" ] || return 0
  _line="$(grep -m1 "^${_key}=" "$_file" 2>/dev/null)"
  [ -n "$_line" ] || return 0
  printf '%s' "${_line#*=}"
}

# ── 0: identity present? All three or nothing — a partial identity is
# logged and treated as absent (never wire half an identity). ─────────
if [ ! -f "$PEM_FILE" ]; then
  log "no github-app.pem in the bundle — removing managed GitHub env (identity not provisioned)"
  remove_managed
  exit 0
fi

APP_ID="$(env_get "$BUNDLE_DIR/agent.env" GH_APP_ID)"
APP_SLUG="$(env_get "$BUNDLE_DIR/agent.env" GH_APP_SLUG)"
if [ -z "$APP_ID" ] || [ -z "$APP_SLUG" ]; then
  log "PEM present but GH_APP_ID/GH_APP_SLUG missing from agent.env — removing managed GitHub env (partial identity treated as absent)"
  remove_managed
  exit 0
fi

log "GitHub App identity present (app ${APP_SLUG}, id ${APP_ID}) — deriving git env"

# ── 1: derive the managed block into .env ────────────────────────────
set_env GH_APP_PEM_PATH "$PEM_FILE" || log "ERROR: failed to set GH_APP_PEM_PATH"
set_env GIT_CONFIG_COUNT "3" || log "ERROR: failed to set GIT_CONFIG_COUNT"
set_env GIT_CONFIG_KEY_0 "credential.helper" || log "ERROR: failed to set GIT_CONFIG_KEY_0"
set_env GIT_CONFIG_VALUE_0 "!$WRAPPED cred" || log "ERROR: failed to set GIT_CONFIG_VALUE_0"
set_env GIT_CONFIG_KEY_1 "user.name" || log "ERROR: failed to set GIT_CONFIG_KEY_1"
set_env GIT_CONFIG_VALUE_1 "${APP_SLUG}[bot]" || log "ERROR: failed to set GIT_CONFIG_VALUE_1"
set_env GIT_CONFIG_KEY_2 "user.email" || log "ERROR: failed to set GIT_CONFIG_KEY_2"
set_env GIT_CONFIG_VALUE_2 "${APP_ID}+${APP_SLUG}[bot]@users.noreply.github.com" \
  || log "ERROR: failed to set GIT_CONFIG_VALUE_2"

# Sanity-check the wrapper exists; fail-soft otherwise (the image bake
# is the source of truth for /usr/local/bin/vs-github-identity).
if [ ! -x "$WRAPPED" ]; then
  log "WARN: $WRAPPED missing or not executable — git credential asks will fail until the image bakes it (see /opt/vs/docs/vs-github.md)"
fi

log "done: git writes will authenticate as ${APP_SLUG}[bot] via mint-on-demand tokens"
exit 0