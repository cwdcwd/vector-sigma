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
TLS_ENV_FILE="deploy/.env.e2e.tls"
COMPOSE="docker compose --env-file $ENV_FILE --env-file $TLS_ENV_FILE -f deploy/compose.yaml -f deploy/compose.e2e.yaml -p $PROJECT"
# f57.13: the composition's front door is the caddy TLS edge. Host-side
# assertions ride https://vsigma.lan (curl --resolve -> 127.0.0.1, --cacert
# the throwaway E2E CA); TLS_HOSTNAME is the fixed E2E hostname baked into
# the overlay's network alias and the generated CA's SAN.
TLS_HOSTNAME="vsigma.lan"
CA_CERT="deploy/.e2e-tls/vs-ca.crt"
BASE_URL="https://$TLS_HOSTNAME"
PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2-)"
PG_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2-)"
E2E_DEVICE_UUID="$(grep -E '^E2E_DEVICE_UUID=' "$ENV_FILE" | cut -d= -f2-)"
E2E_DEVICE_KEY="$(grep -E '^E2E_DEVICE_KEY=' "$ENV_FILE" | cut -d= -f2-)"
E2E_GRACE_UUID="$(grep -E '^E2E_GRACE_UUID=' "$ENV_FILE" | cut -d= -f2-)"
E2E_GRACE_KEY="$(grep -E '^E2E_GRACE_KEY=' "$ENV_FILE" | cut -d= -f2-)"
E2E_ADMIN_KEY="$(grep -E '^E2E_ADMIN_KEY=' "$ENV_FILE" | cut -d= -f2-)"

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

# f57.13: host-side TLS curl — resolves the E2E hostname to loopback and
# trusts the throwaway E2E CA. Every host-side assertion rides through the
# REAL caddy edge (the front door a LAN client uses).
tls_curl() { # tls_curl <curl args...>
  curl -s --resolve "$TLS_HOSTNAME:443:127.0.0.1" --cacert "$CA_CERT" "$@"
}

# f57.13: mint the throwaway E2E CA + leaf with the OWNER'S script
# (scripts/gen-vs-ca.sh — dogfooding the exact generation path) and emit
# the two env files:
#   deploy/.env.e2e.tls  — TLS_CERT_B64/TLS_KEY_B64 (caddy side) +
#                          E2E_CA_CERT_B64 (device trust side)
#   deploy/.e2e-tls/    — the material itself (gitignored; CA_CERT var
#                          points here for --cacert)
tls_env_generate() {
  rm -rf deploy/.e2e-tls
  bash scripts/gen-vs-ca.sh "$TLS_HOSTNAME" deploy/.e2e-tls >/dev/null
  [ -s "$CA_CERT" ] || { echo "[e2e] CA generation failed" >&2; exit 1; }
  {
    grep -E '^TLS_CERT_B64=' deploy/.e2e-tls/b64-cert.env
    grep -E '^TLS_KEY_B64=' deploy/.e2e-tls/b64-cert.env
    echo "E2E_CA_CERT_B64=$(base64 -w0 "$CA_CERT")"
  } > "$TLS_ENV_FILE"
  [ -s "$TLS_ENV_FILE" ] || { echo "[e2e] TLS env emission failed" >&2; exit 1; }
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
  code="$(tls_curl -o /tmp/e2e-body.json -w '%{http_code}' -X POST "$BASE_URL/v1/bootstrap" \
    -H "Authorization: Bearer $E2E_DEVICE_KEY" -H 'Content-Type: application/json' \
    -d "{\"balena_uuid\":\"$E2E_DEVICE_UUID\"}")"
  expect "AC2 replay status" "$code" "425"
  # M1: guard the grep — missing Retry-After header is the defect this assertion
  # exists to catch; unguarded grep -i exits 1 when not found, which -e kills
  # before the fail() can record the FAIL. Guarded capture lets the assertion run.
  rh="$(tls_curl -D - -o /dev/null -X POST "$BASE_URL/v1/bootstrap" \
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
  if { docker logs "$PROJECT-device-1" > /tmp/e2e-device.log 2>&1 \
      && grep -q 'slot not armed yet; retrying' /tmp/e2e-device.log; }; then
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
  code="$(tls_curl -o /tmp/e2e-body.json -w '%{http_code}' "$BASE_URL/v1/status?balena_uuid=$E2E_DEVICE_UUID" \
    -H "Authorization: Bearer $E2E_DEVICE_KEY")"
  expect "AC4 status code" "$code" "200"
  version="$(node -e "const b=require('/tmp/e2e-body.json');console.log(b.bundle_version ?? '')" 2>/dev/null)"
  dcount="$(node -e "const b=require('/tmp/e2e-body.json');console.log(b.slot?.delivery_count ?? '')" 2>/dev/null)"
  expect "AC4 bundle_version" "$version" "1"
  expect "AC4 delivery_count" "$dcount" "2"
}

ac5_audit_complete() {
  note "AC5: audit log complete"
  # f57.11: scoped to the PRIMARY device — the grace device (AC8) writes
  # its own audit rows (device_not_active denials with key_id), which a
  # global count would attribute to this device's lifecycle.
  local delivered denied complete
  delivered="$(psql_count "outcome='delivered' AND device_id='$E2E_DEVICE_UUID'")"
  denied="$(psql_count "outcome='denied' AND reason='slot_consumed' AND device_id='$E2E_DEVICE_UUID'")"
  complete="$(psql_count "key_id IS NOT NULL AND source_ip IS NOT NULL AND occurred_at IS NOT NULL AND device_id='$E2E_DEVICE_UUID'")"
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

# ---- f57.11 ---------------------------------------------------------------------

# AC7: the REAL admin console drives a structured-fields save; the device's
# NEXT delivery must carry the canonical rendering. This proves the console
# flow end-to-end (login → CSRF → structured form → single rotate path) and
# that the rendered files are exactly what the device-side assembly consumes.
ac7_console_structured_save() {
  note "AC7: console structured save renders canonical files (f57.11)"
  # Console cookies carry Secure (production-correct). curl's cookie jar
  # honors the attribute and refuses to send them over plain http, so the
  # E2E passes cookies EXPLICITLY (-b "name=value"), which bypasses
  # attribute checks — a plain-HTTP loopback harness talking to its own
  # registrar. Tokens are harvested from each page just like the browser
  # flow: login CSRF from the login page, session from the login response,
  # editor CSRF from the editor page.
  local csrf session_cookie editor_csrf login_code save_code version
  csrf="$(tls_curl -D - -o /dev/null "$BASE_URL/admin/login" \
    | tr -d '\r' | grep -i '^set-cookie: vsigma_csrf=' | cut -d' ' -f2- | cut -d';' -f1 | tr -d ' ')"
  if [ -z "$csrf" ]; then fail AC7 "no csrf cookie on login page"; return; fi
  session_cookie="$(tls_curl -D - -o /dev/null -X POST "$BASE_URL/admin/login" \
    -H "Cookie: ${csrf}" \
    --data-urlencode "admin_key=$E2E_ADMIN_KEY" \
    --data-urlencode "_csrf=${csrf#vsigma_csrf=}" \
    | tr -d '\r' | grep -i '^set-cookie: vsigma_admin=' | cut -d' ' -f2- | cut -d';' -f1 | tr -d ' ')"
  login_code="$(tls_curl -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/admin/login" \
    -H "Cookie: ${csrf}" \
    --data-urlencode "admin_key=$E2E_ADMIN_KEY" \
    --data-urlencode "_csrf=${csrf#vsigma_csrf=}")"
  expect "AC7 console login" "$login_code" "303"
  if [ -z "$session_cookie" ]; then fail AC7 "no session cookie after login"; return; fi
  # 2. Structured save on the E2E device: every canonical file gets content.
  # Capture the editor page ONCE, then extract the FIRST _csrf input from
  # the captured body. The page carries TWO _csrf inputs (nav logout form
  # + editor form, both the same session token): a `grep -o` stream-harvest
  # glues both matches into "token\ntoken", and the CSRF gate rejects the
  # corrupted token with 403 (fleet-ops-f57.11 CI red). One awk process
  # reads the captured file, prints the first match, exits — no pipeline,
  # no early-exit SIGPIPE hazard under `set -o pipefail`.
  tls_curl -H "Cookie: ${csrf}; ${session_cookie}" \
    "$BASE_URL/admin/devices/$E2E_DEVICE_UUID/bundle" > /tmp/e2e-editor.html
  editor_csrf="$(awk 'match($0, /name="_csrf" value="[^"]*"/) { print substr($0, RSTART+20, RLENGTH-21); exit }' \
    /tmp/e2e-editor.html)"
  if [ -z "$editor_csrf" ]; then fail AC7 "no editor csrf (session cookie rejected?)"; return; fi
  save_code="$(tls_curl -o /dev/null -w '%{http_code}' -X POST \
    "$BASE_URL/admin/devices/$E2E_DEVICE_UUID/bundle" \
    -H "Cookie: ${csrf}; ${session_cookie}" \
    --data-urlencode "_csrf=$editor_csrf" \
    --data-urlencode "existing_count=2" \
    --data-urlencode "new_count=3" \
    --data-urlencode "existing_path_0=config/agent.env" \
    --data-urlencode "existing_content_0=" \
    --data-urlencode "existing_path_1=config/secrets.env" \
    --data-urlencode "existing_content_1=" \
    --data-urlencode "structured_agent_name=doombot-e2e" \
    --data-urlencode "structured_model_route=openai/gpt-5.2" \
    --data-urlencode "structured_gateway_api_key=sk-e2e-gateway" \
    --data-urlencode "structured_extra_env=LOG_LEVEL=debug" \
    --data-urlencode "structured_soul_contents=# E2E Soul" \
    --data-urlencode "structured_a2a_identity_key=a2a-e2e-key" \
    --data-urlencode "structured_a2a_trusted_peers=ultronbot
kangbot" \
    --data-urlencode "structured_slack_bot_token=xoxb-e2e-slack" \
    --data-urlencode "structured_github_app_pem=-----BEGIN RSA PRIVATE KEY-----
e2e-pem
-----END RSA PRIVATE KEY-----
")"
  expect "AC7 structured save status" "$save_code" "303"
  # 3. Version bumped to 2 via the shared path.
  local version
  version="$(tls_curl -H "Authorization: Bearer $E2E_DEVICE_KEY" \
    "$BASE_URL/v1/status?balena_uuid=$E2E_DEVICE_UUID" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).bundle_version ?? '')")"
  expect "AC7 version bumped via console save" "$version" "2"
  # 4. Wipe the device volume + restart: the re-armed slot re-delivers the
  #    structured bundle; the volume must carry the rendered canonicals.
  $COMPOSE rm -f -s device >/dev/null 2>&1 || $COMPOSE stop device >/dev/null 2>&1 || true
  docker volume rm -f "${PROJECT}_device-data" >/dev/null 2>&1 || true
  $COMPOSE up -d --no-deps device || { fail AC7 "device re-up failed"; return; }
  if ! wait_marker; then
    fail AC7 "device never became ready after structured re-delivery"
    docker logs "$PROJECT-device-1" 2>&1 | tail -30
    return
  fi
  local out
  out="$(docker exec "$PROJECT-device-1" node -e "
    const read=p=>{try{return require('fs').readFileSync('/data/agent/'+p,'utf8')}catch{return 'absent'}};
    process.stdout.write(JSON.stringify({
      agentEnv: read('config/agent.env'),
      secretsEnv: read('config/secrets.env'),
      soul: read('SOUL.md'),
      a2a: read('config/a2a.json'),
      pem: read('config/github-app.pem')
    }));
  " 2>/dev/null)" || out=""
  if [ -z "$out" ]; then fail AC7 "inspector produced no output"; return; fi
  node -e '
    const d = JSON.parse(process.argv[1]);
    const checks = [
      ["agent.env merged render", d.agentEnv.includes("AGENT_NAME=doombot-e2e") && d.agentEnv.includes("GATEWAY_API_KEY=sk-e2e-gateway") && d.agentEnv.includes("MODEL_ROUTE=openai/gpt-5.2") && d.agentEnv.includes("LOG_LEVEL=debug") && d.agentEnv.includes("SOURCE=vector-sigma-e2e")],
      ["secrets.env line-merge", d.secretsEnv.includes("SLACK_BOT_TOKEN=xoxb-e2e-slack") && d.secretsEnv.includes("SIMULATED_SECRET=e2e-rotate-me")],
      ["SOUL.md verbatim", d.soul.includes("# E2E Soul")],
      ["a2a.json object render", (d.a2a.includes("a2a-e2e-key") && d.a2a.includes("ultronbot") && d.a2a.includes("kangbot"))],
      ["github-app.pem verbatim", d.pem.includes("BEGIN RSA PRIVATE KEY")],
    ];
    for (const [name, ok] of checks) console.log("[e2e] " + (ok ? "PASS" : "FAIL") + " AC7 " + name + (ok ? " — ok" : " — got " + JSON.stringify(d)));
  ' "$out" | while IFS= read -r line; do printf '%s\n' "$line"; done
  if printf '%s' "$out" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ok = d.agentEnv.includes("AGENT_NAME=doombot-e2e") && d.agentEnv.includes("GATEWAY_API_KEY=sk-e2e-gateway")
      && d.agentEnv.includes("MODEL_ROUTE=openai/gpt-5.2") && d.agentEnv.includes("LOG_LEVEL=debug")
      && d.agentEnv.includes("SOURCE=vector-sigma-e2e")
      && d.secretsEnv.includes("SLACK_BOT_TOKEN=xoxb-e2e-slack") && d.secretsEnv.includes("SIMULATED_SECRET=e2e-rotate-me")
      && d.soul.includes("# E2E Soul")
      && d.a2a.includes("a2a-e2e-key") && d.a2a.includes("ultronbot") && d.a2a.includes("kangbot")
      && d.pem.includes("BEGIN RSA PRIVATE KEY");
    process.exit(ok ? 0 : 1);
  '; then PASS=$((PASS+5)); else FAIL=$((FAIL+5)); fi
}

# AC8: grace-path device — 403 on pending row stays RESIDENT (no crash
# loop), ACTION REQUIRED line present in logs, then the console fix
# activates the row and the resident poll SELF-HEALS (bundle delivered,
# marker present) without a container restart.
ac8_grace_self_heal() {
  note "AC8: registrant grace — 403 resident + self-heal (f57.11)"
  # 1. Grace device is up (compose started it alongside device).
  if ! docker ps --format '{{.Names}}' | grep -q "$PROJECT-grace-device-1"; then
    fail AC8 "grace-device container not running"
    return
  fi
  # 2. Resident evidence: the ACTION REQUIRED line, and container NOT restarted.
  # Capture-then-grep: a `docker logs | grep -q` stream under pipefail is a
  # producer/consumer race — grep -q exits on the head-of-log match, docker
  # logs gets SIGPIPE (141), and the pipeline reads as "line absent" while
  # the line IS present (fleet-ops-f57.11 CI red). Captured-file grep has
  # no such window, and the capture doubles as the self-diagnosis dump.
  local grace_log=/tmp/e2e-grace-device.log
  local deadline=$((SECONDS + 30))
  until docker logs "$PROJECT-grace-device-1" > "$grace_log" 2>&1 \
    && grep -q 'ACTION REQUIRED' "$grace_log"; do
    [ $SECONDS -ge $deadline ] && break
    sleep 1
  done
  if grep -q 'ACTION REQUIRED' "$grace_log"; then
    pass "AC8 ACTION REQUIRED line" "resident, loud line in logs"
  else
    fail "AC8 ACTION REQUIRED line" "no ACTION REQUIRED in grace-device logs"
    note "grace-device recent logs (self-diagnosis):"
    tail -15 "$grace_log" || true
  fi
  local restarts running
  restarts="$(docker inspect -f '{{.RestartCount}}' "$PROJECT-grace-device-1" 2>/dev/null || echo '?')"
  running="$(docker inspect -f '{{.State.Running}}' "$PROJECT-grace-device-1" 2>/dev/null || echo '?')"
  # restart:"no" means a crash EXITS (RestartCount stays 0) — the resident
  # proof needs the process alive, not just an unrestarted tomb.
  if [ "$restarts" = "0" ] && [ "$running" = "true" ]; then
    pass "AC8 stays resident" "container RUNNING, RestartCount=0 (no crash loop)"
  else
    fail "AC8 stays resident" "Running=$running, RestartCount=$restarts"
  fi
  # 3. Console fix: re-run seed with E2E_GRACE_FIX=1 (activates row + arms bundle).
  # -e passes the flag INTO the container (the shell prefix never reaches
  # compose run's environment).
  $COMPOSE run --rm --no-deps -e E2E_GRACE_FIX=1 seed >/dev/null 2>&1 \
    || { fail AC8 "seed fix pass failed"; return; }
  pass "AC8 console fix applied" "grace device activated + bundle armed"
  # 4. Self-heal: marker appears WITHOUT a container restart.
  local marker_deadline=$((SECONDS + 90))
  local healed=false
  until docker exec "$PROJECT-grace-device-1" test -f /data/agent/ready.marker 2>/dev/null; do
    [ $SECONDS -ge $marker_deadline ] && break
    sleep 2
  done
  if docker exec "$PROJECT-grace-device-1" test -f /data/agent/ready.marker 2>/dev/null; then
    healed=true
  fi
  restarts="$(docker inspect -f '{{.RestartCount}}' "$PROJECT-grace-device-1" 2>/dev/null || echo '?')"
  if [ "$healed" = "true" ]; then
    pass "AC8 self-heal" "ready.marker present, RestartCount=$restarts (poll healed, no restart)"
  else
    fail "AC8 self-heal" "no marker after fix (RestartCount=$restarts)"
    docker logs "$PROJECT-grace-device-1" > "$grace_log" 2>&1 || true
    tail -20 "$grace_log"
  fi
}

ac9_litellm_smoke() {
  note "AC9: VS gateway smoke — liveliness + models list over TLS (f57.12 + f57.13)"
  # f57.13: the gateway is fronted by caddy at https://vsigma.lan:8443 —
  # the smoke rides the REAL edge, --resolve to loopback, throwaway CA trust.
  local base="https://$TLS_HOSTNAME:8443"
  local master
  master="$(grep -E '^LITELLM_MASTER_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  if [ -z "$master" ]; then
    fail AC9 "LITELLM_MASTER_KEY missing from $ENV_FILE"
    return
  fi
  # 1. Liveliness: poll /health/liveliness for 200 — generous deadline: cold
  # start runs prisma migrations against a fresh database (tens of seconds),
  # and the compose build pulls the litellm base image on cold runners.
  local deadline=$((SECONDS + 240)) code=""
  until code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
      --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
      "$base/health/liveliness" 2>/dev/null)" \
    && [ "$code" = "200" ]; do
    [ $SECONDS -ge $deadline ] && break
    sleep 3
  done
  if [ "$code" = "200" ]; then
    pass "AC9 liveliness" "/health/liveliness -> 200 over TLS edge (:8443)"
  else
    fail "AC9 liveliness" "last code: ${code:-none} (deadline 240s)"
    note "caddy + litellm container recent logs (self-diagnosis):"
    docker logs "$PROJECT-caddy-1" 2>&1 | tail -15 || true
    docker logs "$PROJECT-litellm-1" 2>&1 | tail -25 || true
    return
  fi
  # 2. Models list: the config-served model list must contain the explicit
  # j9f groups (a call to /v1/models with the master key — no completion, no
  # upstream traffic; the API key value is never exercised against Ollama).
  # Substring checks: /v1/models ids are the config model_names, but a
  # substring match stays robust to any deployment-version id decoration.
  local models
  models="$(curl -s -m 10 --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
    "$base/v1/models" -H "Authorization: Bearer $master" 2>/dev/null || true)"
  if [ -n "$models" ]; then
    if printf '%s' "$models" | grep -q 'glm-5\.3' \
      && printf '%s' "$models" | grep -q 'glm-5\.2'; then
      pass "AC9 models list" "glm-5.3 + glm-5.2 groups served (j9f explicit groups)"
    else
      fail "AC9 models list" "explicit groups missing from /v1/models: $models"
    fi
  else
    fail "AC9 models list" "no response from $base/v1/models"
  fi
}

# ---- AC10 (f57.15): the VS queue plane — dolt health, scotty serving,
# bd client round-trip against the compose dolt ------------------------------

ac10_queue_plane() {
  note "AC10: VS queue plane — dolt + scotty + bd round-trip (f57.15)"
  local dolt_password
  dolt_password="$(grep -E '^DOLT_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
  if [ -z "$dolt_password" ]; then
    fail AC10 "DOLT_PASSWORD missing from $ENV_FILE"
    return
  fi

  # 1. Dolt container healthy: the documented liveness query, AUTHENTICATED
  # as the app user, with dolt's client flags as GLOBAL flags BEFORE the
  # sql subcommand (the CLI rejects them after the subcommand — proven live
  # against dolt 2.3.5; a root probe without a password is Access-denied
  # once DOLT_ROOT_PASSWORD is set — dolthub issue #7428; both were this
  # lane's CI run-2/run-3 reds). The healthcheck asserts the in-container
  # shape; this asserts the same query lands from the compose network.
  local q
  if q="$($COMPOSE exec -T dolt dolt --host 127.0.0.1 --port 3306 --no-tls -u vs -p "$dolt_password" sql -q 'select current_timestamp();' 2>/dev/null)" \
    && [ -n "$q" ]; then
    pass "AC10 dolt healthy" "current_timestamp() answered as app user: $(printf '%s' "$q" | tail -1)"
  else
    fail "AC10 dolt healthy" "no answer to select current_timestamp() as app user"
  fi

  # 2. Scotty serves: /api/projects must 200 (the picker data route; verified
  # present at cc55734). Poll: the patched image build is cold on CI runners.
  local deadline=$((SECONDS + 240)) code=""
  until code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3306/api/projects 2>/dev/null)" \
    && [ "$code" = "200" ]; do
    [ $SECONDS -ge $deadline ] && break
    sleep 3
  done
  if [ "$code" = "200" ]; then
    pass "AC10 scotty serves" "http://127.0.0.1:3306/api/projects -> 200"
  else
    fail "AC10 scotty serves" "last code: ${code:-none} (deadline 240s)"
    note "scotty container recent logs (self-diagnosis):"
    docker logs "$PROJECT-scotty-1" 2>&1 | tail -25 || true
    return
  fi

  # 3. bd round-trip against the compose dolt from the HOST, with a pinned
  # bd 1.2.2 client downloaded fresh (the same release the scotty image
  # bakes). Why host-side: bd init inits a git repository in the workspace
  # for the sync protocol, and the scotty image deliberately ships WITHOUT
  # git (upstream README documents it); more importantly this mirrors the
  # real device story — VS devices run their OWN bd clients against the
  # LAN dolt (deploy compose publishes 3326), not through the scotty
  # container. The runner provides git + writable HOME; CI=true keeps bd
  # non-interactive. --external: the compose dolt is already running
  # (without it bd starts its OWN server on the port and dies — run-4's
  # lesson). --database vs_ops: use the database the dolt image already
  # created (bd --help: for when an external tool has already created the
  # database) — the vs user holds privileges on vs_ops only.
  # Error output is CAPTURED, never swallowed.
  local workdir=/tmp/vs-queue-e2e
  rm -rf "$workdir"; mkdir -p "$workdir"
  local init_err="/tmp/vs-queue-e2e-init.err"
  local arch="amd64"
  case "$(uname -m)" in aarch64|arm64) arch="arm64" ;; esac
  local bd_bin="$workdir/bd"
  if ! curl -sL "https://github.com/gastownhall/beads/releases/download/v1.2.2/beads_1.2.2_linux_${arch}.tar.gz" \
      -o "$workdir/bd.tgz" 2>"$init_err" \
    || ! tar -xzf "$workdir/bd.tgz" -C "$workdir" bd 2>>"$init_err" \
    || ! chmod +x "$bd_bin" 2>>"$init_err"; then
    fail "AC10 bd client" "download/extract failed: $(tail -2 "$init_err" 2>/dev/null | tr '\n' ' ')"
    return
  fi
  # bd execs `git` for its workspace init (Go exec.LookPath inside bd's own
  # process env). Run-5 lesson: bd died with 'exec: "git": executable file
  # not found in $PATH' on a runner where /usr/bin/git verifiably exists
  # (teardown ran it seconds later), while the same pinned bd 1.2.2 passes
  # git-init locally with a normal PATH. Hardening, two layers:
  #   1) loud guard — if the e2e host shell can't see git, FAIL naming PATH;
  #   2) every bd invocation gets an explicit absolute PATH so bd's
  #      LookPath cannot miss /usr/bin whatever the step env inherited.
  # If it fails again, the FAIL lines now carry the host PATH — no more
  # swallowed environment.
  if ! command -v git >/dev/null 2>&1; then
    fail "AC10 bd client" "git not found on e2e host — PATH=[$PATH] command -v git: $(command -v git 2>&1 || echo none)"
    return
  fi
  local bd_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  # The compose dolt publishes host 3326 (the queue contract — device bd
  # clients reach it exactly this way); the host-side client connects there.
  if ! (cd "$workdir" && PATH="$bd_path" BEADS_DOLT_PASSWORD="$dolt_password" CI=true "$bd_bin" init --server --external \
        --server-host 127.0.0.1 --server-port 3326 --server-user vs \
        --database vs_ops --non-interactive) 2>"$init_err"; then
    fail "AC10 bd init" "bd init failed: $(tail -3 "$init_err" 2>/dev/null | tr '\n' ' ') [host PATH=$PATH, git=$(command -v git || echo none)]"
    return
  fi
  pass "AC10 bd init" "server-mode init minted the project contract"
  if ! (cd "$workdir" && PATH="$bd_path" BEADS_DOLT_PASSWORD="$dolt_password" CI=true "$bd_bin" create "e2e round-trip probe") >/dev/null 2>"$init_err"; then
    fail "AC10 bd create" "bd create failed: $(tail -2 "$init_err" 2>/dev/null | tr '\n' ' ')"
    return
  fi
  pass "AC10 bd create" "probe bead created"
  local listed
  listed="$(cd "$workdir" && PATH="$bd_path" BEADS_DOLT_PASSWORD="$dolt_password" "$bd_bin" list 2>/dev/null || true)"
  if printf '%s' "$listed" | grep -q 'e2e round-trip probe'; then
    pass "AC10 bd list" "probe bead visible in bd list"
  else
    fail "AC10 bd list" "probe bead not listed"
  fi
  # Probe-ID capture. Run-6 lesson: in CI (CI=true) bd list renders a status
  # glyph FIRST ('○ <id> <title>'), so $1 is the glyph, not the ID — parsing
  # the list handed bd close '○' ('resolving ID ○: no issue found'). Two
  # captures, deterministic first:
  #   1) bd list --json's array of rows (verified against bd 1.2.2): each has
  #      an 'id' field; regex the probe's own row — exact, not $1-position.
  #   2) fallback: the first token on the probe row that matches the
  #      <prefix>-<id> shape (bd IDs are '<dir-prefix>-<hash>').
  local probe_id
  probe_id="$(cd "$workdir" && PATH="$bd_path" BEADS_DOLT_PASSWORD="$dolt_password" "$bd_bin" list --json 2>/dev/null \
    | tr -d '\n' | grep -o '"id": *"[^"]*"[^}]*"e2e round-trip probe"' \
    | head -1 | cut -d'"' -f4 || true)"
  if [ -z "$probe_id" ]; then
    probe_id="$(printf '%s' "$listed" | grep 'e2e round-trip probe' \
      | grep -oE '[a-z0-9]+(-[a-z0-9]+)+' | head -1 || true)"
  fi
  if [ -n "$probe_id" ]; then
    if (cd "$workdir" && PATH="$bd_path" BEADS_DOLT_PASSWORD="$dolt_password" CI=true "$bd_bin" close "$probe_id") >/dev/null 2>"$init_err"; then
      pass "AC10 bd close" "probe bead $probe_id closed"
    else
      fail "AC10 bd close" "bd close failed for $probe_id: $(tail -2 "$init_err" 2>/dev/null | tr '\n' ' ')"
    fi
  else
    fail "AC10 bd close" "could not parse probe id from bd list output"
  fi
}

# AC11 (f57.13): the TLS edge contract, asserted from the host through the
# REAL front door:
#   1. port 80 redirects to https (308)
#   2. plain https WITHOUT the CA fails (TLS is ENFORCED, not optional)
#   3. 443 serves the registrar over TLS with the E2E CA trust (healthz 200)
#   4. served cert is the E2E leaf: SAN vsigma.lan, issuer Vector Sigma
#      Internal CA (the gen-vs-ca.sh material — dogfooded, not stock)
#   5. the DEVICE bootstrapped through the edge: its REGISTRAR_URL is
#      https://vsigma.lan and the ready marker exists (AC1's cold boot is
#      the TLS path itself; this makes the attribution explicit)
ac10_tls_edge() {
  note "AC11: TLS edge contract — redirect, enforcement, cert, device path (f57.13)"
  local code sans issuer

  # 1. port 80 -> 308 redirect to https
  code="$(curl -s -o /dev/null -w '%{http_code}' --resolve "$TLS_HOSTNAME:80:127.0.0.1" \
    "http://$TLS_HOSTNAME/" 2>/dev/null || true)"
  expect "AC11 port 80 redirect" "$code" "308"

  # 2. TLS enforced: same call WITHOUT the CA must FAIL (self-signed rejection)
  if curl -s -o /dev/null --resolve "$TLS_HOSTNAME:443:127.0.0.1" \
    "https://$TLS_HOSTNAME/healthz" 2>/dev/null; then
    fail "AC11 TLS enforced" "untrusted client SUCCEEDED — TLS not enforced"
  else
    pass "AC11 TLS enforced" "untrusted client rejected (self-signed CA not in store)"
  fi

  # 3. trusted path: healthz 200 over the edge
  code="$(tls_curl -o /dev/null -w '%{http_code}' "$BASE_URL/healthz")"
  expect "AC11 registrar healthz over TLS" "$code" "200"

  # 4. served cert identity: SAN + issuer from the throwaway E2E material
  sans="$(openssl s_client -connect "127.0.0.1:443" -servername "$TLS_HOSTNAME" </dev/null 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^ ,]*' || true)"
  issuer="$(openssl s_client -connect "127.0.0.1:443" -servername "$TLS_HOSTNAME" </dev/null 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null || true)"
  if printf '%s' "$sans" | grep -q "DNS:$TLS_HOSTNAME"; then
    pass "AC11 cert SAN" "$sans"
  else
    fail "AC11 cert SAN" "got: $sans"
  fi
  if printf '%s' "$issuer" | grep -q 'Vector Sigma Internal CA'; then
    pass "AC11 cert issuer" "VS internal CA (gen-vs-ca.sh material)"
  else
    fail "AC11 cert issuer" "got: $issuer"
  fi

  # 5. the device's own path was TLS: ready marker present (bootstrap went
  #    through https://vsigma.lan — the overlay's REGISTRAR_URL) and the
  #    audit rows carry the edge as source.
  if docker exec "$PROJECT-device-1" test -f /data/agent/ready.marker 2>/dev/null; then
    pass "AC11 device bootstrapped via TLS" "ready.marker present (REGISTRAR_URL=https://$TLS_HOSTNAME)"
  else
    fail "AC11 device bootstrapped via TLS" "no ready.marker — device never completed TLS bootstrap"
  fi
}

# AC12 (f57.14): the primus dogfood — the coordinator self-bootstraps through
# the SAME chain every device uses. The overlay's primus-registrant (the REAL
# vendored registrant) fetches the seeded primus bundle from the REAL
# registrar over compose-internal http and applies it to the shared
# primus-data volume; the REAL official Hermes image's entrypoint gates on
# the ready marker. Assertions:
#   1. the primus ready marker exists (the registrant-own chain completed)
#   2. every structured canonical landed on the volume: merged
#      config/agent.env (AGENT_NAME=primus + MODEL_ROUTE + GATEWAY_API_KEY +
#      GATEWAY_URL), config/secrets.env, verbatim SOUL.md (coordinator
#      clauses), config/a2a.json, config/github-app.pem
#   3. the hermes container started past the gate (its HERMES_HOME carries
#      the boot artifacts — the image's stage2 seeds config.yaml when
#      absent, proving the gateway process launched against the volume)
ac12_primus_self_bootstrap() {
  note "AC12: primus self-bootstrap — the dogfood chain (f57.14)"
  local container="$PROJECT-primus-registrant-1"
  local deadline=$((SECONDS + 300))

  # 1. the primus registrant delivered: ready marker on the shared volume.
  until docker exec "$container" test -f /data/agent/ready.marker 2>/dev/null; do
    [ $SECONDS -ge $deadline ] && {
      fail "AC12 primus ready marker" "no ready.marker after 300s — registrant-own never delivered"
      docker logs "$container" 2>&1 | tail -20
      return
    }
    sleep 2
  done
  pass "AC12 primus ready marker" "registrant-own delivered the bundle (the device chain, localhost registrar)"

  # 2. every structured canonical landed (0600, expected content).
  expect_file() { # expect_file <rel> <needle> <label>
    local got
    got="$(docker exec "$container" sh -c "cat /data/agent/$1 2>/dev/null" || true)"
    if printf '%s' "$got" | grep -q "$2"; then
      pass "AC12 $3" "$1 carries $2"
    else
      fail "AC12 $3" "$1 missing/!~ '$2' (got: $(printf '%s' "$got" | head -c 120))"
    fi
  }
  expect_file "config/agent.env" "AGENT_NAME=primus" "agent.env AGENT_NAME"
  expect_file "config/agent.env" "MODEL_ROUTE=ollama-cloud/glm-5.3" "agent.env MODEL_ROUTE"
  expect_file "config/agent.env" "GATEWAY_API_KEY=" "agent.env GATEWAY_API_KEY"
  expect_file "config/agent.env" "GATEWAY_URL=http://litellm:4000" "agent.env GATEWAY_URL (the composition's litellm)"
  expect_file "config/secrets.env" "SLACK_BOT_TOKEN=" "secrets.env SLACK_BOT_TOKEN"
  expect_file "SOUL.md" "Vector Sigma fleet coordinator" "SOUL.md coordinator clause"
  expect_file "SOUL.md" "A2A-only" "SOUL.md cross-fleet clause"
  expect_file "config/a2a.json" "identity_key" "a2a.json identity key"
  expect_file "config/github-app.pem" "sim-e2e-pem-placeholder" "github-app.pem (owner-side custody shape)"

  # 3. the hermes container consumed the gated volume: its HERMES_HOME
  #    (/data/primus) shows the stage2 boot artifacts — the gateway process
  #    launched. The entrypoint blocks until the marker exists; the seed
  #    files (config.yaml from the image's example) prove it ran PAST
  #    the gate, not just started.
  local hcontainer="$PROJECT-hermes-1"
  local hdeadline=$((SECONDS + 180))
  until docker exec "$hcontainer" sh -c "test -f /data/primus/state.db || test -f /data/primus/config.yaml" 2>/dev/null; do
    [ $SECONDS -ge $hdeadline ] && {
      fail "AC12 hermes boot" "no stage2/gateway artifacts under /data/primus after 180s — hermes never booted against the volume"
      docker logs "$hcontainer" 2>&1 | tail -15
      return
    }
    sleep 3
  done
  if docker exec "$hcontainer" test -f /data/primus/config.yaml 2>/dev/null; then
    pass "AC12 hermes stage2 boot" "config.yaml seeded under HERMES_HOME — stage2 ran against the volume"
  else
    fail "AC12 hermes stage2 boot" "no config.yaml under HERMES_HOME — stage2 never ran"
  fi
  # The bundle from HERMES_HOME's view: the registrant mounts the shared
  # volume at /data/agent (its DATA_DIR), so the bundle sits at the volume
  # ROOT — which IS /data/primus. primus's SOUL.md lands at
  # $HERMES_HOME/SOUL.md: stage2's first-boot seed is skipped (file already
  # present) and the hermes runtime serves the bundle's SOUL — the config
  # delivery the whole lane exists to prove. (Run-5 correction: my earlier
  # agent/… path never existed; the volume root is the bundle dir.)
  if docker exec "$hcontainer" sh -c "grep -q 'primus' /data/primus/SOUL.md" 2>/dev/null; then
    pass "AC12 hermes serves the bundle SOUL" "bundle SOUL.md at HERMES_HOME root — stage2 seed skipped, primus's SOUL wins"
  else
    fail "AC12 hermes serves the bundle SOUL" "SOUL.md not readable at /data/primus root — bundle not at HERMES_HOME root"
  fi
}

# ---- main ---------------------------------------------------------------------

# f57.13: the TLS env file is (re)generated on --up; ensure it exists for
# assert-only and --down paths too (compose refuses a missing --env-file).
[ -f "$TLS_ENV_FILE" ] || tls_env_generate

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
ac7_console_structured_save
ac8_grace_self_heal
ac9_litellm_smoke
ac10_queue_plane
ac10_tls_edge
ac12_primus_self_bootstrap
echo
echo "[e2e] ===== RESULT: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]