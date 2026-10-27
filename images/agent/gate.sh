#!/bin/sh
# Vector Sigma agent identity gate (fleet-ops-j7g.1 runtime swap).
#
# Blocks until the registrant has delivered identity to the shared data
# volume (ready.marker present), then hands control to the OFFICIAL
# image entrypoint dispatcher (/opt/hermes/docker/entrypoint-dispatch.sh
# -> s6 /init -> cont-init.d -> main-wrapper -> CMD) so the runtime
# boots through the image's own bootstrap chain — stage2 UID remap +
# config seed, the 04-vs-a2a-wiring mesh hook, then `gateway run`.
#
# The gate itself runs as PID 1 (balena execs the ENTRYPOINT as PID 1);
# it execs the dispatcher, replacing itself — the s6 tree inherits the
# supervision contract and SIGTERM flows to it directly on supervised
# stop (the WAL-flush contract the placeholder's exec carried).
#
# Exits 1 after the poll budget expires so the supervisor reports the
# container as failed rather than silently looping forever — an
# unprovisioned device shows agent Exited in the dashboard, not
# "Running" with nothing inside.
set -eu

# ── The AgentCore platform switch (AC 0007 stage 3, fleet-ops-1py.55.3) ────
# The AWS Bedrock AgentCore HTTP listener (POSIX sh entry + python3
# stdlib server, baked at /usr/local/bin/agentcore/) REPLACES the
# gateway runtime when the platform env is set: with the switch on, the
# listener is the runtime's PID 1 and serves the HTTP invocation
# contract (POST /invocations + GET /ping on 0.0.0.0:8080 — the shim's
# header carries the contract and its sources). NO identity gate in
# this mode: the marker the platform never writes would be a false
# never-start, and AgentCore-side identity delivery is the migration
# plan's stage (platforms/agentcore/MIGRATION-PLAN.md), not the gate's.
# Default OFF — one artifact, unchanged compose/balena boot: unset (or
# false) falls through to the identity gate + the official dispatcher
# exactly as before this stanza existed.
ac_http="$(printf %s "${AGENTCORE_HTTP:-0}" | tr '[:upper:]' '[:lower:]')"
case "$ac_http" in
  1|true|yes|on)
    if ! command -v python3 >/dev/null 2>&1; then
      echo "[gate] AGENTCORE_HTTP=$AGENTCORE_HTTP but python3 is missing; cannot serve the AgentCore invocation contract" >&2
      exit 1
    fi
    echo "[gate] AGENTCORE_HTTP=$AGENTCORE_HTTP; serving the AgentCore invocation shim (HTTP contract on 0.0.0.0:${AGENTCORE_PORT:-8080})"
    exec /bin/sh "${AGENTCORE_ENTRYPOINT_DIR:-/usr/local/bin/agentcore}/agentcore-listener.sh"
    ;;
esac
unset ac_http

MARKER=/data/agent/ready.marker
# Poll budget: ~30 min at 2s interval — long enough for clock-gate +
# bootstrap + 425 retry cycles on a cold device; short enough to
# surface a misconfigured device within an hour. Env-defaultable for
# per-device tuning via balena variables.
POLL_INTERVAL="${POLL_INTERVAL:-2}"
POLL_BUDGET="${POLL_BUDGET:-900}"

elapsed=0
until test -f "$MARKER"; do
  if test "$elapsed" -ge "$POLL_BUDGET"; then
    echo "[gate] ready marker $MARKER not present after ${POLL_BUDGET}s; agent will not start (device not provisioned?)" >&2
    exit 1
  fi
  echo "[gate] waiting for identity (ready.marker) at $MARKER"
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

version="$(cat "$MARKER" 2>/dev/null || true)"
echo "[gate] identity present ${version:+($version)}; starting agent runtime"

# Hand over to the official image entrypoint: the dispatcher runs
# /init (PID-1-safe — the gate execs it, so it STAYS PID 1) and the
# full cont-init chain, including the A2A mesh wiring hook, runs before
# the compose CMD (`gateway run`).
exec /opt/hermes/docker/entrypoint-dispatch.sh "$@"