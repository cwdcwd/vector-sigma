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

REGISTRY_NS="${1:?usage: release-smoke.sh <owner/repo> <sha> <app>}"
IMAGE_SHA="${2:?usage: release-smoke.sh <owner/repo> <sha> <app>}"
APP="${3:?usage: release-smoke.sh <owner/repo> <sha> <app>}"
GHCR="ghcr.io/${REGISTRY_NS}"

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

# smoke_manifest <component>
smoke_manifest() {
  local component="$1" out
  out="$(DRUN buildx imagetools inspect "$GHCR/$component:$IMAGE_SHA" 2>&1)" || {
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
    expect_file  "postgres wrapper baked"  "$GHCR/postgres:$IMAGE_SHA" /usr/local/bin/postgres-wrapper.sh
    expect_grep  "postgres wrapper fail-loud" "$GHCR/postgres:$IMAGE_SHA" \
      "grep -c 'LITELLM_PG_PASSWORD is required' /usr/local/bin/postgres-wrapper.sh" "1"
    expect_grep  "postgres provisioning SQL" "$GHCR/postgres:$IMAGE_SHA" \
      "grep -c 'CREATE ROLE litellm LOGIN' /usr/local/bin/postgres-wrapper.sh" "1"

    # registrar: built output + fail-loud config path reachable
    expect_file  "registrar dist" "$GHCR/registrar:$IMAGE_SHA" /app/dist/index.js
    expect_file  "registrar drizzle" "$GHCR/registrar:$IMAGE_SHA" /app/drizzle/0000_yielding_morlun.sql
    # Fail-loud proof: importing the config module is NOT enough — loadConfig
    # is exported, never invoked at module scope (review finding 4 on PR #59),
    # so a healthy image would import cleanly and print nothing. Invoke the
    # function itself: an env-barren container fails loadConfig() exactly as
    # the real boot does (index.ts calls it inside main()).
    expect_grep  "registrar fail-loud config" "$GHCR/registrar:$IMAGE_SHA" \
      "node -e 'try{require(\"/app/dist/config.js\").loadConfig()}catch(e){console.log(e.message)}' 2>&1 | head -2" "invalid registrar configuration"

    # litellm: config + entrypoint shim baked
    expect_file  "litellm config baked"   "$GHCR/litellm:$IMAGE_SHA" /app/config.yaml
    expect_file  "litellm entrypoint baked" "$GHCR/litellm:$IMAGE_SHA" /app/litellm-entrypoint.sh
    expect_grep  "litellm fail-loud" "$GHCR/litellm:$IMAGE_SHA" \
      "grep 'LITELLM_PG_PASSWORD is required' /app/litellm-entrypoint.sh" "LITELLM_PG_PASSWORD is required"

    # scotty: bd read-only two-layer posture + standalone server
    expect_file  "scotty bd wrapper"  "$GHCR/scotty:$IMAGE_SHA" /usr/local/bin/bd
    expect_file  "scotty bd.real"     "$GHCR/scotty:$IMAGE_SHA" /usr/local/bin/bd.real
    expect_file  "scotty server.js"   "$GHCR/scotty:$IMAGE_SHA" /app/server.js
    expect_version "scotty bd pin" "$GHCR/scotty:$IMAGE_SHA" /usr/local/bin/bd "1.2.2"

    # hermes (primus): bd + queue join + docs + all four cont-init hooks
    expect_file  "hermes bd"          "$GHCR/hermes:$IMAGE_SHA" /usr/local/bin/bd
    expect_version "hermes bd pin" "$GHCR/hermes:$IMAGE_SHA" /usr/local/bin/bd "1.2.2"
    expect_file  "hermes queue-join"  "$GHCR/hermes:$IMAGE_SHA" /opt/vs/queue-join/.beads/metadata.json
    expect_file  "hermes docs"        "$GHCR/hermes:$IMAGE_SHA" /opt/vs/docs/queue-conventions.md
    expect_file  "hermes hook 03"     "$GHCR/hermes:$IMAGE_SHA" /etc/cont-init.d/03-vs-queue-join
    expect_file  "hermes hook 04"     "$GHCR/hermes:$IMAGE_SHA" /etc/cont-init.d/04-vs-a2a-wiring
    expect_file  "hermes hook 05"     "$GHCR/hermes:$IMAGE_SHA" /etc/cont-init.d/05-vs-github-identity
    expect_file  "hermes hook 06"     "$GHCR/hermes:$IMAGE_SHA" /etc/cont-init.d/06-vs-memory-tools

    # registrant: entrypoint + clock-gate epoch
    expect_file  "registrant entrypoint" "$GHCR/registrant:$IMAGE_SHA" /usr/local/bin/vs-entrypoint.sh
    expect_file  "registrant build-epoch" "$GHCR/registrant:$IMAGE_SHA" /app/build-epoch
    expect_grep  "registrant fail-loud config" "$GHCR/registrant:$IMAGE_SHA" \
      "node /app/dist/index.js 2>&1 | head -3" "invalid registrant configuration"

    # tailscale (master bake): literal MagicDNS serve config
    expect_file  "master tailscale serve config" "$GHCR/tailscale:$IMAGE_SHA" /serve-config.json
    expect_grep  "master serve config names" "$GHCR/tailscale:$IMAGE_SHA" \
      "cat /serve-config.json" "vector-sigma.tailb7207e.ts.net"
    ;;
  devices)
    for c in agent registrant tailscale-devices; do
      smoke_manifest "$c"
    done
    # cross-bake parity check: the master's tailscale component must exist too
    smoke_manifest tailscale

    # agent: gate + bd + hooks + docs + plugin
    expect_file  "agent gate"      "$GHCR/agent:$IMAGE_SHA" /usr/local/bin/gate.sh
    # Presence, not count: gate.sh legitimately contains ready.marker on four
    # lines (comment, MARKER= assignment, poll message, timeout message) —
    # review finding 5 on PR #59: a count-based assertion fails a HEALTHY
    # image. The matched lines print the needle itself; an absent marker
    # exits 1 with no output, failing on both axes. POLL_BUDGET below is
    # genuinely 1 and keeps the count shape.
    expect_grep  "agent gate marker" "$GHCR/agent:$IMAGE_SHA" \
      "grep 'ready.marker' /usr/local/bin/gate.sh" "ready.marker"
    expect_grep  "agent gate budget" "$GHCR/agent:$IMAGE_SHA" \
      "grep -c 'POLL_BUDGET:-900' /usr/local/bin/gate.sh" "1"
    expect_file  "agent bd"        "$GHCR/agent:$IMAGE_SHA" /usr/local/bin/bd
    expect_version "agent bd pin" "$GHCR/agent:$IMAGE_SHA" /usr/local/bin/bd "1.2.2"
    expect_file  "agent hook 04"   "$GHCR/agent:$IMAGE_SHA" /etc/cont-init.d/04-vs-a2a-wiring
    expect_file  "agent hook 05"   "$GHCR/agent:$IMAGE_SHA" /etc/cont-init.d/05-vs-github-identity
    expect_file  "agent hook 06"   "$GHCR/agent:$IMAGE_SHA" /etc/cont-init.d/06-vs-memory-tools
    expect_file  "agent docs"      "$GHCR/agent:$IMAGE_SHA" /opt/vs/docs/device-environment.md
    expect_file  "agent plugin"    "$GHCR/agent:$IMAGE_SHA" /opt/vs/gateway-memory/plugin.yaml
    expect_file  "agent identity wrapper" "$GHCR/agent:$IMAGE_SHA" /usr/local/bin/vs-github-identity

    # registrant (shared image with the master's registrant-own): entrypoint + epoch
    expect_file  "registrant entrypoint" "$GHCR/registrant:$IMAGE_SHA" /usr/local/bin/vs-entrypoint.sh
    expect_file  "registrant build-epoch" "$GHCR/registrant:$IMAGE_SHA" /app/build-epoch
    expect_grep  "registrant fail-loud config" "$GHCR/registrant:$IMAGE_SHA" \
      "node /app/dist/index.js 2>&1 | head -3" "invalid registrant configuration"

    # tailscale (devices bake): the ${TS_CERT_DOMAIN} placeholder config
    expect_file  "devices tailscale serve config" "$GHCR/tailscale-devices:$IMAGE_SHA" /serve-config.json
    expect_grep  "devices serve config placeholder" "$GHCR/tailscale-devices:$IMAGE_SHA" \
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
