#!/bin/sh
# litellm-init.sh — one-shot provisioning of the VS gateway's database
# (fleet-ops-f57.12). Runs as its own compose service before LiteLLM starts;
# idempotent, safe on every boot AND on existing volumes (the master device's
# pgdata already holds device bundles — initdb.d cannot run there, which is
# exactly why this service exists).
#
# The script lives in an image (not a compose `command:` string) so BOTH the
# balena supervisor (no variable substitution) and plain docker compose
# (fail-closed ${VAR:?} interpolation) run the identical bytes — no per-side
# escaping fork.
#
# Inputs (environment):
#   PGPASSWORD            superuser password — deploy composes set it via
#                         interpolation; the balena side leaves it unset and
#                         the POSTGRES_PASSWORD fleet var is used instead
#   POSTGRES_PASSWORD     balena fallback path (fleet var lands as env)
#   PGUSER/PGDATABASE     cluster superuser + its database (vsigma on the
#                         device; interpolated in deploy/.env)
#   PGHOST                postgres service name (default: postgres)
#   LITELLM_PG_PASSWORD   REQUIRED — password for the `litellm` role

set -eu

if [ -z "${PGPASSWORD:-}" ] && [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "litellm-init: PGPASSWORD (deploy .env) or POSTGRES_PASSWORD (balena fleet var) is required — no default" >&2
  exit 1
fi
if [ -z "${PGPASSWORD:-}" ]; then
  export PGPASSWORD="$POSTGRES_PASSWORD"
fi
if [ -z "${LITELLM_PG_PASSWORD:-}" ]; then
  echo "litellm-init: LITELLM_PG_PASSWORD is required (balena fleet variable / deploy/.env) — no default" >&2
  exit 1
fi

PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:-vsigma}"
PGDATABASE="${PGDATABASE:-vsigma}"

echo "litellm-init: waiting for postgres at ${PGHOST} (as ${PGUSER})..."
i=0
until pg_isready -h "$PGHOST" -U "$PGUSER" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "litellm-init: postgres never became ready within 120s" >&2
    exit 1
  fi
  sleep 1
done

psql -v ON_ERROR_STOP=1 -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
  -v pw="$LITELLM_PG_PASSWORD" -v dbname="$PGDATABASE" <<'SQL'
-- Idempotent role + database provisioning for the VS gateway (f57.12).
-- CREATE ROLE / CREATE DATABASE cannot run inside DO blocks or functions;
-- the classic idempotent shape is conditional SELECT ... \gexec.
SELECT 'CREATE ROLE litellm LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm')\gexec
-- ALTER on EVERY run: the variable always wins, which kills the pgdata
-- password trap for the litellm role — rotating LITELLM_PG_PASSWORD needs
-- no manual psql step, just a service restart.
ALTER ROLE litellm LOGIN PASSWORD :'pw';
SELECT 'CREATE DATABASE litellm OWNER litellm' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')\gexec
-- Least privilege: the litellm role must reach ONLY its own database.
-- CONNECT is granted to PUBLIC on every database by default, and revoking
-- from litellm alone would be a no-op while PUBLIC holds it — so close the
-- registrar's database to PUBLIC. The vsigma owner-role (and superusers,
-- which bypass it) are unaffected; the postgres image healthcheck uses
-- pg_isready, which completes its handshake before database attachment.
REVOKE CONNECT ON DATABASE :"dbname" FROM PUBLIC;
SQL

echo "litellm-init: litellm role + database ready"