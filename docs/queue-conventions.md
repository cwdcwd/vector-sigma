# VS Queue Conventions (fleet-ops-f57.15) — the Vector Sigma mirror of the
# origin fleet's FLEET.md queue discipline.

The VS queue lives in the master device's `dolt` container (database
`vs_ops`). It is the VS fleet's ONLY work queue. primus (the VS coordinator
Hermes, fleet-ops-f57.14) is the **queue curator** — its SOUL says so.

Readers: this doc serves BOTH sides of the queue. primus (master device)
is the CURATOR — epics, structure, routing, adjudication. Every other VS
agent, including every device agent, is a **WORKER**: claim a ready bead
that fits your role labels, build it, post evidence as you go, close with
the evidence cited. Your own environment map is `vs-environment.md`
(master) or `device-environment.md` (device) — each image bakes its
own, and a device agent reading the master's map is a regression
(CI-fatal in `registrar/test/image-build-config.test.ts`).

## Structure

- **One EPIC per project/workstream.** All work beads are children of their
  project's epic, labeled `area:<project>`. (Owner ruling 2026-09-18, origin-fleet
  precedent — `fleet/conventions/beads-epic-structure`.)
- Epics are created by the coordinator (primus); builders file discovered
  work as children of the relevant epic.

## Claim discipline

- Claim atomically: `bd update <id> --claim` (or `bd ready --claim --json`).
  The DB claim decides the lane — not self-reports, not ETAs.
- Never write on a bead another agent holds `in_progress`. If you find a live
  builder racing you, stand down on the build and post the race resolution on
  the thread (the live builder keeps the lane).
- Claims stamp the AGENT name (`bd config set actor <name>`) — never a machine
  or bot-login identity.

## Evidence discipline

- Evidence lives in bead comments: commands run, outputs, commit hashes,
  endpoint URLs. Build-bead closure evidence must include the SHARED REMOTE
  (the origin branch/PR), not just local state.
- Post status milestones as thread comments — they are the liveness signal a
  coordinator sweep reads. Liveness = artifact advance (branch pushes, PRs)
  + thread activity; never ETAs.
- Comments are prose evidence, not a byte-exact transport — payloads ship
  with pointer + byte count + sha256 alongside.

## bd client rules

- Pinned at **bd 1.2.2** (fleet convention `bd-version-pin`). Never
  `npm i -g beads@latest` — schema migration lockout risk.
- Joining is config-only (see `docs/vs-queue-bootstrap.md`). The one-time
  `bd init --server` belongs to the first connector (coordinator/owner);
  the minted project_id is a fleet contract. **Never re-init.**
- Peer clients silence bd auto-backup noise (`bd config set backup.enabled
  false`) — server-mode workspaces cannot use it anyway; the DB-host client
  keeps it (origin-fleet convention `bd-autobackup-server-mode`).

## Cross-fleet rule (owner ruling, hard boundary)

**The VS queue and the origin queue are SEPARATE.** primus (VS coordinator)
and the origin-fleet coordinator contact each other A2A agent-to-agent —
NEVER through shared-queue writes. No VS agent writes to the origin fleet's
`fleet_ops` database; no origin-fleet agent writes to `vs_ops`. Coordination
coordination crossings happen over A2A, exactly as this bead was dispatched.

## Hub router (the board pipeline, fleet-ops-1py.47.1)

The device's own hub. The s6 `vs-hub-router` longrun runs over the baked
vs_ops queue join (`$HERMES_HOME/vs-queue`) and advances the board pipeline
the fleet's hub sweep assigns work by. **Routing is an owner choice**: the
service is dark until the composition sets `VS_HUB_AGENTS` (a JSON roster
mapping pipeline stages to the agent accounts who take the work, e.g.
`{"dev": "builder-a", "test": "tester-a", "review": "a-pr-review-a"}`);
no roster → no sweeps, exactly as before.

Every sweep is idempotent and the bd argv surface is a fixed allowlist
(`status`, `list`, `ready`, `comments`, `update`, `comment`) — never
`init` or raw queries, so the router can never re-initialize or fork the
shared queue. Eligibility and routing:

- A ready, unassigned bead enters `dev` (role:builder) — or `test`
  (role:tester) / `review` (role:reviewer) once it carries PR evidence (a
  `*/pull/<n>` link in the description or a comment). `owner-call` beads
  are never dispatched. Each stage agent is WIP-capped (`VS_HUB_WIP`,
  default 2).
- Stage agents post **ONE** `HANDOFF:` comment (first line:
  `dev-done` / `test-pass` / `test-fail` / `review-accepted` /
  `changes-requested` / `blocked`) that moves the bead onward or back, as
  validated per stage (`docs/vs-hub-router.md`); the router stamps the
  progress in board metadata (`hub_stage`, `hub_dispatched_at`,
  `hub_pending`), never in the bead tree.
- Dispatched beads get a wake-up ping through the a2a-guard's signed
  outbound route; a failed ping reverts the dispatch (back to a plain ready
  bead) instead of stranding stage work. Stale beads are re-pinged until a
  silence cap parks them with the owner; only the owner's accounts resume
  an owner-parked bead (`GUIDANCE:` comment).

WIP accounting counts the agents' currently dispatched (open) hub work;
dispatching is per-tick (default 300s, `VS_HUB_INTERVAL`), and the lock
file at `<workspace>/.vs-hub/router.lock` guarantees a single active sweep
even with `once` and `serve` both present. See `docs/vs-hub-router.md` for
the full knob table and the stage/verb matrix.

## Read-only dashboard

The Scotty UI serves the queue read-only (two-layer posture:
`SCOTTY_READ_ONLY=1` + the `bd-readonly` BD_BIN wrapper). Writes go through
bd clients, never through the dashboard — the origin-fleet runbook posture
(fleet-ops-8ea).