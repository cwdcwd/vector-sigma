#!/bin/sh
# vs-entrypoint.sh — generic VS container entrypoint shim (fleet-ops-f57.13).
#
# Provisions the VS internal CA into Node's trust store, then execs the
# service command. A no-op unless CA variables are set — safe as the
# ENTRYPOINT for every service in the deploy/ image (registrar, seed,
# device) and the balena devices registrant image.
#
# Why an image-carried shim (the litellm-init pattern): the balena
# supervisor does no compose interpolation and cannot run shell pipelines,
# so the base64 decode MUST happen inside the container. Plain docker
# compose runs the identical bytes. No per-side escaping fork.
#
# Inputs (environment — all optional; the REGISTRANT enforces the
# https-with-CA contract separately, fail-loud at its config layer):
#   VS_CA_CERT_B64    base64 (single line, -w0) of the VS internal CA cert
#                     PEM — decoded to /tmp/vs-ca.pem and pointed at
#   VS_CA_CERT        path to a CA cert PEM already in the image (a baked
#                     CA — alternative to the variable; takes precedence
#                     over the decode when both are set)
#   Both unset        shim execs through with no trust changes.
#
# The CA CERT is public material (not a secret — never the CA KEY, which
# is owner-custodied and never in any image or variable).

set -eu

if [ -n "${VS_CA_CERT:-}" ]; then
  if [ ! -f "$VS_CA_CERT" ]; then
    echo "vs-entrypoint: VS_CA_CERT is set but the file does not exist: $VS_CA_CERT" >&2
    exit 1
  fi
  export NODE_EXTRA_CA_CERTS="$VS_CA_CERT"
  echo "vs-entrypoint: NODE_EXTRA_CA_CERTS=$VS_CA_CERT (baked CA)"
elif [ -n "${VS_CA_CERT_B64:-}" ]; then
  echo "$VS_CA_CERT_B64" | base64 -d > /tmp/vs-ca.pem 2>/dev/null || {
    echo "vs-entrypoint: VS_CA_CERT_B64 is not valid base64" >&2
    exit 1
  }
  grep -q "BEGIN CERTIFICATE" /tmp/vs-ca.pem || {
    echo "vs-entrypoint: decoded VS_CA_CERT_B64 is not a PEM certificate" >&2
    exit 1
  }
  chmod 600 /tmp/vs-ca.pem
  export NODE_EXTRA_CA_CERTS=/tmp/vs-ca.pem
  echo "vs-entrypoint: NODE_EXTRA_CA_CERTS=/tmp/vs-ca.pem (decoded from VS_CA_CERT_B64)"
fi

exec "$@"