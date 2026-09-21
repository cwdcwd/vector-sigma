#!/bin/sh
# caddy-entrypoint.sh — waits for the TLS pair on the certs volume, then
# execs the stock caddy entrypoint (fleet-ops-f57.13).
#
# Why the wait: compose/balena start caddy and certs-init concurrently;
# caddy fails fast on a missing cert file. Rather than restart-looping,
# this shim polls for the pair (certs-init is a bounded one-shot; if it
# fails, the supervisor restarts THIS service and the retry loop closes
# the gap — same posture as the litellm boot sequence).
#
# Inputs (environment):
#   CERTS_DIR  default /certs — the shared caddy-certs volume mountpoint

set -eu

CERTS_DIR="${CERTS_DIR:-/certs}"

i=0
until [ -f "$CERTS_DIR/tls.crt" ] && [ -f "$CERTS_DIR/tls.key" ]; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "caddy-entrypoint: TLS material never appeared at $CERTS_DIR within 120s — check the certs-init service logs (TLS_CERT_B64 / TLS_KEY_B64 fleet vars)" >&2
    exit 1
  fi
  sleep 1
done

echo "caddy-entrypoint: TLS pair present at $CERTS_DIR — starting caddy"

# Re-exec the stock entrypoint (caddy:2-alpine ships ENTRYPOINT ["caddy"];
# our CMD from the Dockerfile rides through "$@").
exec "$@"