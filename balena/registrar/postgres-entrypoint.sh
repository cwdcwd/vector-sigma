#!/bin/sh
# postgres-entrypoint.sh — PID 1 wrapper around the stock postgres entrypoint
# that provisions the VS gateway's database on EVERY boot (fleet-ops-anc,
# the litellm-init consolidation; owner ruling 2026-09-29).
#
# Replaces the old one-shot litellm-init service: the postgres service's
# own image now runs the identical provisioning SQL that service ran, so
# the composition has one fewer container on a resource-strapped device
# and the gateway's role + database exist before anything can race them.
#
# Shape (the only code path — no initdb.d split, because the master
# device's pgdata already holds device bundles and a fresh initdb must
# never run there):
#   (a) start the STOCK docker-entrypoint.sh in the background — the
#       child execs postgres and becomes the server;
#   (b) wait for pg_isready, same 120s budget + fail-loud env contract
#       the old one-shot had;
#   (c) run the provisioning SQL verbatim from litellm-init.sh
#       (CREATE ROLE litellm + CREATE DATABASE litellm + least-privilege
#       REVOKE + ALTER ROLE re-assert every boot — idempotent, safe on
#       the live volume);
#   (d) wait on the child with SIGTERM/SIGINT forwarding. THE GRACEFUL-
#       SHUTDOWN CONTRACT IS A HARD GATE: the wrapper MUST forward the
#       stop signal so postgres checkpoints and flushes WAL inside
#       stop_grace_period 60s — a wrapper that eats the signal gets
#       SIGKILLed at the deadline and corrupts the identity DB.
#
# Inputs (environment) — same contract the one-shot had, plus the
# postgres image's own POSTGRES_* vars which pass straight through:
#   PGPASSWORD            superuser password — deploy composes set it via
#                         interpolation; the balena side leaves it unset and
#                         the POSTGRES_PASSWORD fleet var is used instead
#   POSTGRES_PASSWORD     postgres image var (also the balena fallback path)
#   PGUSER/PGDATABASE    cluster superuser + its database (vsigma on the
#                         device; interpolated in deploy/.env). NOTE: the
#                         postgres image may re-map POSTGRES_USER into
#                         PGUSER itself when PGUSER is unset — the wrapper
#                         reads PGUSER with a POSTGRES_USER fallback.
#   PGHOST                probed host (default: 127.0.0.1 — the wrapper and
#                         postgres share this container; the old one-shot
#                         reached over the compose network by service name)
#   LITELLM_PG_PASSWORD  REQUIRED — password for the `litellm` role

set -eu

# ---- (a) start the stock entrypoint in the background ------------------------
# It execs postgres; the child is the server we babysit. Output goes where
# the container's own stdout/stderr point (docker/balena logs) so
# `docker logs` shows exactly what an unmodified postgres container would.
/usr/local/bin/docker-entrypoint.sh postgres &
child=$!

# ---- (b) wait for readiness -------------------------------------------------
if [ -z "${PGPASSWORD:-}" ] && [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "postgres-wrapper: PGPASSWORD (deploy .env) or POSTGRES_PASSWORD (balena fleet var) is required — no default" >&2
  kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  exit 1
fi
if [ -z "${PGPASSWORD:-}" ]; then
  export PGPASSWORD="$POSTGRES_PASSWORD"
fi
if [ -z "${LITELLM_PG_PASSWORD:-}" ]; then
  echo "postgres-wrapper: LITELLM_PG_PASSWORD is required (balena fleet variable / deploy/.env) — no default" >&2
  kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  exit 1
fi

PGHOST="${PGHOST:-127.0.0.1}"
PGUSER="${PGUSER:-${POSTGRES_USER:-vsigma}}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-vsigma}}"

echo "postgres-wrapper: waiting for postgres at ${PGHOST} (as ${PGUSER})..."
i=0
until pg_isready -h "$PGHOST" -U "$PGUSER" >/dev/null 2>&1; do
  # Fail fast if the child died while we waited (bad volume, failed initdb).
  if ! kill -0 "$child" 2>/dev/null; then
    echo "postgres-wrapper: postgres exited before becoming ready" >&2
    wait "$child" || true
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "postgres-wrapper: postgres never became ready within 120s" >&2
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# ---- (c) provisioning (idempotent, every boot) --------------------------------
# VERBATIM from the old litellm-init.sh: the SQL block is unchanged so the
# wrapper and the retired one-shot are byte-equivalent where it matters.
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

echo "postgres-wrapper: litellm role + database ready"

# ---- (d) babysit: forward TERM/INT to the child, reap, keep PID 1 alive ------
# SIGTERM arrives from `docker stop` / the balena supervisor within
# stop_grace_period (60s). Forwarding it lets the stock entrypoint's own
# trap do `pg_ctl stop` — checkpoint + WAL flush — instead of the runtime
# SIGKILLing an unwarned postgres at the deadline (the corruption gate).
term_child() {
  kill -TERM "$child" 2>/dev/null || true
}
trap term_child TERM INT

# First wait returns as soon as the child is reaped (the trap interrupts
# it); the second wait blocks until the child is fully reaped if the
# signal landed mid-exec. wait (no args) then blocks for ANY remaining
# jobs — with only the one child this is the container's exit path, and
# it also re-reaps if the trap fired before this point.
wait "$child" || true
trap - TERM INT
wait "$child" 2>/dev/null || true
wait || true