# gateway-memory

A Hermes agent plugin: three tools (`memory_get`, `memory_set`,
`memory_list`) over the gateway's `/v1/memory` API, plus a skill that
teaches agents to use them (list-first, write-on-learning).

Stdlib-only (urllib); no third-party dependencies. One register(ctx) call
exposes the three tools and the skill to the agent.

## Environment

| Variable | Scope it unlocks | Notes |
|---|---|---|
| `GATEWAY_MEMORY_SHARED_KEY` | shared | Team-scoped gateway virtual key, route-restricted to the memory API. |
| `GATEWAY_MEMORY_PRIVATE_KEY` | private | Gateway virtual key with NO team scope — entries visible only to this identity. |
| `FLEET_MEMORY_BASE_URL` | both | REQUIRED — no default (an unset env fails loud rather than guessing a gateway). Set to this fleet's gateway base, e.g. `https://<gateway-host>/v1`. |

Both keys are dedicated memory-only keys, deliberately separate from the
agent's main gateway key (which needs unrestricted LLM access — the
gateway's `allowed_routes` is a hard allowlist once non-empty, so one key
cannot do both).

## Provenance

Derived from the origin fleet's memory plugin (v1.0.0, 5 files,
~290 lines) via a product-agnostic rename; the logic is intentionally
unrestructured. See PROVENANCE.md for the exact lineage and drift check.