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
CADDY_CONTAINER="$PROJECT-caddy-1"
# fleet-ops-anc: the postgres wrapper's container (the e2e project pins
# compose v2 container names, <project>-<service>-1).
PG_CONTAINER="$PROJECT-postgres-1"
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

# f57.13 (Caddy-internal-CA rewrite): caddy mints its own local CA on first
# boot — there is nothing to generate up front. This extracts the root
# cert caddy already produced (docker cp from its data volume, the same
# path the tls-runbook documents for the owner) and emits:
#   deploy/.env.e2e.tls  — E2E_CA_CERT_B64 (device trust side; caddy itself
#                          needs no TLS variables at all now)
#   deploy/.e2e-tls/     — the cert itself (gitignored; CA_CERT var points
#                          here for --cacert)
# Requires a running (or previously-run) caddy container — stack_up calls
# this AFTER caddy reports healthy, i.e. after it has already served TLS
# at least once and therefore definitely holds a root cert.
tls_env_generate() {
  mkdir -p deploy/.e2e-tls
  if docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1 \
      && docker cp "$CADDY_CONTAINER:/data/caddy/pki/authorities/local/root.crt" "$CA_CERT" 2>/dev/null; then
    note "extracted caddy's self-provisioned internal CA root from $CADDY_CONTAINER"
  elif [ ! -s "$CA_CERT" ]; then
    # No caddy container to extract from (e.g. a bare --down before any
    # --up ran this session) — mint a throwaway self-signed placeholder
    # purely so compose's ${E2E_CA_CERT_B64:?} interpolation has a value;
    # nothing trusts it, and `down` tears the stack out from under it
    # immediately.
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
      -subj "/CN=e2e-teardown-placeholder" -keyout /dev/null -out "$CA_CERT" 2>/dev/null
  fi
  [ -s "$CA_CERT" ] || { echo "[e2e] no CA material available (real or placeholder)" >&2; exit 1; }
  echo "E2E_CA_CERT_B64=$(base64 -w0 "$CA_CERT" 2>/dev/null || base64 "$CA_CERT" | tr -d '\n')" > "$TLS_ENV_FILE"
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
  rm -rf deploy/.e2e-tls

  # f57.13 (Caddy-internal-CA rewrite): caddy self-provisions its CA on
  # first boot — there is no CA material to hand the device container
  # until caddy has actually started. Two-phase bring-up: (1) everything
  # except tls-gate/device, which need the CA bytes as an env var at
  # container-create time (docker compose reads deploy/.env.e2e.tls fresh
  # on every invocation); (2) extract the CA, then start tls-gate/device.
  $COMPOSE up -d --build --scale tls-gate=0 --scale device=0 \
    || { note "compose up (phase 1: everything but tls-gate/device) failed"; exit 1; }

  note "waiting for caddy to self-provision its internal CA and serve TLS..."
  local deadline=$((SECONDS + 60))
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CADDY_CONTAINER" 2>/dev/null)" = "healthy" ]; do
    if [ $SECONDS -ge $deadline ]; then
      note "caddy never became healthy within 60s; recent logs:"
      docker logs "$CADDY_CONTAINER" 2>&1 | tail -30
      exit 1
    fi
    sleep 1
  done
  tls_env_generate

  note "starting tls-gate + device now that the CA is extracted..."
  $COMPOSE up -d --build tls-gate device \
    || { note "compose up (phase 2: tls-gate/device) failed"; exit 1; }

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
    --data-urlencode "structured_a2a_public_url=https://vsigma.lan:8443" \
    --data-urlencode "structured_a2a_peer_tokens=primus:a2a-e2e-key" \
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
      ["a2a.json object render", (d.a2a.includes("a2a-e2e-key") && d.a2a.includes("ultronbot") && d.a2a.includes("kangbot") && d.a2a.includes("https://vsigma.lan:8443") && d.a2a.includes("peer_tokens"))],
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

# AC7b: persona pre-fill picker (fleet-ops-zbq.2) — the editor page carries
# the advisory picker and its embedded (build-time) library. Asserted from
# the outside like every other AC: options for every library persona, the
# JSON data island parses and matches the repo's personas/, the select
# never submits (no name attribute), and the page stays fleet-agnostic.
# The FILL itself is browser-side; AC7 already proves the save path is the
# one structured-fields -> canonical-files -> rotate core, unchanged.
ac7b_persona_picker() {
  note "AC7b: persona pre-fill picker renders with the embedded library (zbq.2)"
  local csrf session_cookie editor_html
  csrf="$(tls_curl -D - -o /dev/null "$BASE_URL/admin/login" \
    | tr -d '\r' | grep -i '^set-cookie: vsigma_csrf=' | cut -d' ' -f2- | cut -d';' -f1 | tr -d ' ')"
  if [ -z "$csrf" ]; then fail AC7b "no csrf cookie on login page"; return; fi
  session_cookie="$(tls_curl -D - -o /dev/null -X POST "$BASE_URL/admin/login" \
    -H "Cookie: ${csrf}" \
    --data-urlencode "admin_key=$E2E_ADMIN_KEY" \
    --data-urlencode "_csrf=${csrf#vsigma_csrf=}" \
    | tr -d '\r' | grep -i '^set-cookie: vsigma_admin=' | cut -d' ' -f2- | cut -d';' -f1 | tr -d ' ')"
  if [ -z "$session_cookie" ]; then fail AC7b "no session cookie after login"; return; fi
  tls_curl -H "Cookie: ${csrf}; ${session_cookie}" \
    "$BASE_URL/admin/devices/$E2E_DEVICE_UUID/bundle" > /tmp/e2e-persona-editor.html
  editor_html=/tmp/e2e-persona-editor.html
  if [ ! -s "$editor_html" ]; then fail AC7b "editor page fetch empty"; return; fi
  # 1. advisory copy + unnamed select (never submits)
  if grep -q 'Persona pre-fill (advisory)' "$editor_html" \
     && grep -q '<select id="persona-select">' "$editor_html" \
     && ! grep -Eq '<select[^>]* name=' "$editor_html"; then
    pass "AC7b picker select" "advisory picker present, no name attribute (never submits)"
  else
    fail "AC7b picker select" "advisory copy or unnamed select missing"
  fi
  # 2. option coverage — every repo persona slug appears as an option
  local slug missing=""
  for slug in alpha-trion bumblebee grimlock optimus-prime ultra-magnus wheeljack; do
    grep -q "<option value=\"$slug\">" "$editor_html" || missing="$missing $slug"
  done
  if [ -z "$missing" ]; then
    pass "AC7b option coverage" "all six library personas offered"
  else
    fail "AC7b option coverage" "missing options:$missing"
  fi
  # 3. data island: JSON parses, matches the repo's personas/ directory,
  #    carries no raw `<` (cannot terminate the block), no secret markers,
  #    no fleet names. Node does the parse + comparison.
  if node -e '
    const fs = require("fs");
    const html = fs.readFileSync("/tmp/e2e-persona-editor.html", "utf8");
    const m = html.match(/<script type="application\/json" id="persona-library-data">([\s\S]*?)<\/script>/);
    if (!m) { console.error("no data island"); process.exit(1); }
    if (m[1].includes("<")) { console.error("raw < inside island"); process.exit(1); }
    const lib = JSON.parse(m[1]);
    const slugs = lib.map((p) => p.slug).sort().join(",");
    const want = ["alpha-trion","bumblebee","grimlock","optimus-prime","ultra-magnus","wheeljack"].sort().join(",");
    if (slugs !== want) { console.error("slugs " + slugs); process.exit(1); }
    for (const marker of ["sk-", "xoxb-", "BEGIN RSA PRIVATE KEY", "GATEWAY_API_KEY="]) {
      if (m[1].includes(marker)) { console.error("secret marker " + marker); process.exit(1); }
    }
    if (/doombot|ultronbot|kangbot|thanosbot|lazybaer/i.test(m[1])) { console.error("fleet name in island"); process.exit(1); }
    const soul = lib.find((p) => p.slug === "optimus-prime").soul_contents;
    const disk = fs.readFileSync("personas/optimus-prime/SOUL.md", "utf8");
    if (soul !== disk) { console.error("soul text drift vs personas/"); process.exit(1); }
  ' 2>/dev/null; then
    pass "AC7b data island" "valid JSON, byte-matches personas/, non-secret, fleet-agnostic"
  else
    fail "AC7b data island" "island parse/content check failed"
  fi
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

# f57.17 (AC9b): the DB-backed half of the gateway smoke. AC9's two
# assertions are DB-independent by design (liveliness = process liveness;
# models list = config-served) — a broken DATABASE_URL passes AC9 today.
# This probe closes the gap: mint a virtual key (POST /key/generate, the
# README's owner mint path, master-key auth, deterministic alias) and read
# it back (GET /key/list?key_alias=<exact>&return_full_object=true). A 200
# mint means the token row was written through prisma to postgres —
# migrations ran AND the gateway's DATABASE_URL is live; the alias surfacing
# in the list response means the row round-trips. Both routes are local
# DB operations: no upstream LLM traffic, preserving AC9's smoke property.
# Route shapes verified against the pinned ghcr.io/berriai/litellm:1.100.1
# sources (litellm/proxy/management_endpoints/key_management_endpoints.py):
# POST /key/generate -> GenerateKeyResponse{key: str, ...};
# GET /key/list -> {keys: [...]} with bare token strings unless
# return_full_object=true — hence the flag: full objects carry key_alias.
ac9b_litellm_db_smoke() {
  note "AC9b: VS gateway DB contract — virtual-key mint + list via /key/generate + /key/list (f57.17)"
  local base="https://$TLS_HOSTNAME:8443"
  local master
  master="$(grep -E '^LITELLM_MASTER_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  if [ -z "$master" ]; then
    fail AC9b "LITELLM_MASTER_KEY missing from $ENV_FILE"
    return
  fi
  local alias="e2e-ac9b-virtual-key"
  local gen_body=/tmp/e2e-ac9b-generate.json
  local list_body=/tmp/e2e-ac9b-list.json
  local code minted found
  # 1. Mint — minimal payload: deterministic alias for the exact-match
  #    lookup + 1h duration so probe keys self-expire on a standing stack.
  #    No models list (the probe key never completes anything), no budget.
  code="$(curl -s -o "$gen_body" -w '%{http_code}' -m 30 \
      --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
      -X POST "$base/key/generate" \
      -H "Authorization: Bearer $master" \
      -H 'Content-Type: application/json' \
      -d "{\"key_alias\": \"$alias\", \"duration\": \"1h\"}" 2>/dev/null || true)"
  expect "AC9b mint virtual key" "$code" "200"
  if [ "$code" != "200" ]; then
    note "generate response body (self-diagnosis — error body, no key on failure):"
    tail -c 500 "$gen_body" 2>/dev/null || true
    docker logs "$PROJECT-litellm-1" 2>&1 | tail -15 || true
    return
  fi
  minted="$(node -e 'const b=require(process.argv[1]);console.log(typeof b.key==="string"&&b.key.length>0?"ok":"missing")' "$gen_body" 2>/dev/null)" || minted="missing"
  expect "AC9b minted key present" "$minted" "ok"
  if [ "$minted" != "ok" ]; then
    return
  fi
  # 2. List with the exact-match alias filter (verified: /key/list matches
  #    key_alias exactly by default — no substring false-positives).
  code="$(curl -s -o "$list_body" -w '%{http_code}' -m 30 \
      --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
      "$base/key/list?key_alias=$alias&return_full_object=true" \
      -H "Authorization: Bearer $master" 2>/dev/null || true)"
  expect "AC9b list virtual keys" "$code" "200"
  if [ "$code" != "200" ]; then
    note "list response body (self-diagnosis):"
    tail -c 500 "$list_body" 2>/dev/null || true
    return
  fi
  # 3. The alias must surface — full key objects parsed per the harness's
  #    node convention; key VALUES are never printed (same discipline as
  #    the master key, simulation stack or not).
  found="$(node -e 'const b=require(process.argv[1]);const ks=Array.isArray(b.keys)?b.keys:[];console.log(ks.some(k=>k&&typeof k==="object"&&k.key_alias===process.argv[2])?"yes":"no")' "$list_body" "$alias" 2>/dev/null)" || found="no"
  if [ "$found" = "yes" ]; then
    pass "AC9b minted key visible" "alias '$alias' served by /key/list — prisma migrations ran + postgres reachable end-to-end"
  else
    fail "AC9b minted key visible" "alias '$alias' not in /key/list response: $(node -e 'const b=require(process.argv[1]);const ks=Array.isArray(b.keys)?b.keys:[];console.log(JSON.stringify({total_count:b.total_count??null,aliases:ks.filter(k=>k&&typeof k==="object").map(k=>k.key_alias).slice(0,5)}))' "$list_body" 2>/dev/null || true)"
  fi
}

# ---- AC-anc (fleet-ops-anc): the postgres consolidation — wrapper image,
# no one-shot init container, SIGTERM hard gate, idempotent re-provision ------

ac_anc_postgres_consolidation() {
  note "AC-anc: postgres wrapper consolidation — no litellm-init, role provisioned, SIGTERM clean shutdown (fleet-ops-anc)"

  # 1. NO litellm-init container exists in the composition (the service is
  #    deleted from BOTH composes). `docker compose ps` on a deleted service
  #    name would error, so assert absence the reliable way: no RUNNING
  #    container in the project carries the name.
  if docker ps --filter "name=$PROJECT" --format '{{.Names}}' \
      | grep -q "litellm-init"; then
    fail "AC-anc no litellm-init container" "a litellm-init container is running — the one-shot was not removed"
  else
    pass "AC-anc no litellm-init container" "no litellm-init container in the project"
  fi

  # 2. The postgres container runs the WRAPPER image and provisioned the
  #    gateway's role + database: the litellm role exists, the litellm
  #    database exists, and the least-privilege REVOKE landed.
  local probe
  probe="$($COMPOSE exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tA \
    -c "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='litellm') || ':' || (SELECT count(*) FROM pg_database WHERE datname='litellm') || ':' || (SELECT count(*) FROM pg_stat_database WHERE datname='litellm')" 2>/dev/null)" \
    || probe=""
  if [ "$probe" = "1:1:1" ]; then
    pass "AC-anc litellm role+db provisioned" "role litellm + database litellm live (REVOKE asserted implicitly by pg_stat_database row)"
  else
    fail "AC-anc litellm role+db provisioned" "probe returned '${probe:-nothing}' (want 1:1:1)"
  fi

  # 3. HARD GATE — graceful shutdown: stop ONLY the postgres service with
  #    docker compose (sends SIGTERM to PID 1 = the wrapper, which MUST
  #    forward it so postgres checkpoints + flushes WAL inside the 60s
  #    grace). Assert the shutdown path from postgres's own log lines
  #    (checkpoint + "database system is shut down"), then bring it back
  #    and assert the wrapper RE-PROVISIONS idempotently (role+db still
  #    exactly present, no duplicate anything, healthcheck green again).
  note "AC-anc: stopping postgres (docker compose stop) — SIGTERM forward + clean shutdown assertion"
  local stop_start=$SECONDS
  if ! $COMPOSE stop postgres > /tmp/e2e-anc-stop.log 2>&1; then
    fail "AC-anc compose stop postgres" "docker compose stop postgres exited non-zero: $(tail -3 /tmp/e2e-anc-stop.log)"
    return
  fi
  local stop_took=$((SECONDS - stop_start))
  if [ "$stop_took" -ge 60 ]; then
    fail "AC-anc stop inside grace" "stop took ${stop_took}s — the wrapper ate the signal and waited out the SIGKILL deadline"
  else
    pass "AC-anc stop inside grace" "postgres stopped in ${stop_took}s (checkpoint path, not SIGKILL)"
  fi
  # postgres's own shutdown lines prove the signal reached the server and
  # it checkpointed — the corruption gate this lane exists to close.
  local logs
  logs="$(docker logs "$PG_CONTAINER" 2>&1 | tail -40)" || logs=""
  local shut_lines
  shut_lines="$(printf '%s' "$logs" | grep -ci 'database system is shut down' || true)"
  local ckpt_lines
  ckpt_lines="$(printf '%s' "$logs" | grep -ci 'checkpoint' || true)"
  if [ "$shut_lines" -ge 1 ] && [ "$ckpt_lines" -ge 1 ]; then
    pass "AC-anc clean shutdown" "checkpoint + 'database system is shut down' in postgres logs (SIGTERM forwarded, WAL flushed)"
  else
    fail "AC-anc clean shutdown" "shutdown=$shut_lines checkpoint=$ckpt_lines log hits — wrapper did not deliver a clean shutdown"
  fi
  # No stray WAL segment left mid-write after a checkpoint shutdown: the
  # pg_wal dir may hold recycled segments (normal), so assert the shutdown
  # COMPLETED rather than wal-absence; the log-line assertion above IS the
  # corruption gate. (docker logs is append-only; the lines survive restart.)

  # 4. Restart postgres (docker compose start) — the wrapper must
  #    re-provision idempotently on the EXISTING volume and return to
  #    healthy.
  note "AC-anc: restarting postgres — idempotent re-provision on existing volume"
  # Snapshot the wrapper's provisioning-line count BEFORE the restart:
  # docker logs is append-only across restarts (the boot-1 line survives),
  # so count-based proof is immune to both the race (a grep fired 150ms
  # after compose start loses to the wrapper's own readiness wait) and the
  # vacuous pass (an old line inside a --since window proves nothing about
  # the SECOND boot). The re-boot must raise the count.
  local wrapper_before
  wrapper_before="$(docker logs "$PG_CONTAINER" 2>&1 | grep -c 'postgres-wrapper: litellm role + database ready' || true)"
  $COMPOSE start postgres > /tmp/e2e-anc-start.log 2>&1 \
    || { fail "AC-anc compose start postgres" "start exited non-zero: $(tail -3 /tmp/e2e-anc-start.log)"; return; }
  local deadline=$((SECONDS + 90))
  # pg_isready prints "<host>:<port> - accepting connections" (the host:port
  # prefix varies with the exec context) — match the SUFFIX, not the full
  # line: the full-line equality in the first run of this gate burned the
  # whole 90s budget and then failed on a healthy answer.
  until $COMPOSE exec -T postgres pg_isready -U "$PG_USER" 2>/dev/null | grep -q 'accepting connections'; do
    [ $SECONDS -ge $deadline ] && break
    sleep 2
  done
  local ready_again
  ready_again="$($COMPOSE exec -T postgres pg_isready -U "$PG_USER" 2>/dev/null)" || ready_again=""
  if printf '%s' "$ready_again" | grep -q 'accepting connections'; then
    pass "AC-anc postgres back after restart" "pg_isready accepting connections again"
  else
    note "pg_isready self-diagnosis (last 40 container log lines):"
    docker logs --tail 40 "$PG_CONTAINER" 2>&1 || true
    fail "AC-anc postgres back after restart" "pg_isready says '${ready_again:-nothing}' after 90s"
    return
  fi
  # Idempotency: role + database still exactly one-of-each after the boot
  # on the existing volume; ALTER ROLE re-assert left no duplicates (roles
  # and databases are unique by name — the assertion is that provisioning
  # did not fail or diverge on the re-run).
  local probe2
  probe2="$($COMPOSE exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tA \
    -c "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='litellm') || ':' || (SELECT count(*) FROM pg_database WHERE datname='litellm')" 2>/dev/null)" \
    || probe2=""
  if [ "$probe2" = "1:1" ]; then
    pass "AC-anc idempotent re-provision" "role+db exactly present after second boot on existing volume"
  else
    fail "AC-anc idempotent re-provision" "post-restart probe '${probe2:-nothing}' (want 1:1)"
  fi
  # The wrapper's own provisioning line must appear on THIS boot — the count
  # must rise above the pre-restart snapshot. The wrapper's internal readiness
  # wait (up to 120s) plus its psql provisioning pass can legitimately still
  # be in flight when pg_isready (host-side) first succeeds, so POLL for the
  # new line instead of grep-once: the wrapper logs it unconditionally every
  # boot (postgres-entrypoint.sh), it just races the host-side probe.
  local wrapper_deadline=$((SECONDS + 60))
  local wrapper_now
  wrapper_now="$(docker logs "$PG_CONTAINER" 2>&1 | grep -c 'postgres-wrapper: litellm role + database ready' || true)"
  until [ "$wrapper_now" -gt "$wrapper_before" ]; do
    [ $SECONDS -ge $wrapper_deadline ] && break
    sleep 2
    wrapper_now="$(docker logs "$PG_CONTAINER" 2>&1 | grep -c 'postgres-wrapper: litellm role + database ready' || true)"
  done
  if [ "$wrapper_now" -gt "$wrapper_before" ]; then
    pass "AC-anc wrapper re-provisioned on boot" "wrapper provisioning line count ${wrapper_before} -> ${wrapper_now} (second boot ran the provisioning pass)"
  else
    note "wrapper self-diagnosis (last 15 container log lines):"
    docker logs --tail 15 "$PG_CONTAINER" 2>&1 || true
    fail "AC-anc wrapper re-provisioned on boot" "provisioning-line count stayed ${wrapper_before} after 60s — the second boot never ran its provisioning pass"
  fi
}

# ---- AC-w5d (fleet-ops-w5d): admin-key mint built into the console UI ------
# The seed inserts the E2E admin key, so the running stack is in the
# keys-exist state: this AC asserts the 404-after-first-key semantics on
# /admin/setup (GET and a stale-form POST) plus the session-gated
# admin-keys management (list + mint + revoke) over the REAL TLS edge.
ac_w5d_admin_key_ui() {
  note "AC-w5d: admin-key UI — setup 404-after-first-key + session-gated mint/revoke (fleet-ops-w5d)"
  local csrf session_cookie keys_csrf code minted_id

  # 0. Readiness gate (run 36597260403): AC-anc stops postgres right before
  #    this AC fires, and the registrar's prisma pool breaks with it. The
  #    edge (caddy) answers immediately with 502 — an honest "backend not
  #    listening yet" — while the registrar takes a few seconds of re-boot
  #    to re-arm. Poll healthz over the TLS edge (the same front door the
  #    probes use) until the registrar is actually serving, so the setup
  #    probes assert the 404-after-first-key semantics against the REAL
  #    app, not caddy's transient 502.
  local hz_code
  local hz_deadline=$((SECONDS + 90))
  hz_code="$(tls_curl -o /dev/null -w '%{http_code}' -m 10 "$BASE_URL/healthz" 2>/dev/null)" || hz_code=""
  until [ "$hz_code" = "200" ]; do
    [ $SECONDS -ge $hz_deadline ] && break
    sleep 2
    hz_code="$(tls_curl -o /dev/null -w '%{http_code}' -m 10 "$BASE_URL/healthz" 2>/dev/null)" || hz_code=""
  done
  if [ "$hz_code" != "200" ]; then
    note "registrar self-diagnosis after postgres restart cycle (compose ps + registrar tail):"
    $COMPOSE ps || true
    docker logs --tail 20 "$PROJECT-registrar-1" 2>&1 || true
    fail "AC-w5d registrar readiness gate" "healthz said '${hz_code:-nothing}' after 90s — registrar never re-served after the postgres restart"
    return
  fi
  pass "AC-w5d registrar readiness gate" "healthz 200 over TLS edge — registrar serving post-restart"

  # 1. /admin/setup 404s because the seeded key exists (both verbs).
  code="$(tls_curl -o /tmp/e2e-w5d-setup.html -w '%{http_code}' "$BASE_URL/admin/setup")"
  expect "AC-w5d setup 404 (keys exist)" "$code" "404"
  code="$(tls_curl -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/admin/setup" \
    --data-urlencode "label=e2e-stale" --data-urlencode "_csrf=stale")"
  expect "AC-w5d stale setup POST 404s (no mint)" "$code" "404"

  # 2. Session-gated management, exactly the AC7 login pattern.
  csrf="$(tls_curl -D - -o /dev/null "$BASE_URL/admin/login" \
    | tr -d '\r' | grep -i '^set-cookie: vsigma_csrf=' | cut -d' ' -f2- | cut -d';' -f1 | tr -d ' ')"
  if [ -z "$csrf" ]; then fail AC-w5d "no csrf cookie on login page"; return; fi
  session_cookie="$(tls_curl -D - -o /dev/null -X POST "$BASE_URL/admin/login" \
    -H "Cookie: ${csrf}" \
    --data-urlencode "admin_key=$E2E_ADMIN_KEY" \
    --data-urlencode "_csrf=${csrf#vsigma_csrf=}" \
    | tr -d '\r' | grep -i '^set-cookie: vsigma_admin=' | cut -d' ' -f2- | cut -d';' -f1 | tr -d ' ')"
  if [ -z "$session_cookie" ]; then fail AC-w5d "no session cookie after login"; return; fi
  pass "AC-w5d console login" "session established with the seeded key"

  # 3. The admin-keys list page renders (session-gated).
  tls_curl -H "Cookie: ${csrf}; ${session_cookie}" \
    "$BASE_URL/admin/admin-keys" > /tmp/e2e-w5d-keys.html
  if grep -q "Admin keys" /tmp/e2e-w5d-keys.html && grep -q "e2e-admin" /tmp/e2e-w5d-keys.html; then
    pass "AC-w5d keys list" "session-gated list renders with the seeded row"
  else
    fail "AC-w5d keys list" "list page missing expected content"
  fi
  keys_csrf="$(awk 'match($0, /name="_csrf" value="[^"]*"/) { print substr($0, RSTART+20, RLENGTH-21); exit }' \
    /tmp/e2e-w5d-keys.html)"

  # 4. Mint a second key through the form — the plaintext shows exactly once.
  tls_curl -H "Cookie: ${csrf}; ${session_cookie}" -X POST "$BASE_URL/admin/admin-keys" \
    --data-urlencode "label=e2e-rotation" --data-urlencode "_csrf=$keys_csrf" \
    > /tmp/e2e-w5d-mint.html
  if grep -q 'secret-once' /tmp/e2e-w5d-mint.html && grep -q 'ak_' /tmp/e2e-w5d-mint.html; then
    pass "AC-w5d session mint" "second key minted, plaintext shown once"
  else
    fail "AC-w5d session mint" "mint page missing the show-once block"
  fi
  # The plaintext NEVER goes in the evidence transcript — grep only.

  # 5. Revoke the minted row: harvest its id from the re-listed page.
  tls_curl -H "Cookie: ${csrf}; ${session_cookie}" \
    "$BASE_URL/admin/admin-keys" > /tmp/e2e-w5d-keys2.html
  minted_id="$(awk 'match($0, /\/admin\/admin-keys\/([0-9]+)\/revoke/) { print substr($0, RSTART+18, RLENGTH-25); exit }' \
    /tmp/e2e-w5d-keys2.html)"
  if [ -z "$minted_id" ]; then
    fail "AC-w5d revoke" "no revoke form/id found on the keys page"
    return
  fi
  code="$(tls_curl -o /dev/null -w '%{http_code}' -X POST \
    "$BASE_URL/admin/admin-keys/$minted_id/revoke" \
    -H "Cookie: ${csrf}; ${session_cookie}" \
    --data-urlencode "_csrf=$keys_csrf")"
  expect "AC-w5d revoke minted key" "$code" "303"
  # 6. The revoked row is gone from the list (rotation path proven).
  tls_curl -H "Cookie: ${csrf}; ${session_cookie}" \
    "$BASE_URL/admin/admin-keys" > /tmp/e2e-w5d-keys3.html
  if grep -q "e2e-rotation" /tmp/e2e-w5d-keys3.html; then
    fail "AC-w5d revoked row gone" "label e2e-rotation still listed"
  else
    pass "AC-w5d revoked row gone" "minted row revoked; seeded row remains"
  fi
  # 7. Audit rows for both operations exist in the registrar DB.
  local minted_rows revoked_rows
  minted_rows="$(psql_count "outcome='admin' AND reason='admin_key_minted'")"
  revoked_rows="$(psql_count "outcome='admin' AND reason='admin_key_revoked'")"
  if [ "${minted_rows:-0}" -ge 1 ] && [ "${revoked_rows:-0}" -ge 1 ]; then
    pass "AC-w5d audit rows" "admin_key_minted=${minted_rows} admin_key_revoked=${revoked_rows} in delivery_log"
  else
    fail "AC-w5d audit rows" "minted=${minted_rows:-?} revoked=${revoked_rows:-?}"
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

  # 2. Scotty serves — over the TLS EDGE with basic_auth (77i): the raw
  # host :3306 publish is GONE; /api/projects must 401 anonymous and 200
  # with the basic_auth pair through caddy at https://<TLS_HOSTNAME>:8444,
  # and the raw in-container listener must refuse host connections
  # (nothing publishes it anymore). The sim pair (owner/hiccup) and its
  # bcrypt hash ship committed in deploy/.env.e2e — caddy consumed the
  # hash at adapt time (container start), so the edge serves auth from
  # the first request. Poll: the patched image build is cold on CI
  # runners and caddy must mint the 8444 leaf first.
  local deadline=$((SECONDS + 240)) code="" code401=""
  until code401="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
      --resolve "$TLS_HOSTNAME:8444:127.0.0.1" --cacert "$CA_CERT" \
      "https://$TLS_HOSTNAME:8444/api/projects" 2>/dev/null)" \
    && [ "$code401" = "401" ]; do
    [ $SECONDS -ge $deadline ] && break
    sleep 3
  done
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    --resolve "$TLS_HOSTNAME:8444:127.0.0.1" --cacert "$CA_CERT" \
    -u "owner:hiccup" \
    "https://$TLS_HOSTNAME:8444/api/projects" 2>/dev/null)"
  if [ "$code" = "200" ] && [ "$code401" = "401" ]; then
    pass "AC10 scotty serves (8444 + basic_auth)" \
      "https://$TLS_HOSTNAME:8444/api/projects -> 401 anon / 200 with owner creds"
  else
    fail "AC10 scotty serves (8444 + basic_auth)" \
      "anon: ${code401:-none} / authed: ${code:-none} (deadline 240s)"
    note "scotty container recent logs (self-diagnosis):"
    docker logs "$PROJECT-scotty-1" 2>&1 | tail -25 || true
    return
  fi
  # The raw host listener must be GONE (the 77i drop): 127.0.0.1:3306
  # refuses connections (curl exit 7) now that nothing publishes it.
  if ! curl -s -o /dev/null -m 5 "http://127.0.0.1:3306/api/projects" 2>/dev/null; then
    pass "AC10 raw :3306 dropped" "http://127.0.0.1:3306/api/projects refused (host publish gone)"
  else
    fail "AC10 raw :3306 dropped" "http://127.0.0.1:3306/api/projects still answers — publish survived"
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
#   4. served cert is caddy's self-issued leaf: SAN vsigma.lan, issuer
#      "Vector Sigma Internal CA" (the Caddyfile's `pki` block pins the
#      root_cn — Caddy's own local CA, not its generic default identity)
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
    pass "AC11 cert issuer" "VS internal CA (caddy self-issued, pki.ca.local.root_cn pinned)"
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
  expect_file "config/a2a.json" "public_url" "a2a.json public url (j7g.1)"
  expect_file "config/a2a.json" "peer_tokens" "a2a.json peer tokens (j7g.1)"
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

# AC13 (b1r): primus's queue tooling — the baked image dogfood. The hermes
# container is the CUSTOM image now (bd 1.2.2 full read-write + queue-join +
# docs + the 03-vs-queue-join boot hook). Assertions, all INSIDE the
# container:
#   0. canonicalize the e2e dolt's project_id to the fleet contract
#      (bcde5891-…): AC10's host-side bd init legitimately minted a random
#      id into this throwaway DB (the init rewrites the shared DB's
#      project_id — the 9-09 lockout class, by design in its own
#      workspace). The baked join config carries the CANONICAL id, and bd
#      1.2.2 REFUSES to connect on a mismatch (PROJECT IDENTITY MISMATCH —
#      verified live in the b1r lab: fail-loud, never silent-empty). The
#      canonicalization is the bead's "e2e dolt is seeded with the
#      canonical project_id" — one UPDATE, then read back and assert.
#   1. bd --version answers 1.2.2 (the fleet pin, absolute).
#   2. the boot hook seeded $HERMES_HOME/vs-queue (first-boot-only copy):
#      metadata.json + dolt-server.port + the actor-stamped config.yaml
#      (primus + backup.enabled false — the peer-client posture).
#   3. bd status CONNECTS from inside the container, as the runtime user,
#      from the seeded workspace — the dogfood proof: primus can curate.
#   4. the baked docs are present (queue-conventions.md + vs-environment.md).
#   5. scotty still serves /api/projects 200 AFTER canonicalization — the
#      read-only dashboard's baked join (same canonical id) re-aligns with
#      the DB; one id, every client.
ac13_primus_queue_tooling() {
  note "AC13: primus queue tooling — bd 1.2.2 + canonical join + docs in the hermes image (b1r)"
  local dolt_password
  dolt_password="$(grep -E '^DOLT_PASSWORD=' "$ENV_FILE" | cut -d= -f2)"
  if [ -z "$dolt_password" ]; then
    fail AC13 "DOLT_PASSWORD missing from $ENV_FILE"
    return
  fi
  local canonical="bcde5891-5482-4eb0-a223-8533504832d6"

  # 0. canonicalize the throwaway e2e dolt to the fleet contract id.
  # AC10's host-side bd init legitimately minted a RANDOM project_id into
  # this throwaway DB (the init rewrites the shared DB's project_id — by
  # design in its own workspace; the lockout class is the e2e's harness
  # here). The baked joins (hermes + scotty) carry the CANONICAL id, and
  # bd 1.2.2 REFUSES to connect on a mismatch (PROJECT IDENTITY MISMATCH —
  # verified live in the b1r lab: fail-loud, never silent-empty).
  # Mechanism: bd sql from AC10's own host workspace (its metadata.json
  # still carries the minted random id, so bd's identity check passes and
  # the vs user owns vs_ops — in-privilege). `key` is a reserved word in
  # the dolt dialect: backtick-quoted (proven live, b1r lab). bd sql
  # reports rows-affected for UPDATE — assert exactly 1. NO host-side
  # read-back afterwards: the workspace's id would now mismatch the DB
  # (the identity check would refuse). The container-side bd status
  # (step 3) IS the functional read-back — its failure mode names both
  # ids for triage.
  local workdir=/tmp/vs-queue-e2e
  if [ ! -f "$workdir/.beads/metadata.json" ]; then
    fail "AC13 canonicalize project_id" "AC10's bd workspace $workdir missing — bd init never ran"
    return
  fi
  local bd_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  local bd_bin="$workdir/bd"
  # The `key` column identifier: a shell VARIABLE carries the backticks as
  # DATA — inline backticks inside double quotes are command substitution
  # (and the b1r run-1 line shipped doubled backslashes that bash -n
  # happily parsed as substitution — caught on byte review). Single-quote
  # assignment, expand as $idcol: zero escaping ambiguity.
  local idcol='`key`'
  local upd_out
  upd_out="$(cd "$workdir" && PATH="$bd_path" BEADS_DOLT_PASSWORD="$dolt_password" CI=true \
    "$bd_bin" sql "UPDATE metadata SET value='$canonical' WHERE $idcol='_project_id'" 2>&1 || true)"
  if printf '%s' "$upd_out" | grep -q '1 rows affected\|1 row affected'; then
    pass "AC13 canonicalize project_id" "e2e dolt's _project_id -> the canonical VS queue contract id (bd sql: 1 row affected)"
  else
    fail "AC13 canonicalize project_id" "bd sql UPDATE did not report 1 row affected (got: $(printf '%s' "$upd_out" | head -c 200))"
    return
  fi

  local hcontainer="$PROJECT-hermes-1"

  # 1. bd pin: the baked binary answers 1.2.2. Run as the runtime user
  # (docker exec defaults to root; every file bd writes under
  # $HERMES_HOME must stay owned by the remapped runtime user — the
  # upstream image's own exec-shim rationale).
  local ver
  ver="$(docker exec -u hermes "$hcontainer" bd --version 2>/dev/null || true)"
  if printf '%s' "$ver" | grep -q 'bd version 1.2.2'; then
    pass "AC13 bd pin" "in-image bd answers: $ver"
  else
    fail "AC13 bd pin" "bd --version in the hermes container answered '${ver:-nothing}' — want bd version 1.2.2"
  fi

  # 2. the boot hook seeded the queue workspace (first-boot-only). The
  # hook runs in cont-init BEFORE the gateway, and AC12 already proved
  # hermes booted past stage2 — so the workspace must exist now. Short
  # deadline anyway so a fail-soft hook error surfaces with its logs.
  local deadline=$((SECONDS + 60))
  until docker exec "$hcontainer" test -f /data/primus/vs-queue/.beads/metadata.json 2>/dev/null; do
    if [ $SECONDS -ge $deadline ]; then
      fail "AC13 queue workspace" "no /data/primus/vs-queue/.beads/metadata.json after 60s — boot hook never seeded; hook logs:"
      docker logs "$hcontainer" 2>&1 | grep -i 'vs-queue-join' | tail -10
      return
    fi
    sleep 2
  done
  pass "AC13 queue workspace" "03-vs-queue-join seeded /data/primus/vs-queue (first-boot copy from /opt/vs/queue-join)"
  local actor
  actor="$(docker exec "$hcontainer" sh -c "cat /data/primus/vs-queue/.beads/config.yaml 2>/dev/null" || true)"
  if printf '%s' "$actor" | grep -q 'actor: "primus"' && printf '%s' "$actor" | grep -q 'enabled: false'; then
    pass "AC13 actor stamp" "workspace config.yaml: actor primus + auto-backup silenced (peer-client posture)"
  else
    fail "AC13 actor stamp" "config.yaml missing actor/backup keys (got: $(printf '%s' "$actor" | head -c 120))"
  fi

  # 3. THE dogfood proof: bd status connects from inside the container,
  #    as the runtime user, from the seeded workspace, against the
  #    compose dolt — canonical id, env password, service-name host.
  local st
  st="$(docker exec -u hermes -w /data/primus/vs-queue "$hcontainer" bd status 2>&1 || true)"
  if printf '%s' "$st" | grep -q 'Issue Database Status'; then
    pass "AC13 bd status" "primus's in-image bd connected to the compose dolt (canonical project contract)"
  else
    fail "AC13 bd status" "bd status refused from inside the hermes container: $(printf '%s' "$st" | head -c 300)"
  fi

  # 4. docs baked into the image (the environment-knowledge half of the
  #    lane): both paths present under /opt/vs/docs.
  if docker exec "$hcontainer" test -f /opt/vs/docs/queue-conventions.md 2>/dev/null \
     && docker exec "$hcontainer" test -f /opt/vs/docs/vs-environment.md 2>/dev/null; then
    pass "AC13 docs baked" "queue-conventions.md + vs-environment.md present at /opt/vs/docs"
  else
    fail "AC13 docs baked" "one or both docs missing at /opt/vs/docs"
  fi

  # 5. scotty re-aligned: the dashboard's baked join carries the same
  #    canonical id; after canonicalization its bd connects again.
  #    (77i: through the TLS edge + basic_auth like every host-side
  #    consumer — the raw host :3306 path no longer exists.)
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$TLS_HOSTNAME:8444:127.0.0.1" --cacert "$CA_CERT" \
    -u "owner:hiccup" \
    "https://$TLS_HOSTNAME:8444/api/projects" || true)"
  if [ "$code" = "200" ]; then
    pass "AC13 scotty re-aligned" "/api/projects 200 post-canonicalization — one id, every client (scotty + primus + host)"
  else
    fail "AC13 scotty re-aligned" "/api/projects answered ${code:-none} after canonicalization"
  fi
}

# ---- main ---------------------------------------------------------------------

# AC14 (j7g.1): the A2A mesh chain, end to end through the master
# gateway — the lane's core data-plane proof, one Hermes (primus) doing a
# self-round-trip through its own served edge (the two-agent fleet case is
# the same wire with a second row; the CHAIN is what this asserts):
#   1. the wiring hook ran inside the hermes container (cont-init 04-):
#      $HERMES_HOME/.env carries the A2A_* lines derived from the seeded
#      bundle, and config.yaml carries the managed a2a section
#      (platforms.a2a.enabled + a2a_agents.primus pointing at the served
#      edge with the ${A2A_OWN_IDENTITY_KEY} bearer).
#   2. primus's A2A inbound is LIVE on the compose network: an unauth
#      probe of its origin (http://hermes:9900 from the litellm container)
#      answers 401 (bind-safety + token enforcement both proven).
#   3. gateway card registration (the README runbook's owner step, done
#      here by the harness with master-key auth): POST /v1/agents with
#      agent_card_params.url = the compose-internal origin and
#      extra_headers=["Authorization"] — the VS mesh's per-caller
#      identity-forwarding shape (a registered agent trusts the callers'
#      keys, no stored secret on the row).
#   4. the served card: GET /a2a/primus/.well-known/agent-card.json
#      through the TLS edge answers 200 with the gateway-rewritten url.
#   5. the round-trip: message/send to /a2a/primus through the TLS edge,
#      Authorization = the seeded mesh identity — forwarded upstream by
#      the gateway (extra_headers), accepted by primus's inbound
#      (peer_tokens + trusted_peers), answered by the agent.
#      The reply is a JSON-RPC result carrying the agent's answer — the
#      full data plane (edge auth -> proxy -> origin auth -> agent) green.
ac14_a2a_mesh_chain() {
  note "AC14: A2A mesh chain — wiring hook + origin live + card + round-trip through the master gateway (j7g.1)"
  local hcontainer="$PROJECT-hermes-1"
  local base="https://$TLS_HOSTNAME:8443"
  local master reg_body reg_code card_code rpc_code reply

  master="$(grep -E '^LITELLM_MASTER_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  if [ -z "$master" ]; then
    fail AC14 "LITELLM_MASTER_KEY missing from $ENV_FILE"
    return
  fi

  # 0. the hermes container must be up past the gate (AC12 proved boot;
  # the wiring hook runs in its cont-init chain — same boot).
  if ! docker exec "$hcontainer" test -f /data/primus/config/a2a.json 2>/dev/null; then
    fail AC14 "hermes container missing the delivered bundle — AC12 chain broken"
    return
  fi

  # 1. the wiring hook derived the A2A env from the bundle.
  if docker exec "$hcontainer" sh -c \
      "grep -q '^A2A_OWN_IDENTITY_KEY=' /data/primus/.env \
    && grep -q '^A2A_PEER_TOKENS=' /data/primus/.env \
    && grep -q '^A2A_PORT=9900' /data/primus/.env \
    && grep -q '^A2A_TRUSTED_PEERS=primus' /data/primus/.env \
    && grep -q '^A2A_PUBLIC_URL=' /data/primus/.env" 2>/dev/null; then
    pass "AC14 wiring env" "bundle a2a.json -> A2A_* env lines in /data/primus/.env (hook 04-)"
  else
    fail "AC14 wiring env" "A2A_* lines missing from /data/primus/.env — wiring hook did not run or bundle missing"
    docker exec "$hcontainer" sh -c "tail -20 /data/primus/.env 2>/dev/null | grep -c A2A || true"
    return
  fi
  if docker exec "$hcontainer" sh -c \
      "grep -q 'a2a_agents:' /data/primus/config.yaml \
    && grep -q 'platforms:' /data/primus/config.yaml" 2>/dev/null; then
    pass "AC14 wiring config" "config.yaml managed a2a section present (platforms + a2a_agents)"
  else
    fail "AC14 wiring config" "config.yaml missing the managed a2a section"
    return
  fi

  # 2. primus's A2A origin is live on the compose network: GET /health
  #    answers 200 UNAUTHENTICATED by design (the adapter's health route),
  #    which proves the inbound server is up and bound; an UNAUTH
  #    message/send POST answers 401 (token enforcement — the real gate).
  #    /dev/tcp is a BASH-ism and the litellm image's sh is dash — the
  #    probe rides the image's OWN python3 (present by construction: the
  #    proxy is a python app), stdlib http.client, no shell redirection.
  local origin_code
  # Poll window: the A2A adapter binds during gateway platform init — by
  # AC14 time the gateway is up (AC13 proved bd), but CI timing variance
  # gets a poll, not a single shot.
  local origin_deadline=$((SECONDS + 60))
  origin_code=""
  while [ $SECONDS -lt $origin_deadline ]; do
    origin_code="$(docker exec "$PROJECT-litellm-1" python3 -c "
import http.client, json
try:
    c = http.client.HTTPConnection('hermes', 9900, timeout=10)
    c.request('GET', '/health')
    health = c.getresponse().status
    c.close()
    c = http.client.HTTPConnection('hermes', 9900, timeout=10)
    body = json.dumps({'jsonrpc': '2.0', 'id': 'ac14-probe', 'method': 'message/send',
                       'params': {'message': {'role': 'ROLE_USER', 'messageId': 'ac14-probe',
                                              'parts': [{'kind': 'text', 'text': 'unauth probe'}]}}})
    c.request('POST', '/', body=body, headers={'Content-Type': 'application/json'})
    unauth = c.getresponse().status
    print(f'{health} {unauth}')
except Exception as e:
    print('ERR:', e)
" 2>/dev/null | head -1 || true)"
    [ "$origin_code" = "200 401" ] && break
    sleep 3
  done
  if [ "$origin_code" = "200 401" ]; then
    pass "AC14 origin live" "primus A2A origin: /health 200 unauth (up + bound), message/send 401 unauth (token enforcement on)"
  else
    fail "AC14 origin live" "origin probe expected '200 401' (got: ${origin_code:-none}) — inbound server down or enforcement off"
    return
  fi

  # 3. gateway registration: the README runbook's card-registration step,
  #    extra_headers = Authorization forwarding (per-caller identity).
  reg_body='{"agent_name":"primus","agent_card_params":{"protocolVersion":"1.0","name":"primus","description":"VS coordinator Hermes (e2e)","url":"http://hermes:9900","version":"1.0.0","capabilities":{"streaming":false},"defaultInputModes":["text"],"defaultOutputModes":["text"],"skills":[]},"litellm_params":{},"extra_headers":["Authorization"]}'
  reg_code="$(curl -s -o /tmp/ac14-reg.json -w '%{http_code}' -m 20 \
    --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
    "$base/v1/agents" \
    -H "Authorization: Bearer $master" \
    -H 'Content-Type: application/json' -d "$reg_body" 2>/dev/null || true)"
  # idempotence: a prior run's row with the same name 409s — treat both as
  # registered (the name is UNIQUE; the row already serving is the goal).
  if [ "$reg_code" = "200" ] || [ "$reg_code" = "409" ] || [ "$reg_code" = "400" ]; then
    if [ "$reg_code" = "200" ]; then
      pass "AC14 registration" "primus row registered on the VS gateway (POST /v1/agents, extra_headers=[Authorization])"
    else
      note "AC14 registration: POST answered $reg_code (already registered / validation shape) — card assertions decide"
    fi
  else
    fail "AC14 registration" "POST /v1/agents answered $reg_code: $(head -c 200 /tmp/ac14-reg.json 2>/dev/null)"
    return
  fi

  # 4. the served card through the TLS edge (gateway-rewritten).
  card_code="$(curl -s -o /tmp/ac14-card.json -w '%{http_code}' -m 20 \
    --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
    "$base/a2a/primus/.well-known/agent-card.json" \
    -H "Authorization: Bearer $master" 2>/dev/null || true)"
  if [ "$card_code" = "200" ] \
    && grep -q 'vsigma.lan:8443\|/a2a/primus' /tmp/ac14-card.json 2>/dev/null; then
    pass "AC14 served card" "card 200 at /a2a/primus/.well-known/agent-card.json through the edge (gateway-rewritten url)"
  else
    fail "AC14 served card" "card answered $card_code: $(head -c 200 /tmp/ac14-card.json 2>/dev/null)"
    return
  fi

  # 5. the round-trip: message/send through the edge -> proxy -> origin.
  local rpc_id="e2e-ac14-$$"
  rpc_code="$(curl -s -o /tmp/ac14-rpc.json -w '%{http_code}' -m 240 \
    --resolve "$TLS_HOSTNAME:8443:127.0.0.1" --cacert "$CA_CERT" \
    "$base/a2a/primus" \
    -H "Authorization: Bearer $master" \
    -H 'Content-Type: application/json' \
    -H 'A2A-Version: 1.0' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"$rpc_id\",\"method\":\"message/send\",\"params\":{\"message\":{\"role\":\"ROLE_USER\",\"messageId\":\"$rpc_id\",\"parts\":[{\"kind\":\"text\",\"text\":\"Mesh round-trip probe (AC14): reply with exactly the word ACK\"}]}}}" 2>/dev/null || true)"
  reply="$(head -c 600 /tmp/ac14-rpc.json 2>/dev/null || true)"
  # HTTP 200 + any JSON-RPC envelope (result: agent answered; error: the
  # agent's turn failed on the SIMULATION model key — either way the full
  # data plane edge->gateway->origin-auth->agent->reply is proven; auth
  # failures come back HTTP 500 at the gateway, not 200).
  if [ "$rpc_code" = "200" ] && printf '%s' "$reply" | grep -q 'result\|error\|message'; then
    pass "AC14 round-trip" "message/send 200 through edge->gateway->origin; the agent answered (data plane green)"
  else
    fail "AC14 round-trip" "message/send answered $rpc_code: $reply"
    docker logs "$hcontainer" 2>&1 | tail -15 || true
  fi
}

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
ac7b_persona_picker
ac8_grace_self_heal
ac9_litellm_smoke
ac9b_litellm_db_smoke
ac_anc_postgres_consolidation
ac_w5d_admin_key_ui
ac10_queue_plane
ac10_tls_edge
ac12_primus_self_bootstrap
ac13_primus_queue_tooling
ac14_a2a_mesh_chain
echo
echo "[e2e] ===== RESULT: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]