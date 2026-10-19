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