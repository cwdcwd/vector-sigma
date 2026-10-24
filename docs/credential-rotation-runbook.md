# Credential rotation runbook (fleet-ops-1py.24)

How to rotate a fleet credential — an agent's A2A identity key or gateway model
key — without a failed send and without a window where nothing accepts.

**The core rule is deliver-then-revoke.** No old key is deleted before the
replacements (new canonical + old-as-overlap) are confirmed applied by every
device that needs them. The registrar's rotation registry
(`credential_rotations` in Postgres) tracks every step across restarts; rows
are the source of truth, not operator memory.

## The two flows

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