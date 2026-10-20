#!/usr/bin/env bash
# scripts/release-smoke.sh — boot-path smoke gate for release images
# (fleet-ops-1py.7 rung 2). Runs on the CI runner AFTER the image build,
# against the GHCR multi-arch tags, BEFORE balena deploy creates the release.
#
# WHAT IT PROVES: each VS-built release image carries the deterministic
# boot-path bytes the fleet's contract tests pin — entrypoint wrappers baked
# and executable, fail-loud env gates present, cont-init hooks at their
# pinned paths, bd at the fleet-pinned version, multi-arch indexes carrying
# both platforms. It does NOT run the compose E2E (that stays source-build
# per the owner's Q5 ruling) and does NOT probe balena (the fleet advance
# is the canary's job).
#
# Usage (repo root, docker-capable host, GHCR-logged-in):
#   scripts/release-smoke.sh <owner/repo> <full-40-char-sha> <app>
#     app = registrar | devices
#
# FAIL-LOUD: any missing assertion fails the run (exit 1) with the component
# named. A release that cannot pass this gate cannot be cut.
set -euo pipefail

REGISTRY_NS="${1:?usage: release-smoke.sh <owner/repo> <full-40-char-sha> <app> <records-dir> (legacy tag mode)}"
IMAGE_SHA="${2:?usage: release-smoke.sh <owner/repo> <sha> <app> <records-dir> (legacy tag mode)}"
APP="${3:?usage: release-smoke.sh <owner/repo> <sha> <app> <records-dir> (legacy tag mode)}"
GHCR="ghcr.io/${REGISTRY_NS}"
# r3v digest handoff: 4th arg = directory of promoted-<component>.json
# promotion records (optional). When supplied, every image ref is pinned to
# the record's verified digests; when omitted the legacy <sha>-tag mode runs.
RECORDS_DIR="${4:-}"

# Dockerless mode (SMOKE_DOCKERLESS=1): every DRUN call routes through
# scripts/smoke-docker-shim.mjs, which answers the same docker CLI surface
# against raw GHCR bytes (registry manifests + layer tars materialized to
# a local cache) — the assertions below run UNCHANGED on hosts with no
# docker. Born from review 5480276420 on PR #59: findings 4 and 5 were
# assertions that could never pass against a healthy image, invisible
# until the list actually ran against real image bytes.
# Normal mode: docker directly, or via the docker group where the ambient
# shell lacks membership (CI runners run docker natively; the local gate
# wraps via sg docker -c).
if [ "${SMOKE_DOCKERLESS:-0}" = "1" ]; then
  DRUN() { node "${0%/*}/smoke-docker-shim.mjs" "$@"; }
  if [ -n "$RECORDS_DIR" ]; then
    printf '[smoke] FAIL dockerless+records — digest-pinned records mode requires the docker path (the shim speaks tag refs only)\n' >&2
    exit 1
  fi
elif docker version >/dev/null 2>&1; then
  DRUN() { docker "$@"; }
else
  DRUN() { sg docker -c "docker $*"; }
fi

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '[smoke] PASS %s — %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL+1)); printf '[smoke] FAIL %s — %s\n' "$1" "$2"; }

note() { printf '[smoke] %s\n' "$*"; }

# expect_file <label> <image> <path>
expect_file() {
  local label="$1" image="$2" target="$3"
  if DRUN run --rm --entrypoint sh "$image" -c "test -f '$target'" >/dev/null 2>&1; then
    pass "$label" "$target present in ${image##*/}"
  else
    fail "$label" "$target MISSING in ${image##*/}"
  fi
}

# expect_grep <label> <image> <sh-command> <literal-string>
#   Runs the command inside the image; asserts the string appears in output.
expect_grep() {
  local label="$1" image="$2" cmd="$3" want="$4"
  local out rc
  out="$(DRUN run --rm --entrypoint sh "$image" -c "$cmd" 2>&1)" || rc=$?
  if printf '%s' "$out" | grep -qF "$want"; then
    pass "$label" "output contains: $want"
  else
    fail "$label" "missing: $want (rc=${rc:-0}, out: $(printf '%s' "$out" | head -1))"
  fi
}

# expect_version <label> <image> <path-to-binary> <expected-version-string>
expect_version() {
  local label="$1" image="$2" bin="$3" want="$4"
  local out
  out="$(DRUN run --rm --entrypoint sh "$image" -c "'$bin' --version" 2>&1)" || true
  if printf '%s' "$out" | grep -qF "$want"; then
    pass "$label" "$bin --version reports $want"
  else
    fail "$label" "$bin --version did not report $want (out: $(printf '%s' "$out" | head -1))"
  fi
}

# ─── promotion-record mode (fleet-ops-r3v digest handoff) ───────────────────
# SMOKE_RECORDS_DIR=<dir of promoted-<component>.json> pins EVERY image ref
# to the digests the exact-byte promote job verified and verify-remote
# re-fetched — the smoke then runs against exactly those bytes, not against
# whatever the mutable <sha> tag resolves to at smoke time. Fail closed: a
# missing or malformed record fails the component (the whole run fails with
# it). Without SMOKE_RECORDS_DIR the behavior is unchanged (tag refs), so
# local dockerless smoke runs stay independent of promotion records.
declare -A REC_ARM=() REC_IDX=()
rec_digests() {
  local component="$1"
  if [ -n "${REC_ARM[$component]:-}" ]; then return 0; fi
  local rec="$RECORDS_DIR/promoted-${component}.json"
  if [ ! -f "$rec" ]; then
    fail "promotion record ${component}" "MISSING: $rec"
    return 1
  fi
  local line
  line="$(node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const sha=(d)=>typeof d==="string"&&/^sha256:[0-9a-f]{64}$/.test(d);
const arm=(r.perPlatform||[]).find(p=>p&&p.platform==="linux/arm64")?.digest;
const idx=r.index&&r.index.digest;
if(!sha(arm)||!sha(idx)){console.error("malformed promotion record "+process.argv[1]);process.exit(1);}
console.log(arm+" "+idx);
' "$rec" 2>/dev/null)" || {
    fail "promotion record ${component}" "malformed (missing/malformed arm64 or index digest): $rec"
    return 1
  }
  REC_ARM[$component]="${line%% *}"
  REC_IDX[$component]="${line##* }"
}

# IMG <component> — image ref for byte-level assertions (runs the CHILD).
IMG() {
  local component="$1"
  if [ -z "$RECORDS_DIR" ]; then
    printf '%s:%s' "$GHCR/$component" "$IMAGE_SHA"
    return 0
  fi
  rec_digests "$component" || return 1
  printf '%s@%s' "$GHCR/$component" "${REC_ARM[$component]}"
}

# IDXREF <component> — index ref for the multi-arch manifest assertion.
IDXREF() {
  local component="$1"
  if [ -z "$RECORDS_DIR" ]; then
    printf '%s:%s' "$GHCR/$component" "$IMAGE_SHA"
    return 0
  fi
  rec_digests "$component" || return 1
  printf '%s@%s' "$GHCR/$component" "${REC_IDX[$component]}"
}

# smoke_manifest <component>
smoke_manifest() {
  local component="$1" out
  out="$(DRUN buildx imagetools inspect "$(IDXREF "$component")" 2>&1)" || {
    fail "manifest $component" "index inspect failed: $(printf '%s' "$out" | head -1)"
    return 0
  }
  if printf '%s' "$out" | grep -q 'linux/arm64'; then
    pass "manifest $component" "multi-arch index carries linux/arm64"
  else
    fail "manifest $component" "no linux/arm64 child in index"
  fi
  if printf '%s' "$out" | grep -q 'linux/amd64'; then
    pass "manifest $component" "multi-arch index carries linux/amd64"
  else
    fail "manifest $component" "no linux/amd64 child in index"
  fi
}

note "release smoke: ns=$GHCR sha=$IMAGE_SHA app=$APP"

case "$APP" in
  registrar)
    for c in registrar registrant scotty hermes postgres litellm tailscale; do
      smoke_manifest "$c"
    done

    # postgres: wrapper baked + fail-loud + provisioning SQL
    expect_file  "postgres wrapper baked"  "$(IMG postgres)" /usr/local/bin/postgres-wrapper.sh
    expect_grep  "postgres wrapper fail-loud" "$(IMG postgres)" \
      "grep -c 'LITELLM_PG_PASSWORD is required' /usr/local/bin/postgres-wrapper.sh" "1"
    expect_grep  "postgres provisioning SQL" "$(IMG postgres)" \
      "grep -c 'CREATE ROLE litellm LOGIN' /usr/local/bin/postgres-wrapper.sh" "1"

    # registrar: built output + fail-loud config path reachable
    expect_file  "registrar dist" "$(IMG registrar)" /app/registrar/dist/index.js
    expect_file  "registrar drizzle" "$(IMG registrar)" /app/registrar/drizzle/0000_yielding_morlun.sql
    # Fail-loud proof: importing the config module is NOT enough — loadConfig
    # is exported, never invoked at module scope (review finding 4 on PR #59),
    # so a healthy image would import cleanly and print nothing. Invoke the
    # function itself: an env-barren container fails loadConfig() exactly as
    # the real boot does (index.ts calls it inside main()).
    expect_grep  "registrar fail-loud config" "$(IMG registrar)" \
      "node -e 'try{require(\"/app/registrar/dist/config.js\").loadConfig()}catch(e){console.log(e.message)}' 2>&1 | head -2" "invalid registrar configuration"

    # litellm: config + entrypoint shim baked
    expect_file  "litellm config baked"   "$(IMG litellm)" /app/config.yaml
    expect_file  "litellm entrypoint baked" "$(IMG litellm)" /app/litellm-entrypoint.sh
    expect_grep  "litellm fail-loud" "$(IMG litellm)" \
      "grep 'LITELLM_PG_PASSWORD is required' /app/litellm-entrypoint.sh" "LITELLM_PG_PASSWORD is required"

    # scotty: bd read-only two-layer posture + standalone server
    expect_file  "scotty bd wrapper"  "$(IMG scotty)" /usr/local/bin/bd
    expect_file  "scotty bd.real"     "$(IMG scotty)" /usr/local/bin/bd.real
    expect_file  "scotty server.js"   "$(IMG scotty)" /app/server.js
    expect_version "scotty bd pin" "$(IMG scotty)" /usr/local/bin/bd "1.2.2"

    # hermes (primus): bd + queue join + docs + all four cont-init hooks
    expect_file  "hermes bd"          "$(IMG hermes)" /usr/local/bin/bd
    expect_version "hermes bd pin" "$(IMG hermes)" /usr/local/bin/bd "1.2.2"
    expect_file  "hermes queue-join"  "$(IMG hermes)" /opt/vs/queue-join/.beads/metadata.json
    expect_file  "hermes docs"        "$(IMG hermes)" /opt/vs/docs/queue-conventions.md
    expect_file  "hermes hook 03"     "$(IMG hermes)" /etc/cont-init.d/03-vs-queue-join
    expect_file  "hermes hook 04"     "$(IMG hermes)" /etc/cont-init.d/04-vs-a2a-wiring
    expect_file  "hermes hook 05"     "$(IMG hermes)" /etc/cont-init.d/05-vs-github-identity
    expect_file  "hermes hook 06"     "$(IMG hermes)" /etc/cont-init.d/06-vs-memory-tools

    # registrant: entrypoint + clock-gate epoch
    expect_file  "registrant entrypoint" "$(IMG registrant)" /usr/local/bin/vs-entrypoint.sh
    expect_file  "registrant build-epoch" "$(IMG registrant)" /app/build-epoch
    expect_grep  "registrant fail-loud config" "$(IMG registrant)" \
      "node /app/registrant/dist/index.js 2>&1 | head -3" "invalid registrant configuration"

    # tailscale (master bake): the serve config keys every Web origin on the
    # ${TS_CERT_DOMAIN} placeholder (containerboot fills in the node's own
    # MagicDNS name at runtime; no live FQDN is baked into the public image —
    # image-content-exposure.test.ts). Assert the placeholder, not a name.
    expect_file  "master tailscale serve config" "$(IMG tailscale)" /serve-config.json
    expect_grep  "master serve config names" "$(IMG tailscale)" \
      "cat /serve-config.json" '${TS_CERT_DOMAIN}:443'
    ;;
  devices)
    for c in agent registrant tailscale-devices; do
      smoke_manifest "$c"
    done
    # cross-bake parity check: the master's tailscale component must exist too
    smoke_manifest tailscale

    # agent: gate + bd + hooks + docs + plugin
    expect_file  "agent gate"      "$(IMG agent)" /usr/local/bin/gate.sh
    # Presence, not count: gate.sh legitimately contains ready.marker on four
    # lines (comment, MARKER= assignment, poll message, timeout message) —
    # review finding 5 on PR #59: a count-based assertion fails a HEALTHY
    # image. The matched lines print the needle itself; an absent marker
    # exits 1 with no output, failing on both axes. POLL_BUDGET below is
    # genuinely 1 and keeps the count shape.
    expect_grep  "agent gate marker" "$(IMG agent)" \
      "grep 'ready.marker' /usr/local/bin/gate.sh" "ready.marker"
    expect_grep  "agent gate budget" "$(IMG agent)" \
      "grep -c 'POLL_BUDGET:-900' /usr/local/bin/gate.sh" "1"
    expect_file  "agent bd"        "$(IMG agent)" /usr/local/bin/bd
    expect_version "agent bd pin" "$(IMG agent)" /usr/local/bin/bd "1.2.2"
    expect_file  "agent hook 04"   "$(IMG agent)" /etc/cont-init.d/04-vs-a2a-wiring
    expect_file  "agent hook 05"   "$(IMG agent)" /etc/cont-init.d/05-vs-github-identity
    expect_file  "agent hook 06"   "$(IMG agent)" /etc/cont-init.d/06-vs-memory-tools
    expect_file  "agent docs"      "$(IMG agent)" /opt/vs/docs/device-environment.md
    expect_file  "agent plugin"    "$(IMG agent)" /opt/vs/gateway-memory/plugin.yaml
    expect_file  "agent identity wrapper" "$(IMG agent)" /usr/local/bin/vs-github-identity

    # registrant (shared image with the master's registrant-own): entrypoint + epoch
    expect_file  "registrant entrypoint" "$(IMG registrant)" /usr/local/bin/vs-entrypoint.sh
    expect_file  "registrant build-epoch" "$(IMG registrant)" /app/build-epoch
    expect_grep  "registrant fail-loud config" "$(IMG registrant)" \
      "node /app/registrant/dist/index.js 2>&1 | head -3" "invalid registrant configuration"

    # tailscale (devices bake): the ${TS_CERT_DOMAIN} placeholder config
    expect_file  "devices tailscale serve config" "$(IMG tailscale-devices)" /serve-config.json
    expect_grep  "devices serve config placeholder" "$(IMG tailscale-devices)" \
      "cat /serve-config.json" '${TS_CERT_DOMAIN}'
    ;;
  *)
    printf 'unknown app %s\n' "$APP" >&2
    exit 1
    ;;
esac

note "smoke complete: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
