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
#   (d) translate the container's stop signal into a postgres FAST
#       shutdown and reap the child via an interruptible poll loop. THE
#       GRACEFUL-SHUTDOWN CONTRACT IS A HARD GATE: the wrapper MUST get
#       the postmaster to checkpoint and flush WAL inside
#       stop_grace_period 60s — a wrapper that lets the runtime SIGKILL
#       an unwarned postgres at the deadline corrupts the identity DB.
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

# ---- (d) babysit: translate the stop signal into a postmaster FAST shutdown --
# The trap goes up BEFORE the readiness wait, not after: TERM at any point
# of the container's life (docker stop / balena supervisor update mid-boot)
# must translate, because with no trap the wrapper shell dies as PID 1 and
# the container teardown SIGKILLs an unwarned postgres — strictly worse than
# the stock image, where PID 1 IS the postmaster and always sees the signal.
#
# The stop signal MUST NOT be forwarded as-is. To the postgres postmaster
# SIGTERM means SMART shutdown — wait indefinitely for every connected
# client (registrar + litellm hold lifetime prisma pool connections) to
# disconnect. That never happens inside a 60s grace: the runtime SIGKILLs
# at the deadline mid-WAL — exactly the corruption this gate exists to
# close (observed on PR #28 run 36593814510: SMART waited out the full
# grace; zero shutdown/checkpoint lines in the logs).
#
# SIGINT is the postmaster's FAST shutdown: it terminates the client
# connections itself, rolls back and checkpoints, and exits within
# seconds — the shutdown the 60s budget was designed for. Translating
# the wrapper's TERM to an INT for the child therefore satisfies both
# contracts at once: `docker stop` semantics (any client may vanish)
# and postgres semantics (deterministic checkpoint + exit).
term_child() {
  # Self-disarm: one INT is the whole instruction; a repeated stop signal
  # (supervisor retry) must not re-signal a postmaster already exiting.
  trap - TERM INT
  kill -INT "$child" 2>/dev/null || true
}
trap term_child TERM INT

# ---- (b) wait for readiness -------------------------------------------------
if [ -z "${PGPASSWORD:-}" ] && [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "postgres-wrapper: PGPASSWORD (deploy .env) or POSTGRES_PASSWORD (balena fleet var) is required — no default" >&2
  kill -INT "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  exit 1
fi
if [ -z "${PGPASSWORD:-}" ]; then
  export PGPASSWORD="$POSTGRES_PASSWORD"
fi
if [ -z "${LITELLM_PG_PASSWORD:-}" ]; then
  echo "postgres-wrapper: LITELLM_PG_PASSWORD is required (balena fleet variable / deploy/.env) — no default" >&2
  kill -INT "$child" 2>/dev/null || true
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
    kill -INT "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 1
  fi
  # Interruptible sleep: a stop signal that lands during this wait fires
  # the trap, which INTs the child; the loop's next iteration sees the
  # dead child and exits the wait path cleanly.
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

# ---- reap: interruptible poll loop + exit-status propagation -----------------
# Reap via a short-sleep poll loop, not a bare `wait "$child"`: some
# /bin/sh builds (busybox ash included) do not reliably interrupt the
# `wait` builtin for a trapped signal, so the trap could stay pending
# while `wait` blocks forever on the live child — a second silent way
# to eat the stop signal. The loop's 1s sleep lets the trap fire no
# later than the next tick. `wait` after the child is gone collects
# its exit status without blocking, and the wrapper PROPAGATES it: a
# postgres that exited 1 must not surface as a green container.
while kill -0 "$child" 2>/dev/null; do
  sleep 1
done
rc=0
wait "$child" || rc=$?
exit "$rc"