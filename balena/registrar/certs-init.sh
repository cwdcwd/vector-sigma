#!/bin/sh
# certs-init.sh — one-shot TLS material provisioning for the caddy edge
# (fleet-ops-f57.13). Decodes the owner-set TLS_CERT_B64 / TLS_KEY_B64
# fleet variables (or .env values, on the deploy/ self-host side) into the
# shared caddy-certs volume as PEM files caddy serves.
#
# Why an image-carried script (the litellm-init pattern): the balena
# supervisor does NO compose interpolation, so the decode must run inside
# the container against the environment the supervisor injects; the same
# bytes serve plain docker compose identically. No twin drift.
#
# Idempotent + rotation-safe: rewrites the PEMs on every run, so rotating
# the leaf = update the two fleet variables + restart (certs-init + caddy
# both restart; the volume keeps nothing stale).
#
# Inputs (environment — fail-loud, no defaults for the secrets):
#   TLS_CERT_B64  REQUIRED — base64 (single line, -w0) of the leaf cert PEM
#   TLS_KEY_B64   REQUIRED — base64 (single line, -w0) of the leaf key PEM
#   CERTS_DIR     default /certs — the shared caddy-certs volume mountpoint

set -eu

CERTS_DIR="${CERTS_DIR:-/certs}"

if [ -z "${TLS_CERT_B64:-}" ]; then
  echo "certs-init: TLS_CERT_B64 is required (balena fleet variable / deploy/.env) — no default" >&2
  exit 1
fi
if [ -z "${TLS_KEY_B64:-}" ]; then
  echo "certs-init: TLS_KEY_B64 is required (balena fleet variable / deploy/.env) — no default" >&2
  exit 1
fi

mkdir -p "$CERTS_DIR"

# Decode; verify the bytes are a real PEM on the way in (fail loud on a
# truncated paste — the dashboard editor is the usual culprit).
echo "$TLS_CERT_B64" | base64 -d > "$CERTS_DIR/tls.crt" 2>/dev/null || {
  echo "certs-init: TLS_CERT_B64 is not valid base64" >&2
  exit 1
}
echo "$TLS_KEY_B64" | base64 -d > "$CERTS_DIR/tls.key" 2>/dev/null || {
  echo "certs-init: TLS_KEY_B64 is not valid base64" >&2
  exit 1
}

grep -q "BEGIN CERTIFICATE" "$CERTS_DIR/tls.crt" || {
  echo "certs-init: decoded TLS_CERT_B64 is not a PEM certificate (no BEGIN CERTIFICATE)" >&2
  exit 1
}
grep -qE "BEGIN (EC |RSA )?PRIVATE KEY|BEGIN PRIVATE KEY" "$CERTS_DIR/tls.key" || {
  echo "certs-init: decoded TLS_KEY_B64 is not a PEM private key" >&2
  exit 1
}

chmod 600 "$CERTS_DIR/tls.crt" "$CERTS_DIR/tls.key"

echo "certs-init: TLS material provisioned at $CERTS_DIR (leaf cert + key)"