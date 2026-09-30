# VS Queue Seed — primus's one-time opening-board run

**fleet-ops-1py.2.** This directory holds the VS queue's opening board as
repo artifacts: the seed graph (`initial-beads.json`) plus this procedure.
The seed is run ONCE by **primus** (the VS coordinator, the queue curator)
with his baked `bd` — no other agent runs it, and the owner hands primus
the go via Slack DM after this PR merges. Cross-fleet boundary holds: no
Cabal agent writes to `vs_ops`.

## What lands on the queue

One **umbrella epic per active VS workstream** (Cabal mirror,
`fleet/conventions/beads-epic-structure`): `vs-queue`,
`vs-registrar`, `vs-devices`, `vs-ops` — all labeled `area:<x>`,
assigned `primus`, and **staying open forever** (umbrellas collect future
work; children carry the real acceptance criteria).

Under them, the four known deferred VS lanes:

| Lane | Parent | What it holds |
|---|---|---|
| dolt true-rotation | `vs-queue` | Owner decision on the vs `DOLT_PASSWORD` rotation (accepted-risk ruling class; `owner-call`) |
| clock-gate NTP probe diagnostics | `vs-devices` | Owner call: accept the 10-min cold-boot wait or file the timedatectl diagnostics (timesyncd-vs-chronyd) |
| real-agent-runtime swap | `vs-devices` | The `Dockerfile.agent-hermes` pattern shipped unbuilt in b1r — owner green-light required before execution |
| device onboarding runbook | `vs-ops` | The end-to-end procedure for adding the next VS device |

## The one-time run (primus)

Run from **primus's queue workspace**, `/data/primus/vs-queue` (i.e.
`$HERMES_HOME/vs-queue`, seeded by the image's `03-vs-queue-join` boot
hook). The workspace join is already config-only — this procedure NEVER
runs `bd init`.

1. **Verify the join first** — must connect, and show the canonical
   contract (a fresh queue may legitimately show zero issues):

   ```sh
   cd /data/primus/vs-queue
   bd status
   ```

   A `PROJECT IDENTITY MISMATCH` error means the join config's
   project_id is wrong — re-check the contract id
   (`bcde5891-5482-4eb0-a223-8533504832d6`); never re-init.

2. **Verify the boot hook already stamped your identity** (the b1r hook
   seeds both at first boot — verify, set only if missing):

   ```sh
   bd config get actor        # must answer: primus
   bd config get backup.enabled   # must answer: false
   ```

   If either is missing, set it — attribution is the AGENT name, never
   a machine/bot login (`bd config set actor primus`; `bd config set
   backup.enabled false` — server-mode peer clients must not auto-backup).

3. **Dry-run the seed first** (validates structure only — no writes):

   ```sh
   bd create --graph /opt/vs/queue-seed/initial-beads.json --dry-run
   ```

   Expected: `would create 8 issue(s)` with 4 `parent_key=` links.

   The baked copy at `/opt/vs/queue-seed/` mirrors this repo dir (same
   Dockerfile `COPY queue-seed` pattern as `queue-join`); if primus is
   running an image predating this PR, use the repo checkout path
   instead — the JSON is identical.

4. **Run it live** — exactly once:

   ```sh
   bd create --graph /opt/vs/queue-seed/initial-beads.json
   ```

5. **Verify per node** — trust `bd show`, not ASCII art (`bd dep remove`
   succeeds silently on nonexistent edges):

   ```sh
   bd list --json | grep -c '"parent":'   # 4 children, each parented
   bd show <epic-id>                       # DEPENDS ON/BLOCKS sections
   ```

   Then post the evidence to the VS queue's own thread: `bd status` /
   `bd list --json` output showing epic + children with parent-child
   edges, authored `primus`. Kangbot-style verification: at least one
   bead authored primus, the epics open, the four lanes in place.

## Idempotency

The seed is a one-time act — `bd create --graph` always creates fresh
beads; re-running duplicates the board. If the run half-completes (some
beads created, then an error), do NOT re-run the seed: close the
duplicates individually (or ask the owner) and create only the missing
nodes by hand from this README's table. The dry-run in step 3 is the
pre-flight for exactly this reason.

## Guard rails (why this README exists)

JSON has no comments — every rule lives here. The seed JSON uses the
`bd create --graph` schema (`commit_message` + `nodes` with
`key`/`parent_key`/`title`/`type`/`priority`/`labels`/`assignee`/
`description`): the ONLY fleet-verified way to land a true hierarchy —
`bd create -f <md>` silently drops parent links (children land flat) and
rejects `--dry-run` (live-probed on bd 1.2.2, 2026-09-30). Top-level
shape is `{"nodes": [...], "edges": [...]}` — an `issues` key is silently
dropped; `parent_key` is preferred over hand-built edges for
parent-child (the edge array stays empty in this seed).