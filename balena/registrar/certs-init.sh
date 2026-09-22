#!/bin/sh
# certs-init.sh — one-shot TLS material provisioning for the caddy edge
# (fleet-ops-f57.13). Decodes the owner-set TLS_CERT_B64 / TLS_KEY_B64
# fleet variables (or .env values, on the deploy/ self-host side) into the
# shared caddy-certs volume as PEM files caddy serves.
#
# Why an image-carried script (the litellm-init pattern): the balena
# supervisor does NO compose interpolation, so the decode must run inside
# the container against the environment the supervisor injects; the same
# The base is alpine WITH openssl (see Dockerfile.certs-init) — the script
# validates the decoded pair (x509/rsa modulus match) before publishing,
# so nothing needs node.
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

# Decode into temporaries, validate BOTH objects and the pair's moduli
# match, then publish atomically (Copilot f57.13 review: never let a
# truncated / mismatched paste reach caddy as "provisioned"). cert/key
# write ordering: temp-validate first, then rename both into place, then
# the .ready marker LAST — the marker is what caddy waits on, so a
# half-published pair can never be observed.
CRT_TMP="$CERTS_DIR/.tls.crt.tmp"
KEY_TMP="$CERTS_DIR/.tls.key.tmp"
echo "$TLS_CERT_B64" | base64 -d > "$CRT_TMP" 2>/dev/null || {
  echo "certs-init: TLS_CERT_B64 is not valid base64" >&2
  exit 1
}
echo "$TLS_KEY_B64" | base64 -d > "$KEY_TMP" 2>/dev/null || {
  echo "certs-init: TLS_KEY_B64 is not valid base64" >&2
  exit 1
}

grep -q "BEGIN CERTIFICATE" "$CRT_TMP" || {
  echo "certs-init: decoded TLS_CERT_B64 is not a PEM certificate (no BEGIN CERTIFICATE)" >&2
  exit 1
}
grep -qE "BEGIN (EC |RSA )?PRIVATE KEY|BEGIN PRIVATE KEY" "$KEY_TMP" || {
  echo "certs-init: decoded TLS_KEY_B64 is not a PEM private key" >&2
  exit 1
}

# Pairing check: the certificate's and the key's public-key moduli must
# match — a cert pasted with another key's b64 fails HERE, not as a caddy
# restart loop in production.
if ! openssl x509 -in "$CRT_TMP" -noout -modulus 2>/dev/null \
     | openssl md5 > "$CRT_TMP.modulus" \
   || ! openssl rsa -in "$KEY_TMP" -noout -modulus 2>/dev/null \
     | openssl md5 > "$KEY_TMP.modulus"; then
  echo "certs-init: cert/key are not parseable by openssl (x509/rsa modulus read failed)" >&2
  exit 1
fi
if ! cmp -s "$CRT_TMP.modulus" "$KEY_TMP.modulus"; then
  echo "certs-init: TLS_CERT_B64 and TLS_KEY_B64 do not form a pair (modulus mismatch)" >&2
  exit 1
fi
rm -f "$CRT_TMP.modulus" "$KEY_TMP.modulus"

# All checks green — publish the pair atomically, then the readiness
# marker. The marker carries the generation's fingerprint (both moduli
# hashes) so caddy-side tooling can detect rotation.
mv -f "$CRT_TMP" "$CERTS_DIR/tls.crt"
mv -f "$KEY_TMP" "$CERTS_DIR/tls.key"
chmod 600 "$CERTS_DIR/tls.crt" "$CERTS_DIR/tls.key"
openssl x509 -in "$CERTS_DIR/tls.crt" -noout -modulus 2>/dev/null | openssl md5 \
  | tr -d '\n' > "$CERTS_DIR/.ready"

echo "certs-init: TLS material provisioned and pair-validated at $CERTS_DIR (leaf cert + key)"