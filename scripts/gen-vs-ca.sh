#!/bin/bash
# scripts/gen-vs-ca.sh — VS-own internal CA + leaf certificate generation
# (fleet-ops-f57.13). OWNER-RUN on a trusted host; the CA key is generated
# into the current working directory and NEVER leaves it (never in the repo,
# never in an image layer, never in a chat — see docs/tls-runbook.md).
#
# Mirrors the Cabal's window-driven 30d/180d pattern (ai_lan_tls_check):
#   CA certificate : 180 days
#   Leaf (server)  : 30 days, SAN = the master device hostname
#
# Usage:
#   scripts/gen-vs-ca.sh <fqdn> [outdir]
#
#   fqdn   the master device hostname (the DNS record the owner adds in
#          Pi-hole, e.g. vsigma.lan -> master device LAN IP). Becomes the
#          leaf cert's CN + SAN; devices set REGISTRAR_URL=https://<fqdn>.
#   outdir directory for the generated material (default: ./vs-tls)
#
# Output (outdir):
#   vs-ca.key / vs-ca.crt        the internal CA — owner-custodied, 600
#   vs-leaf.key / vs-leaf.crt    the server pair caddy serves — 600
#   vs-leaf.csr                  CSR (regenerated each run; not secret)
#   vs-leaf-chain.crt            leaf + CA chain (what some clients want)
#   b64-cert.env                 TLS_CERT_B64=... / TLS_KEY_B64=... lines,
#                                ready to paste into balenaCloud fleet
#                                variables (single-line, dashboard-safe)
#
# Idempotent on the CA: if vs-ca.key already exists in outdir it is reused
# (leaf rotation only — the window-driven renewal path: run the script again
# every ~25d to mint a fresh 30d leaf from the SAME CA). Delete vs-ca.key
# only when you intend to roll the CA (every device must then re-trust).
#
# Fail-loud (f57.8 posture): every openssl step checked; no partial output
# is left silently usable.

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <fqdn> [outdir]" >&2
  exit 64
fi

FQDN="$1"
OUTDIR="${2:-./vs-tls}"
CA_DAYS=180
LEAF_DAYS=30
LEAF_KEY_BITS=2048

command -v openssl >/dev/null 2>&1 || { echo "gen-vs-ca: openssl is required" >&2; exit 1; }

mkdir -p "$OUTDIR"
chmod 700 "$OUTDIR"

fail() { echo "gen-vs-ca: $1" >&2; exit 1; }

# ---- CA (reused if present — window-driven leaf renewal re-runs this script)
if [ ! -f "$OUTDIR/vs-ca.key" ]; then
  echo "gen-vs-ca: minting new internal CA (${CA_DAYS}d) -> $OUTDIR/vs-ca.{key,crt}"
  openssl genrsa -out "$OUTDIR/vs-ca.key" 4096 2>/dev/null \
    || fail "openssl genrsa (CA) failed"
  openssl req -x509 -new -nodes -key "$OUTDIR/vs-ca.key" \
    -sha256 -days "$CA_DAYS" -out "$OUTDIR/vs-ca.crt" \
    -subj "/O=Vector Sigma/CN=Vector Sigma Internal CA" 2>/dev/null \
    || fail "openssl req (CA self-sign) failed"
else
  echo "gen-vs-ca: reusing existing CA at $OUTDIR/vs-ca.key (delete it to roll the CA)"
fi
[ -s "$OUTDIR/vs-ca.key" ] || fail "CA key missing/empty after generation"

# ---- Leaf (minted fresh every run — 30d window)
echo "gen-vs-ca: minting leaf certificate for '$FQDN' (${LEAF_DAYS}d)"
openssl genrsa -out "$OUTDIR/vs-leaf.key" "$LEAF_KEY_BITS" 2>/dev/null \
  || fail "openssl genrsa (leaf) failed"
openssl req -new -key "$OUTDIR/vs-leaf.key" -out "$OUTDIR/vs-leaf.csr" \
  -subj "/O=Vector Sigma/CN=$FQDN" 2>/dev/null \
  || fail "openssl req (leaf CSR) failed"

# SAN extfile: the FQDN itself (the record devices resolve). If the owner
# ever fronts additional hostnames, extend this file — never the CLI args.
cat > "$OUTDIR/vs-leaf.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names
[alt_names]
DNS.1=$FQDN
EOF
openssl x509 -req -in "$OUTDIR/vs-leaf.csr" \
  -CA "$OUTDIR/vs-ca.crt" -CAkey "$OUTDIR/vs-ca.key" -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile "$OUTDIR/vs-leaf.ext" \
  -out "$OUTDIR/vs-leaf.crt" 2>/dev/null \
  || fail "openssl x509 (leaf sign) failed"

# Chain (leaf + CA) for clients that want the full path.
cat "$OUTDIR/vs-leaf.crt" "$OUTDIR/vs-ca.crt" > "$OUTDIR/vs-leaf-chain.crt"

chmod 600 "$OUTDIR/vs-ca.key" "$OUTDIR/vs-leaf.key"
chmod 644 "$OUTDIR/vs-ca.crt" "$OUTDIR/vs-leaf.crt" "$OUTDIR/vs-leaf-chain.crt"

# ---- Dashboard-ready base64 lines (single-line, paste-safe for the
# balenaCloud fleet-variable editor; also the deploy/.env contract).
# b64_nolen <file>: portable no-newline base64 (Copilot review — GNU's
# `base64 -w0` does not exist on macOS/BSD; every emit below uses this,
# and a failure aborts the script rather than emitting an empty value).
b64_nolen() { base64 "$1" | tr -d '\r\n'; }
b64_nolen "$OUTDIR/vs-leaf.crt" > "$OUTDIR/b64-cert.env.tmp"
echo >> "$OUTDIR/b64-cert.env.tmp"
b64_nolen "$OUTDIR/vs-leaf.key" >> "$OUTDIR/b64-cert.env.tmp"
echo >> "$OUTDIR/b64-cert.env.tmp"
{
  echo "TLS_CERT_B64=$(b64_nolen "$OUTDIR/vs-leaf.crt")"
  echo "TLS_KEY_B64=$(b64_nolen "$OUTDIR/vs-leaf.key")"
  echo "# (also available: VS_CA_CERT_B64=$(b64_nolen "$OUTDIR/vs-ca.crt") for the device trust side)"
} > "$OUTDIR/b64-cert.env"
[ -s "$OUTDIR/b64-cert.env" ] || fail "b64-cert.env emission produced an empty file"
grep -q '^TLS_CERT_B64=..' "$OUTDIR/b64-cert.env" || fail "TLS_CERT_B64 line is empty/malformed — aborting"
grep -q '^TLS_KEY_B64=..' "$OUTDIR/b64-cert.env" || fail "TLS_KEY_B64 line is empty/malformed — aborting"
rm -f "$OUTDIR/b64-cert.env.tmp"

echo "gen-vs-ca: done."
echo
echo "NEXT (owner steps — full runbook docs/tls-runbook.md):"
echo "  1. Custody the CA key: $OUTDIR/vs-ca.key (owner-only, like the Cabal CA)."
echo "  2. Pi-hole DNS: $FQDN -> master device LAN IP."
echo "  3. balenaCloud fleet vars (registrar fleet): paste TLS_CERT_B64 + TLS_KEY_B64"
echo "     from $OUTDIR/b64-cert.env (single lines)."
echo "  4. Device trust: VS_CA_CERT_B64 (or VS_CA_CERT) on the devices fleet —"
echo "     see docs/tls-runbook.md 'Device trust'."
echo "  5. Renewal window: re-run this script ~every 25d (30d leaf / 180d CA; the"
echo "     window-driven ai_lan_tls_check pattern). The CA is reused — only the"
echo "     leaf rotates; update the two fleet vars + restart caddy."