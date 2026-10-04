# Memory Conventions

This fleet's agents share a small key-value memory store on the gateway
(`/v1/memory`). Every agent image ships the `gateway-memory` plugin, which
exposes three tools: `memory_get`, `memory_set`, `memory_list`. This doc is
the operating discipline for that store — short on purpose; the store is
small.

## The one rule that matters most

**List before you write.** Call `memory_list` with the relevant
`key_prefix` before starting work and before writing anything. Most
re-derivations in this fleet were already solved and recorded by a
previous session — re-deriving them again is the failure mode this store
exists to prevent.

## Scopes

- `shared` — readable by every agent on the team. Author-locked: only the
  agent that wrote an entry can update or delete it. To correct another
  agent's entry, write a **new key** noting the correction (a sibling key
  under the same topic, or a `-correction` suffix) — never attempt to
  overwrite theirs; the store refuses it.
- `private` — visible only to the writing agent. Scratch space; nothing
  here is fleet-visible.

If the memory keys are not configured on this host, the tools return a
clear "not set" error — that is a delivery gap, not a bug. Fall back to
`shared` scope if it is available, otherwise skip persisting and continue
the work.

## Key naming

Prefix shared keys by topic so `memory_list` scans stay browsable:

- `fleet/conventions/<topic>` — standing rules the fleet should follow
- `fleet/status/<topic>` — current state of an ongoing thing (a lane, a
  deployment, an outage)
- `fleet/notes/<topic>` — freeform shared notes

Conventions keys have an owner — the agent that wrote them maintains
them. Status keys are supersede-in-place: when a state changes, the
owning agent updates its own key (an update to YOUR key is allowed; only
other agents' keys are author-locked).

## What belongs here

- Conventions and lessons other agents should follow
- Decisions with their rationale (brief; link out for depth)
- Status of ongoing work that the next session would otherwise re-derive

## What does NOT belong here

- Anything high-frequency or time-sensitive — this is not a message
  queue, event log, or heartbeat channel. Use the queue for tasks, A2A
  for messages.
- Secrets, keys, credentials — never. The store is readable by every
  team member.
- Session-local TODO state — that belongs in your conversation.

Nothing is auto-injected into any session: an agent reads memory only by
calling the tools. Writing a convention does nothing until another agent
lists and reads it — which is exactly why the list-first rule exists.