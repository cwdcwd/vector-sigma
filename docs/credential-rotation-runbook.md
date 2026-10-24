# Credential rotation runbook (fleet-ops-1py.24)

How to rotate a fleet credential — an agent's A2A identity key, a gateway
model key, or (manually) a device's bootstrap key — without a failed send and
without a window where nothing accepts.

**The core rule is deliver-then-revoke.** No old key is deleted before the
replacements (new canonical + old-as-overlap) are confirmed applied by every
device that needs them. The registrar's rotation registry
(`credential_rotations` in Postgres) tracks every step across restarts; rows
are the source of truth, not operator memory.

## The two tracked flows

| | A2A identity key | Gateway model key |
|---|---|---|
| What rotates | The agent's mesh identity key, alias `vs-<agent>-a2a` | `GATEWAY_API_KEY` in `config/agent.env`, alias `model-<agent>` |
| Alias scheme | Versioned: `vs-<agent>-a2a-r<n>` | Versioned: `model-<agent>-r<n>` |
| Who must receive it | EVERY peer that lists the agent in `peer_tokens` (fleet-wide, from the registry of referencing bundles) | Only the target device (bundle merge) |
| How receivers accept | New token becomes canonical `peer_tokens[<agent>]`, old token moves to `peer_tokens_overlap[<agent>]` (fixed bearer comparison + same-name dual-mode, like Hermes) | Device applies the new bundle; the old key stays live at the gateway |
| Confirmation | Every peer bundle applied (device reports) → then the target's bundle is flipped to the new key → target confirms → revoke old | Target device reports the new bundle applied → revoke old |
| What the target presents meanwhile | The OLD key (unchanged until its flip) | The OLD key until the new bundle is applied |

State machine (both flows): `delivering → awaiting_target → awaiting_revoke →
completed` (model rotations skip `awaiting_target` — no peer stage).

A third credential class — the per-device bootstrap key (`REGISTRAR_KEY`) — is
tracked by none of this: no alias, no peer map, no registry row, and none of
the deliver-then-revoke machinery. It rotates manually, and immediately; see
the **Bootstrap credentials** section below.

## Procedure: rotate an A2A identity key

1. Check gateway health (`GET /key/list` on the gateway) — the mint happens at
   start; don't begin with a gateway that is down.
2. On the registrar console open the device's page. If the bundle's
   `config/a2a.json` carries an identity key, the **Rotate A2A key (tracked)**
   button appears. Click, confirm. This:
   - mints the new key under the versioned alias (the old one stays live),
   - writes the new key canonical + old-key overlap into EVERY referencing
     peer's bundle (their next sync delivers it; their slot was re-armed),
   - does NOT touch the target's bundle,
   - creates registry row `#n` in `delivering`.
3. Watch **Rotations** (console nav). Each peer shows its bundle version and,
   once it reports, `applied vX ✓`. When every peer is confirmed:
   - the target's bundle flips to the NEW key (its version bump is recorded),
   - `awaiting_revoke`.
4. When the target reports applied: the OLD key is deleted at the gateway, the
   overlap entries are removed from the peer bundles, the row completes and
   both plaintext tokens are wiped from the registry.
5. If a peer is stuck: check it reports bundles at all (`/v1/a2a-key` body
   `bundle_version`), and that its slot is not failing (device page). The
   sweep advances automatically on the next report from any party — every
   device report path runs it — or via **Reconcile** on the row.

## Procedure: rotate a gateway model key

1. Start from the device page's **Rotate model key (tracked)** (appears when
   `agent.env` carries a non-empty `GATEWAY_API_KEY`).
2. The new key is minted under the versioned alias and merged into the
   device's OWN bundle (`agent.env` single-line swap; other lines preserved),
   which is then delivered like any bundle change. `delivering`.
3. The device applies the new bundle and reports its applied version →
   `awaiting_revoke` → the old key is revoked **by alias** (the registrar
   looks the live key up via the gateway's list endpoint, so the operator
   never handles the plaintext).
4. Completed rows keep only aliases and metadata — never key material.
5. **If the device cannot report** (its A2A guard is dead, it lost its device
   key, the fleet is being decommissioned): verify OUT OF BAND that the
   device is actually running with the new key (e.g. the gateway's audit or
   the device's local `agent.env`), then use the row's **force revoke**
   checkbox + Reconcile. Force skips the confirmation gates, flips/revokes,
   and writes the override to the audit trail (`delivery_log`). Never force
   while the device might still be on the OLD key.

## Bootstrap credentials (REGISTRAR_KEY) — the untracked class

The third credential class is the per-device bootstrap key: `REGISTRAR_KEY`,
set in the device's platform variables at creation and shown ONCE in the
console. It authenticates that device's registrant against the registrar —
the identity bootstrap that fetches the first bundle, every bundle report on
`/v1/a2a-key`, and the `GET /v1/status` self-check. The tracked rotation
registry does NOT cover it: rows exist only for `a2a_identity` and
`model_key`, so a bootstrap key has no versioned alias, no peer map, and no
rotation row — it never appears on the Rotations page.

Rotation is therefore manual, and unlike the flows above it is an immediate
cut, not deliver-then-revoke. That is safe for a structural reason: the key
has exactly one consumer — the device's own registrar traffic — and a device
whose identity is already delivered keeps running (its boot short-circuits
past the bootstrap). Only fresh enrollment and device reports need the key.
Manual order:

1. Do not regenerate while a rotation row involving this device (as peer or
   as target) is still open: device reports authenticate with this key, and
   cutting it stalls those rows until reports resume.
2. On the device page click **Regenerate device key**. The registrar swaps
   the key hash in the same click — the old key is invalid immediately — and
   the new plaintext is rendered once, never stored; an audit row records the
   regeneration (visible on the Audit page).
3. Set the new value as the device's `REGISTRAR_KEY` environment variable and
   recreate the agent container so the registrant boots with it. In between,
   the device cannot report and cannot bootstrap (both 401) while its agent
   keeps running on the identity it already holds.
4. Verify: the device page's last sync advances and the next bundle report
   lands (the device reports its `bundle_version`); `GET /v1/status` answers
   200 again.
5. Lost the shown-once value before it reached the device? Regenerate again —
   each regen invalidates the previous key, no peer or rotation row is
   affected, and the loop is always recoverable.

## Reading rotation status (fleet-ops-1py.25)

Where the status lives: the **Rotations** console page (`/admin/rotations`) is the
only status surface — all rows come straight from the Postgres rotation registry
(`credential_rotations`), rebuilt fresh on every page load (most recent 50 rows),
and the sweep is the same code the device-report paths run, so status and truth
always agree.

| Column | Meaning |
|---|---|
| Id | Registry row id; quote it in reports and use it to match Reconcile actions. |
| Kind | `a2a_identity` (fleet-wide peer rollout) or `model_key` (target-device only). |
| Agent | Rotation subject. |
| Alias | `oldAlias → newAlias` (e.g. `vs-romeo-a2a → vs-romeo-a2a-r1`). |
| State | The stage below; an in-cell gateway error means the row stays open and the next sweep retries. |
| Peers | Per peer: delivered bundle version, and the applied version the peer last reported (`applied vX ✓` = confirmed, `needs vX` = waiting, `no report yet`). Target-only rotations show none. |
| Timeline | UTC: `createdAt`, `flipAt` (A2A only), `target ✓`, `revoked` — a stale cell is a rotation waiting on that stage. |

### Stage reference (state machine: delivering → awaiting_target → awaiting_revoke → completed)

- **delivering** — the peer/token bundles are delivered; waiting on peer
  applied-reports. Stuck: device page shows slot state and last sync; the row
  has no `flipAt` yet. Model-key rows here wait for the device applied-report.
- **awaiting_target** — every peer confirmed at `flipAt`; the target's bundle is
  flipped to the new key. Stuck: no `target ✓` timestamp; check the target
  reports and its slot. **Model-key rows never have this stage.**
- **awaiting_revoke** — target confirmed; the old key is being revoked by alias
  at the next sweep (or Reconcile). Stuck: `gatewayError` in-cell (mint service
  down, key missing) — fix the gateway, then Reconcile; the sweep retries.
- **completed** — closed; the old key revoked (by the sweep or an owner force),
  overlap cleaned from peers, tokens wiped (aliases only remain). No actions
  remain on the row.

### Operator loop when a row is stuck

1. Identify the waiting stage (no peer confirmed / no flip / no target ✓ / no
   revoke) and check the party that must send the next report: device page
   (slot state, last sync, applied bundle version) and, for the target, the
   registrant logs (`bundle_version` reports on `/v1/a2a-key`).
2. If a device cannot report at all (guard dead, device key lost,
   decommissioning): verify out of band that the device is on the new key, then
   tick **force revoke** and Reconcile — the gates are skipped, the audit trail
   (`delivery_log`) records the override, and the row completes. Never force
   while a device could still be on the OLD key.
3. Otherwise let the sweep advance it, or click Reconcile to run it now. The
   sweep is idempotent and restart-safe: stage-1 delivery happens once at the
   start; sweeps only flip/confirm/revoke/clean, and the same advance code runs
   on every device report. If rows are open across restarts they survive in
   Postgres — nothing to re-run.

## Verify the rotation before you call the window clean

A `completed` row proves delivery and revocation happened. Proving the traffic
itself stayed healthy while credentials changed is owner-run and live — the
registry never performs these checks, and the constraint above stands: owner
authorization for any live procedure. Run these after the row closes
(a2a identity: overlap is live until the row completes; the mid-window probe
in step 2 deliberately runs while the row is still open):

1. **New-key model call** (model-key rotations). From the rotated device's
   agent runtime, make one minimal real model call through the gateway (a
   one-line chat completion to the agent's usual model group) and expect
   HTTP 200. Then read the gateway's key list (`GET /key/list`, shape in
   docs/gateway-ops.md): spend accrues on the new alias (`model-<agent>-r<n>`),
   the old alias stays 200-live exactly until the row's `revoked` timestamp
   and 401s after it (deleted key).
2. **A2A round-trips in both directions** (a2a identity rotations). For every
   peer pair the rotation touched, send one small A2A message agent→peer AND
   peer→agent — once mid-window (receivers accept the sender's token from
   `peer_tokens` canonical-new OR `peer_tokens_overlap` old, so both
   directions succeed even while a peer is still applying) and once more
   after the row completes and cleanup removes the overlap. Both directions
   must succeed every time. A one-directional failure means that peer has the
   token under only one name — re-check its delivered/applied versions on the
   row and Reconcile; never force-revoke because of a send failure.
3. **Gateway A2A failure view** (the #70 acceptance view). Receiver-side logs
   cannot show rejected A2A auth — receivers drop it silently — so the
   gateway is the one place a broken send is visible: in the incident behind
   issue #70, a receiver's 401 surfaced at the gateway as a 500 on
   `asend_message`. Read the gateway's A2A send-failure evidence for the
   whole rotation window and require ZERO failure rows for every caller→
   target pair the rotation touched — rows keyed on SpendLogs
   (`call_type = asend_message`, `status = failure`) or the equivalent
   Prometheus counters, which is also what a caller→target failure alert
   keys on. Calibrate the zero once: a deliberately wrong-key A2A send must
   surface in this view within one check interval (#70's acceptance bar);
   without that negative test passing, a rowless window proves nothing.
   Any failure row for a touched pair means the window is NOT clean: find
   the pair, read its delivered/applied versions on the row, re-deliver or
   Reconcile, and re-verify.

## Failure, retry, and safety properties

- A gateway failure during revoke (e.g. mint service down) is recorded in the
  row's `gateway_error` and shown on the row; the row stays open and the next
  sweep retries. Sweeps run on every device report and every Reconcile click —
  they are restart-safe and idempotent (stage-1 delivery happens exactly once,
  at the start; sweeps only flip/confirm/revoke/clean).
- Rotation starts are rate-limited (one mint per agent per hour, shared with
  the mesh-mint limiter). This is deliberate: rotation is a rare fleet act.
- A second rotation for the same agent+kind is refused while one is open.
- Fresh enrollments that arrive mid-rotation receive the target's new token
  canonical AND the old one as overlap, so no enroll can produce a dead peer
  token window.
- The registry is Postgres — registrar restarts do not lose open windows.

## What this feature deliberately does NOT do

It performs no rotation on its own, has no scheduler, and never touches
credentials outside the start/sweep actions above. All operations take place
through the owner console (session + CSRF + audit) or the device report
paths (device-key authenticated). Running the dev/test suites mints nothing
against any live gateway: the tests stub the gateway in-process.