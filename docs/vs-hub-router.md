# VS hub router — design constants (fleet-ops-1py.47.1)

`images/common/bin/vs-hub-router.py` is the VS-local **board pipeline
router**: it advances the fleet's hub-assigned work on the `vs_ops` queue
exactly the way the fleet's hub sweep routes beads. This document is the
authoritative constant source; `docs/queue-conventions.md` gives the
convention-level contract.

## Command surface

| verb    | behavior                                                              |
| ------- | --------------------------------------------------------------------- |
| `gate`  | print the routing-gate verdict and exit (used by healthchecks/logs).   |
| `once`  | run one sweep under the router lock and exit.                         |
| `serve` | loop sweeps on `VS_HUB_INTERVAL` (default 300s). s6 longrun verb.     |

Exit codes for `gate`/`once`: `0` ok · `1` board not ready (or the sweep
failed) · `2` the workspace contract was refused (or no env/config) · `3`
unconfigured (no `VS_HUB_AGENTS` roster — the router is dark) · `4` the
router lock is held by another instance.

## Environment knobs (owner-controlled)

| knob                     | default   | meaning                                                       |
| ------------------------ | --------- | ------------------------------------------------------------- |
| `VS_HUB_AGENTS`          | *(none)*  | JSON roster stage → agent, e.g. `{"dev": "builder-a"}`. Absent ⇒ dark, nothing routed. |
| `VS_HUB_WIP`             | `2`       | per-agent outstanding (open) hub work cap.                    |
| `VS_HUB_INTERVAL`        | `300`     | `serve` tick seconds (smallest sane value is bounded low in code). |
| `VS_HUB_REPING_HOURS`    | `12`      | re-ping a dispatched bead idle longer than this.              |
| `VS_HUB_SILENT_HOURS`    | `48`      | a dispatched bead silent this long parks with the owner.      |
| `VS_HUB_GRACE_HOURS`     | `8`       | fresh dispatches are exempt from re-ping/silence this long.   |
| `VS_HUB_NOTIFY`          | `auto`    | `0` = board-only sweeps; `legacy` = `{GATEWAY_URL}/a2a/<agent>` pings; `auto` = signed token chooses the guard route. |
| `VS_HUB_NOTIFY_BASE`     | guard URL | base for the signed-token peer route.                         |
| `VS_HUB_ACTOR`           | `primus`  | bd actor used for router comments/metadata.                   |
| `VS_HUB_OWNER`           | `owner`   | assignee used when a bead parks with the owner.               |
| `VS_HUB_OWNER_AUTHORS`   | `lazybaer`| comma list of accounts allowed to post `GUIDANCE:`.           |
| `GATEWAY_URL`            | *(none)*  | legacy ping route base (`$GATEWAY_URL/a2a/<agent>`).          |
| `A2A_GUARD_OUTBOUND_TOKEN` | *(none)*| bearer token for the signed guard peer route.                 |
| `VS_QUEUE_DIR`           | `$HERMES_HOME/vs-queue` | the bd workspace to serve.      |

## Workspace contract (refusals)

Refused before any bd call (exit 2): the join metadata must name the baked
`vs_ops` queue (`database: vs_ops`, dolt server backend) with the canonical
project id; the origin fleet's own hub workspace (`fleet_ops`) is refused.

## Pipeline stages and verbs

- `dev` — label `role:builder` · may post `HANDOFF: dev-done` / `HANDOFF: blocked`
- `test` — label `role:tester` · `test-pass` / `test-fail` / `blocked`
- `review` — label `role:reviewer` · `review-accepted` / `changes-requested` / `blocked`
- `merge` — the terminal stage set by `review-accepted` (no stage agent; the
  bead is left open + unassigned for the merging owner account).

| from    | verb                | to      |
| ------- | ------------------- | ------- |
| dev     | `dev-done`          | test    |
| test    | `test-pass`         | review  |
| test    | `test-fail`         | dev     |
| review  | `changes-requested` | dev     |
| review  | `review-accepted`   | merge   |
| any     | `blocked`           | owner park (resume via `GUIDANCE:` from the owner's accounts) |

## Board metadata (router-owned keys)

| key                 | meaning                                                |
| ------------------- | ------------------------------------------------------ |
| `hub_stage`         | `dev` / `test` / `review` / `merge`                    |
| `hub_dispatched_at` | ISO-Z stamp of the last dispatch to a stage agent      |
| `hub_pending`       | `1` while a dispatch's wake-up is outstanding; cleared (and the key removed) once the agent is pinged (or on revert) |
| `hub_blocked_from`  | stage the bead was parked from                         |
| `hub_blocked_at`    | when the owner park happened                           |

The owner may also set `hub_blocked` (see below) — router-owned keys are
never duplicated onto other agents' work.

## Wake-up notify routes

- signed token present (`A2A_GUARD_OUTBOUND_TOKEN`): POST
  `{"jsonrpc":"2.0","id":"vs-hub-router-<ns>","method":"message/send",
  "params":{"message":{…,"text": <text>}}}` as `Bearer` to the guard peer
  route (default `http://127.0.0.1:9902/peer/<agent>`).
- `VS_HUB_NOTIFY=legacy`: POST to `{GATEWAY_URL}/a2a/<agent>` (payload
  shape of the runtime's own outbound a2a call).
- no route: dispatch is disabled with a loud "dispatch disabled" sweep log
  (fail-closed — never silently stage and strand work).

## Lock

`<workspace>/.vs-hub/router.lock` (flock) guarantees a single active
sweep; `once` refuses (`exit 4`) while another instance holds it.