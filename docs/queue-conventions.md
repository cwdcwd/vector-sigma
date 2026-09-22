# VS Queue Conventions (fleet-ops-f57.15) — the Vector Sigma mirror of the
# Cabal fleet's FLEET.md queue discipline.

The VS queue lives in the master device's `dolt` container (database
`vs_ops`). It is the VS fleet's ONLY work queue. primus (the VS coordinator
Hermes, fleet-ops-f57.14) is the **queue curator** — its SOUL says so.

## Structure

- **One EPIC per project/workstream.** All work beads are children of their
  project's epic, labeled `area:<project>`. (Owner ruling 2026-09-18, Cabal
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
- Joining is config-only (see `scripts/vs-queue-bootstrap.md`). The one-time
  `bd init --server` belongs to the first connector (coordinator/owner);
  the minted project_id is a fleet contract. **Never re-init.**
- Peer clients silence bd auto-backup noise (`bd config set backup.enabled
  false`) — server-mode workspaces cannot use it anyway; the DB-host client
  keeps it (Cabal convention `bd-autobackup-server-mode`).

## Cross-fleet rule (owner ruling, hard boundary)

**The VS queue and the Cabal queue are SEPARATE.** primus (VS coordinator)
and ultronbot (Cabal coordinator) contact each other A2A agent-to-agent —
NEVER through shared-queue writes. No VS agent writes to the Cabal's
`fleet_ops` database; no Cabal agent writes to `vs_ops`. Coordination
crossings happen over A2A, exactly as this bead was dispatched.

## Read-only dashboard

The Scotty UI serves the queue read-only (two-layer posture:
`SCOTTY_READ_ONLY=1` + the `bd-readonly` BD_BIN wrapper). Writes go through
bd clients, never through the dashboard — the Cabal runbook posture
(fleet-ops-8ea).