#!/bin/sh
# Vector Sigma agent entrypoint gate.
#
# Blocks until the registrant has delivered identity to the shared data
# volume (ready.marker present), then execs the compose command as
# PID 1 so the runtime receives SIGTERM directly (supervised-stop
# evidence standard: runtime traps SIGTERM, flushes WAL, exits clean).
#
# Exits 1 after the poll budget expires so the supervisor reports the
# container as failed rather than silently looping forever — an
# unprovisioned device shows agent Exited in the dashboard, not
# "Running" with nothing inside.
set -eu

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

# Hand over: the agent runtime becomes PID 1 under this entrypoint.
exec "$@"