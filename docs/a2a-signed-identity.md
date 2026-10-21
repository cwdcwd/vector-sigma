# Signed A2A identity: host-bound Ed25519 keys (design)

Status: **proposed**. This design was proven first in a production Hermes fleet: the same guard,
signature format and rollout, live in strict mode. This document adapts it to the VS custody model
(registrar + bundles + registrant) so that it is **on by default for every enrolled agent**.

## Problem

Today a VS agent's mesh identity is a **bearer** key (`vs-<agent>-a2a`), and mesh-enroll merges
every agent's raw key into **every peer's bundle** (`a2a.json` `peer_tokens`), because Hermes
resolves a caller by comparing the presented token against `A2A_PEER_TOKENS`. Consequences:

- **One compromised device holds every agent's mesh identity**, so it can impersonate any peer,
  including primus.
- **The gateway forwards each caller's key to the receiver.** Agent rows carry
  `extra_headers: ["Authorization"]`, so receivers see their callers' keys on every call.
- **Revoking a key at the gateway does not stop direct calls** to an agent's `:9900`. Receivers
  check their local list.

Hermes has no auth hook (its A2A auth is a fixed bearer comparison, and Ed25519 identity is listed
upstream as out of scope), so the fix must leave Hermes and LiteLLM stock.

## Design

Each agent's identity is an **Ed25519 key pair generated on the device**. The private key never
leaves the agent's data volume. The registrar distributes **public keys only**. A sidecar,
**a2a-guard**, does the cryptography:

```
agent A (device)                    master gateway (LiteLLM)               agent B (device)
Hermes a2a_call                                                             a2a-guard :9900 (s6 longrun)
  -> 127.0.0.1:9902/peer/B  --sign-->  /a2a/B  --x-a2a-sig only-->            verify vs peer_keys
a2a-guard outbound                     checks A's mesh key                    -> Bearer <LOCAL token>
  (+ A's mesh key)                     (gateway-only)                        Hermes 127.0.0.1:9901
```

- **Inbound guard** (`:9900`, the address the serve edge already proxies to):
  - Verifies the signature and hands Hermes (moved to `127.0.0.1:9901`) a **local per-peer token**.
    These are random tokens generated on the device, never in a bundle.
  - Hermes's identity → trust → rate limit → audit chain is unchanged.
- **Outbound guard** (`127.0.0.1:9902`): `a2a_agents.<peer>.url` points at `/peer/<peer>`.
  - The guard signs, adds this agent's mesh key (still required: the gateway routes, logs and
    revokes by it) and forwards to the mesh edge.
  - It rewrites peer cards back to itself, because Hermes posts to the card's URL.
- **What is signed:** the message content (messageId, contextId, taskId, normalized role, tenant,
  text parts), plus sender, receiver, timestamp, nonce and method class.
  - The signature covers content, not raw bytes, because LiteLLM re-serializes JSON-RPC (new
    request id, added `configuration`, dropped part `mediaType`).
  - Every other non-empty field is **refused**, not ignored.
- **Transport:** `x-a2a-<receiver>-x-a2a-sig` is forwarded to the backend as `x-a2a-sig` by
  LiteLLM's convention forwarding, which matches the agent name or id. No gateway config is needed.
- **Strict mode:** an unsigned request is refused even with a valid key, and agent rows forward
  **no** `Authorization`.

The guard is the same code as the reference implementation (`a2a_guard.py`: stdlib +
`cryptography`, which the images' Hermes venv already has), baked as
`/usr/local/bin/vs-a2a-guard`.

## Key lifecycle in VS

| Step | Where | What |
|---|---|---|
| Generate | agent container, `04-vs-a2a-wiring` (every boot, idempotent) | `$HERMES_HOME/a2a-guard/ed25519.key` (0600, runtime user), public key to `a2a-guard/pubkey.json`. Never overwritten |
| Report | registrant (shares the data volume) | Reads `pubkey.json` and sends it on its existing authenticated poll. New endpoint `POST /v1/a2a-key` (device-auth, same credential as bootstrap) |
| Register | registrar | New table `a2a_public_keys(device_id, ed25519, fingerprint, status, updated_at)`. **First key is trusted on first use** (status `active`). A changed key is held `pending` until the owner approves it in the console, so a stolen device credential cannot silently swap the key. Every change is audited |
| Distribute | registrar bundle render (mesh-enroll merge + a re-render when a key is registered or approved) | `a2a.json` gains `peer_keys: {name: ed25519}` (**public**) for every trusted peer with an active key. `peer_tokens` is **not** delivered for those peers |
| Apply | `04-vs-a2a-wiring` on the next container recreate (the existing rotation contract) | Writes `guard.json`, the peer registry and local tokens; sets `A2A_HOST=127.0.0.1` and `A2A_PORT=9901`; points `a2a_agents` at the outbound guard |
| Revoke / rotate | console | Revoke deletes the public key and re-renders peers. Rotate is: device generates a new key, the owner approves it |

**Mixed fleets (upgrade path):** a peer without a registered key keeps the legacy path. The guard
runs in **dual mode** (`legacy_bearer: true`) while any trusted peer lacks a key, and switches to
strict automatically when every peer has one. On a fresh install every agent registers a key at
first boot, so the fleet starts strict.

## Changes by component

1. **Images (hermes + agent):**
   - Bake `vs-a2a-guard`.
   - Add an s6-rc `longrun` service `a2a-guard`. It idles (finish 125, like `dashboard`) when no
     `guard.json` exists, and runs as the runtime user.
   - Add image-content tests.
2. **Wiring hook:**
   - Keygen at every boot.
   - When `peer_keys` is present: signed mode, i.e. write `guard.json` and the registry, generate
     local tokens, move Hermes's port, rewire `a2a_agents`.
   - Otherwise it does exactly what it does today.
3. **Registrar:**
   - Add `a2a_public_keys` (migration).
   - Add `POST /v1/a2a-key` (device-auth; TOFU then owner approval).
   - Bundle render emits `peer_keys`.
   - mesh-enroll merges public keys instead of raw keys when both sides have one.
   - `registerAgentRow` sets `extra_headers: []` for signed agents.
   - Console: per-device key fingerprint and status, plus approve and revoke.
4. **Registrant:**
   - Report `pubkey.json` when present and changed.
   - Retry on the existing poll cadence.
5. **E2E:** the compose E2E stands up two agents and proves:
   - A signed call is delivered with a local token only.
   - An unsigned call carrying a valid mesh key is refused.
   - A forged signature is refused.

Each lands as its own PR, in the order above. Releases ship it dark (no `peer_keys` means today's
behavior) until the registrar change is released, then on.

## Non-goals and limits

- **The edge → agent hop** is TLS on devices (serve edge) and compose-internal on primus,
  unchanged.
- **Replies are not signed.** A caller trusts the path it asked over, as today.
- **Host compromise:** anything that can read the agent's data volume owns that agent's identity,
  as today. It just no longer owns everyone else's.
