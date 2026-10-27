#!/bin/sh
# AgentCore invocation shim entry (fleet-ops-1py55.3; AC 0007 stage 3).
#
# The gate's env switch (AGENTCORE_HTTP in images/agent/gate.sh) execs
# THIS instead of the official entrypoint dispatcher. It validates the
# runtime has a python3 (fail-loud: the shim cannot serve without it),
# warns when the CLI is absent (invocations would fail with a clear
# error until the runtime is correctly baked) and execs the stdlib HTTP
# listener with the AWS contract port.
#
# It never reads identity, never touches the ready.marker, never seeds
# config: the agent runtime environment (model route, gateway key+URL,
# A2A identity) passes through the environment UNCHANGED - the
# AgentCore-side identity delivery is the migration plan's stage
# (platforms/agentcore/MIGRATION-PLAN.md). No /init, no s6, no cont-init
# hooks in this mode: the listener IS the runtime's PID 1 and the HTTP
# surface is its only contract.
#
# The port is AGENTCORE_PORT (namespaced on purpose - never the bare
# PORT), defaulting to the contract's 8080.
#
# Sources keep the repo's 0600 working-tree mask; the Dockerfile bakes
# this file and chmods ONLY it 0755 (the Python listener is exec'd BY
# python3 and needs no +x).
set -eu

if ! command -v python3 >/dev/null 2>&1; then
  echo "[agentcore] python3 not found; the invocation shim cannot start" >&2
  exit 1
fi
if ! command -v hermes >/dev/null 2>&1; then
  echo "[agentcore] WARNING: hermes not on PATH; invocations will fail loudly until the runtime is baked correctly" >&2
fi

echo "[agentcore] invocation shim on 0.0.0.0:${AGENTCORE_PORT:-8080}; base command: ${AGENTCORE_COMMAND:-hermes chat}"
exec python3 "${AGENTCORE_LISTENER_PATH:-/usr/local/bin/agentcore/agentcore-listener.py}" --port "${AGENTCORE_PORT:-8080}"
