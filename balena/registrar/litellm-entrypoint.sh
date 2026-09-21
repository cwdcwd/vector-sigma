#!/bin/sh
# litellm-entrypoint.sh — assembles DATABASE_URL from parts, then execs the
# stock LiteLLM entrypoint (fleet-ops-f57.12).
#
# Why a shim at all: the balena supervisor does NO compose interpolation, so
# it cannot build postgres://litellm:***@postgres:5432/litellm from parts —
# the owner would have to paste a whole URL that can silently disagree with
# the role password the litellm-init service creates (the f57.8 trap). This
# shim takes the SAME structural parts the init service provisions from, so
# the URL and the role can never disagree.
#
# Inputs (structural parts come from the compose environment; the password is
# a balenaCloud fleet variable on the device, .env in self-host):
#   LITELLM_PG_USER      default litellm
#   LITELLM_PG_PASSWORD  REQUIRED — no default, fail loud
#   LITELLM_PG_HOST      default postgres (compose service name)
#   LITELLM_PG_PORT      default 5432
#   LITELLM_PG_DB        default litellm
#   DATABASE_URL         optional whole-URL override (wins over parts, same
#                        override semantics as the registrar's config)
#
# Fail-loud per the fleet's boot-config convention: missing password aborts
# startup naming the variable — no fallback, no silent default secret.

set -eu

: "${LITELLM_PG_PASSWORD:?LITELLM_PG_PASSWORD is required (balena fleet variable / deploy/.env). LiteLLM cannot reach its database without it; there is no default.}"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "litellm-entrypoint: DATABASE_URL override set — using it as-is" >&2
else
  PG_USER="${LITELLM_PG_USER:-litellm}"
  PG_HOST="${LITELLM_PG_HOST:-postgres}"
  PG_PORT="${LITELLM_PG_PORT:-5432}"
  PG_DB="${LITELLM_PG_DB:-litellm}"
  export DATABASE_URL="postgres://${PG_USER}:${LITELLM_PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}"
  echo "litellm-entrypoint: DATABASE_URL assembled from parts (user=${PG_USER} host=${PG_HOST} port=${PG_PORT} db=${PG_DB})" >&2
fi

# Re-exec the stock entrypoint (docker/prod_entrypoint.sh on the base image)
# with our CMD; it execs `litellm "$@"` (or ddtrace-run when USE_DDTRACE=true).
exec docker/prod_entrypoint.sh "$@"