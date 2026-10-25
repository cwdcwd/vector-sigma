# VS boot workflows — operator runbook (fleet-ops-1py.47.3)

What happens on every device boot (primus coordinator or worker), who
holds the credentials, how to pilot a change, and how to roll back.
The contracts here are enforced by two suites:

- **Unit (CI)**: `images/common/bin/test_vs_bootworkflows.py` — runs the
  real hook scripts in a sandboxed `$HERMES_HOME` fixture (offline; no
  docker, no real queues, no real credentials).
- **Real-image E2E (CI)**: `test/e2e/e2e.sh` **AC20** — restart
  idempotency, queue-unavailable recovery and the router's dark→live
  gate on the actual image over the actual dolt.

## 1. What boots when

| Order | Piece | Contract |
|---|---|---|
| 1 | `04-vs-a2a-wiring` (cont-init) | Merges the delivery bundle's `agent.env` + `secrets.env` into `$HERMES_HOME/.env`; derives `A2A_*` server env from `config/a2a.json`. **Bind-safety**: without `identity_key` the `A2A_*` server keys are REMOVED from `.env` — inbound A2A never starts un-keyed. Malformed bundle lines are skipped loudly; no bundle = wiring skipped. |
| 2 | `05-vs-github-identity` (cont-init) | With a bundle identity (`agent.env` `GH_APP_ID`/`GH_APP_SLUG` + `github-app.pem`): writes `GH_APP_PEM_PATH` + the `GIT_CONFIG_*` managed block (credential helper → `/usr/local/bin/vs-github-identity cred`, `user.name slug[bot]`, `user.email <id>+slug[bot]@users.noreply.github.com`) into the 0600 `.env`. Without (or partial): the whole block is removed wholesale — no stale credential path survives a revoked identity. |
| 3 | `06-vs-memory-tools` (cont-init) | Refreshes the baked `gateway-memory` plugin into `$HERMES_HOME/plugins/` (stale copies removed, `__pycache__` excluded); seeds `plugins.enabled` in `config.yaml` when the image's python has PyYAML and the config exists. Every broken path fails SOFT (loud log, no brick). |
| 4 | `03-vs-queue-join` (cont-init, primus image) | Copies the baked `vs_ops` queue join (`.beads/metadata.json` + `dolt-server.port`) into `$HERMES_HOME/vs-queue/:memory:.beads` — CONFIG-ONLY, never `bd init` (a second init would rewrite the shared DB's project id — the 9-09 lockout class). Stamps `config.yaml` `actor: "primus"` + silences auto-backup. **First-boot-only**: an existing workspace is left byte-identical ("already seeded — first-boot-only contract"). Verifies the baked bd answers `1.2.2` (the fleet pin is absolute); drift → loud WARNING, boot continues. |
| 5 | `vs-hub-router` (s6 longrun) | DARK until configured: with `VS_HUB_AGENTS` unset (or the binary missing) the run exits 0 and `finish` returns 125 — the slot stays down, no restart loop, nothing touches the board. With a roster: sweeps stage-ready beads against WIP caps every 2 min and routes stage agents' `HANDOFF:` comments via board metadata (j7g.1). Full contracts: `docs/vs-hub-router.md`, tests `test_vs_hub_router.py`. |
| 6 | `a2a-guard` (s6 longrun) | Same dark posture: no `a2a-guard/guard.json` under `$HERMES_HOME` → exit 0 + finish 125. With a guard config → serves the localhost guard (j8k.1). |

The s6 `finish` scripts encode the contract: **125 = dark, don't wake
me; 0 = healthy shutdown, restart me.** The E2E proves the dark→live
gate on the real init tree (AC20 step 4).

## 2. Credential custody

**Rule of thumb: nothing long-lived ever lives in an image, a cont-init
hook, or the environment beyond the minted-token lifetime.**

- **GitHub App** — the private key (`.pem`) is an owner-side artifact:
  it arrives only through the registrar bundle (`config/github-app.pem`)
  on the data volume, mode 0600. It is NEVER baked into an image, never
  in env vars, never copied by a hook. The boot hook only stores the
  PATH (`GH_APP_PEM_PATH`); the wrapper reads the key strictly at JWT
  mint time (in-memory, never logged — asserted by the suite's canary
  tests). Tokens are per-operation, minted on demand, scoped by GitHub
  to `cwdcwd/vector-sigma`, and die within hours.
- **Rotation**: rotate the App key in the GitHub org settings →
  re-deliver a new `.pem` through the registrar (structured save →
  device re-delivery, the AC3/AC7 shape). No image rebuild; no device
  wipe. The 05- boot hook swaps `GH_APP_PEM_PATH`/derived git env on the
  next boot — restart the device service(s) to re-run cont-init.
- **Queue plane** — the dolt password rides the composition env
  (`BEADS_DOLT_PASSWORD`, fleet variable cascade / compose entry),
  mirroring the scotty posture; it is never on a data volume and never
  in an image layer.
- **A2A** — identity/peer keys live in the delivered bundle
  (`config/a2a.json`) and are merged by the 04- hook into the 0600
  `.env`. Signed-identity mode (peer_keys) additionally requires the
  gateway-side guard config — see the guard's own suite
  (`images/common/bin/test_vs_a2a_guard.py`) and the 04- hook header
  for the contract.
- **Never** put credential-shaped values in the boot surface: the suite
  scans hooks + s6 services + the baked join for `ghp_`/`ghs_`/`sk-`/
  PEM blocks and fails CI on a hit.

## 3. Pilot (change → fleet)

1. **Write the contract first**: behavior changes to a boot hook or s6
   service get a fixture test in `test_vs_bootworkflows.py` (or the
   service's own suite) BEFORE the change — the suite runs the real
   scripts; drift in a log literal or path shows up as a test failure
   with the drifted literal named.
2. **Unit proof**: `python -m unittest images/common/bin/test_vs_bootworkflows.py`
   locally (offline; CI runs it in the `boot-workflow tests` step).
3. **Real-image proof**: open the PR; the images workflow builds the
   images and runs the compose E2E — **AC20** covers restart
   idempotency, queue outage/recovery and the router gate on your exact
   bytes. For a primus-image change, also eyeball the AC12/AC13 output
   in the same run (self-bootstrap + queue tooling are the same boot
   chain).
4. **One device first**: promote the image tag for ONE device (balena or
   `VS_IMAGE_TAG` on a single compose host) and watch the boot:
   `docker logs <device>-hermes-1 2>&1 | grep -E 'vs-(queue-join|a2a-wiring|github-identity|memory-tools)|hub-router'`
   The 03- hook must say `already seeded — first-boot-only contract` on
   any device with data; the router stays `idle` unless a roster is
   intended.
5. **Fleet-wide** only after the pilot boots clean and `bd status`
   answers inside the container (`-u hermes -w
   $HERMES_HOME/vs-queue`).

## 4. Rollback

- **Image-level (the normal case)**: repoint the device/fleet tag at the
  previous image SHA and restart the service. Every hook is designed to
  re-run over an existing volume: the 03- join leaves a seeded workspace
  untouched, the 04-/05- blocks are re-derived deterministically from
  the bundle, the 06- refresh re-copies. A ROLLBACK of the image is the
  rollback of the hooks, router and docs together — the volume never
  needs wiping.
- **Router-specific**: the router is dark by default. Removing
  `VS_HUB_AGENTS` (fleet variables / compose env) plus a device
  container restart parks the longrun (idle + finish 125) without
  touching the queue or the agents — this is the fast brake if routing
  misbehaves.
- **Identity-specific**: revoking the App installation (or deleting
  `GH_APP_ID` from the bundle and re-delivering an identity-less
  bundle) makes the 05- hook REMOVE the whole `GIT_CONFIG_*` managed
  block on the next boot — git operations fail-closed instead of riding
  a stale identity. Verify with
  `docker exec <c> sh -c 'grep -c GIT_CONFIG /data/primus/.env'` → `0`.
- **Never** hand-edit the baked `vs_ops` join or the shared DB with
  `bd init`-class operations on a device; if the workspace contract
  drifted, wipe the device's `vs-queue` directory and let the hook
  re-seed from the (corrected) image on next boot.

## 5. Failure playbook (what you see, what it means)

| Log line | Meaning | Action |
|---|---|---|
| `03-…skipping seed (image build broken)` | the baked queue join is missing | rebuild the hermes image; agent still boots |
| `03-…cannot create … volume not ready` | volume not mounted/writable | check the device volume; hook retries on next boot |
| `03-…WARNING: baked bd answers '…'` | bd version pin drift | rebuild with `BD_VERSION=1.2.2`; pin is absolute |
| `04-…A2A inbound stays OFF` | no config/a2a.json in the bundle, or no identity_key in it (bind-safety default) | expected until a signed/a2a bundle is delivered |
| `05-…GitHub App identity present (app <slug>, id <id>) — deriving git env` | identity re-wired on boot | expected with a provisioned identity |
| `05-…removing managed GitHub env (identity not provisioned / partial identity treated as absent)` | identity absent or partial → the whole GIT_CONFIG_* block removed | expected without a provisioned identity; investigate only if one was supposed to exist |
| `06-…memory tools unavailable this boot` | baked plugin missing | rebuild the image; agent boots without the memory plane |
| `06-…no yaml module — cannot seed plugins.enabled` | PATH python lacks PyYAML | expected on non-image interpreters; the seed happens with the venv python (AC16 in the E2E) |
| `[vs-hub-router] idle: no VS_HUB_AGENTS roster` | router dark (default) | set the roster env + restart the container to enable |
| `[a2a-guard] idle: no guard.json` | guard dark (default) | create the guard config (j8k.1 docs) to enable |