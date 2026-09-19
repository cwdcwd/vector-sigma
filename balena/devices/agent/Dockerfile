# Vector Sigma devices-fleet: agent runtime placeholder image.
#
# Placeholder on purpose: the real agent runtime is fleet-specific wiring
# that lives outside this repo (per the engineering spec, this repo names
# no agents or deployments). Swap the base image + command in a fleet PR
# when the real runtime is chosen — gate.sh stays.
#
# node:22-bookworm-slim is a multi-arch official image; balena remote
# builders pull the aarch64 variant for the raspberrypi4-64 fleet.
FROM node:22-bookworm-slim

WORKDIR /app

# Data-volume mountpoint: a fresh named volume seeds ownership from the
# image path (root-owned otherwise). Owned by uid/gid 1000 — the same
# uid/gid the registrant image runs as — so the shared volume is
# writable by whichever container mounts it first.
#
# The agent process itself may run as root (default) — required to read
# the 0600 identity files the registrant writes (see runbook). If your
# real runtime hardens to USER node, ensure its process is uid 1000.
RUN mkdir -p /data/agent && chown -R node:node /data/agent

COPY gate.sh /usr/local/bin/gate.sh
RUN chmod 0755 /usr/local/bin/gate.sh

# No identity, no agent: gate.sh polls the ready marker; once present it
# execs the compose `command` (replacing itself — the agent runtime runs
# as PID 1 and receives SIGTERM directly on supervised stop).
ENTRYPOINT ["/usr/local/bin/gate.sh"]