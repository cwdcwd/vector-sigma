# Devices-fleet canary release checklist

Per-release verification for the devices fleet. One canary device takes the new release first; nothing advances until every item here passes. Works entirely from the balenaCloud dashboard — no device shell access required.

For fleet/release policy context see [balena-architecture.md](balena-architecture.md); for provisioning see [balena-devices-runbook.md](balena-devices-runbook.md).

## 1. Before the tag

- [ ] CI green on the PR that touched `balena/devices/` (test + e2e jobs).
- [ ] PR reviewed and approved; merged by the submitter (merge convention 2026-09-19).
- [ ] Vendored-source drift test green (it runs in the unit-test job).
- [ ] `balena/devices/README.md` still matches the shipped compose shape.

## 2. Build the release

- [ ] Push the `devices-v*` tag → GitHub Actions `deploy-devices.yml` builds a final release on balena remote builders.
- [ ] Workflow ends green; note the **release id** from the workflow log (`Built release <id>`).
- [ ] Dashboard → Devices fleet → *Releases*: the new release appears as **final** (not draft).

## 3. Canary: pin, deploy, verify identity state

- [ ] Pin the canary device to the new release: dashboard → device → *Fleet/target release* (or CLI `balena device pin <UUID> <COMMIT>`). The device pulls and updates; wait for **Running** on both services.
- [ ] **Post-update identity state** (the reflash-recovery guarantee): device logs show `identity present, skipping fetch` on registrant restart — no re-fetch, no identity loss across the container update.
- [ ] Ready marker intact: registrant log `[registrant:info] identity present` (no bootstrap path) — the marker survived the release update.
- [ ] Agent gate open: `[gate] identity present … starting agent runtime` in agent logs — agent did not restart into a locked gate.
- [ ] Both containers **Running** and healthy (healthcheck process-liveness, 30s interval).
- [ ] Bundle + marker on the volume are still mode 0600 (the CI e2e job asserts this end-to-end for the deliverable path — the compose-simulated device reads the same `ready.marker` gate — so a green e2e run covers the image shape; the canary adds the identity-present log evidence).

## 4. Kill-test (restart contract)

- [ ] From the dashboard, restart each container (device → *Restart service*). The supervisor stops it (SIGTERM under the compose `stop_grace_period`) and starts a fresh one.
- [ ] Container comes back **Running** within a minute, no crash loop.
- [ ] Registrant logs show the identity-present path again (no re-fetch), agent gate re-opens.

## 5. SIGTERM/WAL evidence standard

For the real agent runtime (placeholder heartbeat has no WAL): on the supervised stop of §4, the runtime must trap SIGTERM, finish in-flight work, flush write-ahead logs, and exit clean. Evidence:

- [ ] Stop is clean within `stop_grace_period` (60s agent): the dashboard shows the container exiting, not being SIGKILLed at the grace deadline (a grace-deadline kill is a failed stop).
- [ ] Zero-byte or absent `-wal` files after the supervised stop, checked on every state database (dashboard logs can't show files — assert via the runtime's own log line acknowledging a clean shutdown, and for state DBs, the first post-restart startup scan reporting no recovery).

## 6. Advance the fleet

- [ ] Every checklist item green on the canary.
- [ ] Advance the fleet pin: dashboard → Devices fleet → *Release pin* (or `balena fleet pin g_c_d/vector-sigma <COMMIT>`); every unpinned device updates.
- [ ] Clear the canary's device pin (device → *Track fleet*) so it rejoins fleet policy — a left pin blocks the next canary cycle.
- [ ] Spot-check one non-canary device: both services Running, identity-present path in logs.

## Evidence standard for the bead thread

Post the release id, both containers' post-update states, the identity-present log lines (canary), kill-test result, and the fleet-advance + canary-pin-clear commands with timestamps. Cite CI e2e AC3 (425/Retry-After mandatory retry path) as the deterministic proof of the registrant's bootstrap retry behavior — the canary exercises the identity-present path instead.