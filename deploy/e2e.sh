#!/usr/bin/env bash
# deploy/e2e.sh — AC-by-AC assertion driver for the compose-simulated E2E
# (fleet-ops-f57.5). Run on a compose-capable host.
#
# Usage:
#   deploy/e2e.sh --up      # fresh stack (down -v, build, up), wait ready, assert all ACs
#   deploy/e2e.sh           # assert against an already-running stack
#   deploy/e2e.sh --down    # teardown (removes volumes)
#
# Every acceptance criterion is asserted in order; PASS/FAIL lines are the
# evidence transcript. Exit 0 only when every AC passes.

set -euo pipefail

PROJECT="vector-sigma-e2e"
ENV_FILE="deploy/.env.e2e"
COMPOSE="docker compose --env-file $ENV_FILE -f deploy/compose.yaml -f deploy/compose.e2e.yaml -p $PROJECT"
BASE_URL="http://127.0.0.1:3000"
PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2-)"
PG_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2-)"
E2E_DEVICE_UUID="$(grep -E '^E2E_DEVICE_UUID=' "$ENV_FILE" | cut -d= -f2-)"
E2E_DEVICE_KEY="$(grep -E '^E2E_DEVICE_KEY=' "$ENV_FILE" | cut -d= -f2-)"

PASS=0; FAIL=0
note() { printf '[e2e] %s\n' "$*"; }
pass() { PASS=$((PASS+1)); printf '[e2e] PASS %s — %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL+1)); printf '[e2e] FAIL %s — %s\n' "$1" "$2"; }
expect() { if [ "$2" = "$3" ]; then pass "$1" "got $2"; else fail "$1" "got $2, want $3"; fi; }

# M2: trap/EXIT cleanup — a failed --up run tears down its own stack.
# EXIT trap fires on all exit paths (exit N, -e abort, normal return);
# ERR trap misses bare exit calls and in-function -e aborts without set -E.
# Scoped to --up mode only: assert-only runs against an operator's stack
# must not destroy evidence on first red AC.
CLEANUP_DONE=false
STACK_OWNER=false   # true only when this run did --up (owns the stack)
cleanup_on_failure() {
  local rc=$?
  if [ "$CLEANUP_DONE" = "true" ]; then return $rc; fi
  CLEANUP_DONE=true
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$STACK_OWNER" != "true" ]; then
    note "non-zero exit ($rc) but this run does not own the stack — skipping teardown"
    return $rc
  fi
  echo
  note "EXIT trap triggered (rc=$rc) — tearing down stack to avoid orphan containers..."
  local down_rc=0
  $COMPOSE down -v 2>&1 || down_rc=$?
  if [ "$down_rc" -ne 0 ]; then
    note "teardown exited $down_rc — partial cleanup possible"
  else
    note "teardown complete"
  fi
  return $rc
}
trap 'cleanup_on_failure' EXIT

psql_count() { # psql_count <sql-where-fragment> — count rows in delivery_log
  $COMPOSE exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tA \
    -c "SELECT count(*) FROM delivery_log WHERE $1" 2>/dev/null | tr -d '[:space:]'
}

wait_audit_count() { # wait_audit_count <where> <min> — poll up to 20s
  local deadline=$((SECONDS + 20))
  until [ "$(psql_count "$1")" -ge "$2" ] 2>/dev/null; do
    [ $SECONDS -ge $deadline ] && return 1
    sleep 1
  done
  return 0
}

wait_marker() { # wait for the device container to write the ready marker (up to 300s)
  local deadline=$((SECONDS + 300))
  until docker exec "$PROJECT-device-1" test -f /data/agent/ready.marker 2>/dev/null; do
    [ $SECONDS -ge $deadline ] && return 1
    sleep 2
  done
  return 0
}

# ---- lifecycle ----------------------------------------------------------------

stack_up() {
  STACK_OWNER=true  # This run owns the stack — enable auto-teardown on failure
  note "fresh stack: down -v, then build + up (project $PROJECT)..."
  $COMPOSE down -v >/dev/null 2>&1 || true
  $COMPOSE up -d --build || { note "compose up failed"; exit 1; }

  note "waiting for cold bootstrap (seed gate → device → ready marker)..."
  if ! wait_marker; then
    note "device never became ready; recent logs:"
    docker logs "$PROJECT-device-1" 2>&1 | tail -30
    $COMPOSE logs registrar 2>&1 | tail -20
    exit 2
  fi
  pass "AC1 cold boot" "device bootstrapped, ready marker present"
  if wait_audit_count "outcome='delivered'" 1; then
    pass "AC1 delivery audited" "delivered row exists"
  else
    fail "AC1 delivery audited" "no delivered audit row"
  fi
}

stack_down() {
  note "tearing down (volumes removed)..."
  $COMPOSE down -v
}

# ---- ACs ----------------------------------------------------------------------

ac2_replay_425() {
  note "AC2: direct replay must 425 with Retry-After"
  local code headers rh rb
  code="$(curl -s -o /tmp/e2e-body.json -w '%{http_code}' -X POST "$BASE_URL/v1/bootstrap" \
    -H "Authorization: Bearer $E2E_DEVICE_KEY" -H 'Content-Type: application/json' \
    -d "{\"balena_uuid\":\"$E2E_DEVICE_UUID\"}")"
  expect "AC2 replay status" "$code" "425"
  # M1: guard the grep — missing Retry-After header is the defect this assertion
  # exists to catch; unguarded grep -i exits 1 when not found, which -e kills
  # before the fail() can record the FAIL. Guarded capture lets the assertion run.
  rh="$(curl -s -D - -o /dev/null -X POST "$BASE_URL/v1/bootstrap" \
    -H "Authorization: Bearer $E2E_DEVICE_KEY" -H 'Content-Type: application/json' \
    -d "{\"balena_uuid\":\"$E2E_DEVICE_UUID\"}" | tr -d '\r' | grep -i '^retry-after:' | cut -d' ' -f2)" || rh=""
  rb="$(node -e "const b=require('/tmp/e2e-body.json');console.log(b.retry_after_seconds ?? '')" 2>/dev/null)" || rb=""
  if [ -n "$rh" ] && [ "$rh" -gt 0 ] 2>/dev/null; then
    pass "AC2 Retry-After header" "$rh s"
  else
    fail "AC2 Retry-After header" "missing/invalid: '$rh'"
  fi
  if [ -n "$rb" ] && [ "$rb" -gt 0 ] 2>/dev/null; then
    pass "AC2 retry_after_seconds body" "$rb s"
  else
    fail "AC2 retry_after_seconds body" "missing/invalid: '$rb'"
  fi
}

ac3_rearm_redelivers() {
  note "AC3: wipe device volume, restart device inside the rearm window — real client path"
  $COMPOSE rm -f -s device >/dev/null 2>&1 || $COMPOSE stop device >/dev/null 2>&1 || true
  docker volume rm -f "${PROJECT}_device-data" >/dev/null 2>&1 || true
  $COMPOSE up -d --no-deps device || { fail AC3 "device re-up failed"; return; }

  if ! wait_marker; then
    fail AC3 "device never became ready after wipe"
    docker logs "$PROJECT-device-1" 2>&1 | tail -30
    return
  fi
  # Which path did the real client take? (425→retry loop vs window already elapsed)
  # The retry path is REQUIRED: the rearm window (SEED_REARM_SECONDS) is sized
  # so the wiped device's bootstrap call must land inside it. If the window
  # elapsed instead, the 425/Retry-After retry loop was never exercised and
  # AC3 fails loudly rather than passing vacuously.
  if docker logs "$PROJECT-device-1" 2>&1 | grep -q 'slot not armed yet; retrying'; then
    pass "AC3 rearm path" "device hit 425, honored Retry-After, re-delivered"
  else
    fail "AC3 rearm path" "window elapsed before device retry — 425 retry loop not exercised (raise SEED_REARM_SECONDS)"
  fi
  if wait_audit_count "outcome='delivered'" 2; then
    pass "AC3 re-delivery audited" "delivered=2 (auto-rearm after window)"
  else
    fail "AC3 re-delivery audited" "delivered=$(psql_count "outcome='delivered'") (want 2)"
  fi
}

ac4_status_version() {
  note "AC4: GET /v1/status reports bundle version + slot counters"
  local code version dcount
  code="$(curl -s -o /tmp/e2e-body.json -w '%{http_code}' "$BASE_URL/v1/status?balena_uuid=$E2E_DEVICE_UUID" \
    -H "Authorization: Bearer $E2E_DEVICE_KEY")"
  expect "AC4 status code" "$code" "200"
  version="$(node -e "const b=require('/tmp/e2e-body.json');console.log(b.bundle_version ?? '')" 2>/dev/null)"
  dcount="$(node -e "const b=require('/tmp/e2e-body.json');console.log(b.slot?.delivery_count ?? '')" 2>/dev/null)"
  expect "AC4 bundle_version" "$version" "1"
  expect "AC4 delivery_count" "$dcount" "2"
}

ac5_audit_complete() {
  note "AC5: audit log complete"
  local delivered denied complete
  delivered="$(psql_count "outcome='delivered'")"
  denied="$(psql_count "outcome='denied' AND reason='slot_consumed'")"
  complete="$(psql_count "key_id IS NOT NULL AND source_ip IS NOT NULL AND occurred_at IS NOT NULL")"
  [ "${delivered:-0}" -ge 2 ] && pass "AC5 delivered rows" "$delivered (>=2)" \
    || fail "AC5 delivered rows" "$delivered (<2)"
  [ "${denied:-0}" -ge 1 ] && pass "AC5 slot_consumed denial" "$denied (>=1)" \
    || fail "AC5 slot_consumed denial" "$denied (0)"
  # Every row from this E2E run carries the full attribution set.
  [ "${complete:-0}" = "$((delivered + denied))" ] && pass "AC5 attribution complete" "$complete/$((delivered + denied)) rows carry key_id+source_ip+occurred_at" \
    || fail "AC5 attribution complete" "$complete of $((delivered + denied))"
}

ac6_volume_state() {
  note "AC6: bundle applied on the data volume (0600 modes, marker, contents)"
  local out
  # M1: guard the docker exec — inspector failure (container down, node crash, etc.)
  # is exactly what the assertion exists to catch; unguarded exits 1, -e kills before
  # fail() can record. Guarded capture + empty check lets the FAIL record.
  out="$(docker exec "$PROJECT-device-1" node -e "
    const fs=require('fs');
    const stat=p=>{try{return fs.statSync('/data/agent/'+p)}catch{return null}};
    const mode=s=>s?'0'+(s.mode & 0o777).toString(8):'absent';
    const read=p=>{try{return fs.readFileSync('/data/agent/'+p,'utf8')}catch{return 'absent'}};
    process.stdout.write(JSON.stringify({
      marker: !!stat('ready.marker'),
      markerMode: mode(stat('ready.marker')),
      bundleMode: mode(stat('identity-bundle.json')),
      agentEnv: read('config/agent.env'),
      secretsEnv: read('config/secrets.env')
    }));
  " 2>/dev/null)" || out=""
  if [ -z "$out" ]; then fail AC6 "inspector produced no output"; return; fi
  node -e '
    const d = JSON.parse(process.argv[1]);
    const checks = [
      ["ready marker present", d.marker === true],
      ["ready marker 0600", d.markerMode === "0600"],
      ["bundle snapshot 0600", d.bundleMode === "0600"],
      ["agent.env content", d.agentEnv.includes("AGENT_NAME=sim-deploy-e2e")],
      ["secrets.env content", d.secretsEnv.includes("SIMULATED_SECRET=e2e-rotate-me")],
    ];
    for (const [name, ok] of checks) console.log("[e2e] " + (ok ? "PASS" : "FAIL") + " AC6 " + name + (ok ? " — ok" : " — got " + JSON.stringify(d)));
  ' "$out" | while IFS= read -r line; do
    printf '%s\n' "$line"
  done
  # Tally the FAILs for the exit code.
  if printf '%s' "$out" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ok = d.marker === true && d.markerMode === "0600" && d.bundleMode === "0600"
      && d.agentEnv.includes("AGENT_NAME=sim-deploy-e2e")
      && d.secretsEnv.includes("SIMULATED_SECRET=e2e-rotate-me");
    process.exit(ok ? 0 : 1);
  '; then PASS=$((PASS+5)); else FAIL=$((FAIL+5)); fi
}

# ---- main ---------------------------------------------------------------------

case "${1:-}" in
  --down) stack_down; exit $? ;;
  --up)   stack_up ;;
  "")     : ;;
  *) echo "usage: deploy/e2e.sh [--up|--down]"; exit 64 ;;
esac

ac2_replay_425
ac3_rearm_redelivers
ac4_status_version
ac5_audit_complete
ac6_volume_state

echo
echo "[e2e] ===== RESULT: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]