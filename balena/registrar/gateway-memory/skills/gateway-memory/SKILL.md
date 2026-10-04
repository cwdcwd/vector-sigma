---
name: gateway-memory
description: Read and write memory shared across the agent fleet, or private to just this agent, via the gateway's memory store.
---

# Gateway Memory

Use `memory_get`, `memory_set`, and `memory_list` to persist
facts across agents and across your own sessions. This is separate from your
normal conversational memory — it's a small key-value store on the gateway,
shared by every agent on the team.

## Scopes

- **shared** (default): readable by every agent on the team. Only the
  agent that wrote an entry can update or delete it later — if another
  agent's shared entry needs correcting, write a new key noting the
  correction rather than overwriting theirs (that fails with a permission
  error).
- **private**: visible only to you, not to other agents. Use this for
  scratch notes or anything not meant to be shared. If
  `GATEWAY_MEMORY_PRIVATE_KEY` isn't configured on this host,
  private-scope calls return a clear error — fall back to shared, or skip
  persisting, rather than treating it as a bug.

## Key naming convention

Prefix shared keys by topic so `memory_list` stays browsable:
- `fleet/conventions/<topic>` — standing conventions the fleet should follow
- `fleet/status/<topic>` — current state of some ongoing thing
- `fleet/notes/<topic>` — freeform shared notes

Private keys have no fleet-wide convention — name them however is useful.

## When to use this

- Before starting work another agent might also touch, call
  `memory_list` with a relevant `key_prefix` to see what's already
  known — avoid re-deriving or duplicating what's already stored.
- When you learn something other agents should know (a convention, a
  decision, a piece of status), write it with `memory_set` at
  `scope: shared`.
- When you want to remember something across your own sessions that isn't
  relevant to the rest of the fleet, use `scope: private`.
- This is a small key-value store, not a message queue or event log — don't
  use it for anything high-frequency or time-sensitive.