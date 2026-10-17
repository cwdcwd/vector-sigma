# A2A sender audit and silent-401 contract

**Audit date:** 2026-10-17  
**Scope:** static review of the Vector Sigma repository at this revision; no network, gateway, A2A, Docker, or fleet calls were made.

## Method and scope

Reviewed `registrar/src/`, `registrar/test/`, `registrar/scripts/` (not present), `deploy/`, `balena/`, `scripts/`, and `docs/`, including the checked-in device/master copies of hooks and operator documentation. Searched case-insensitively for `a2a`, `/a2a/`, `A2A_PEER`, `Peer-Auth`, `Authorization`, `Bearer`, `X-A2A`, `notify`, `lifecycle`, and `mesh-enroll`, then followed direct HTTP/configuration send evidence. Bearer values are deliberately not recorded here. Registrant calls to registrar endpoints, mesh-enroll calls, gateway management/model requests, and A2A receive-side token matching are not peer-message sends; they were distinguished from outbound A2A traffic rather than treated as A2A senders.

## Sender inventory

| Path | Purpose | Auth source (variable name) | Verdict |
|---|---|---|---|
| `deploy/vs-a2a-wiring.sh:290-300` | Writes Hermes `a2a_agents` peer URLs through the gateway edge; Hermes sends peer calls using this config. | `A2A_OWN_IDENTITY_KEY` (bundle `identity_key`); peer token entries name destinations only. | CLEAN — identity key only |
| `balena/devices/agent/vs-a2a-wiring.sh:290-300` | Device-image copy of the Hermes outbound peer configuration. | `A2A_OWN_IDENTITY_KEY` | CLEAN — identity key only |
| `balena/registrar/vs-a2a-wiring.sh:290-300` | Master/primus-image copy of the Hermes outbound peer configuration. | `A2A_OWN_IDENTITY_KEY` | CLEAN — identity key only |
| `deploy/e2e.sh:1371-1387` | AC14 unauthenticated origin probe; sends a health request and an intentionally unauthorized `message/send` to prove the receiver rejects missing auth. | None (deliberately unauthenticated). | CLEAN — negative receive-side probe only, not a peer delivery. |
| `deploy/e2e.sh:1434-1436` | AC14 retrieves the proxied agent card from the gateway A2A route; metadata lookup only, no message delivery. | `master` (loaded from `LITELLM_MASTER_KEY` in the E2E env file). | CLEAN — gateway-authenticated card/control-plane lookup, not peer-message sender auth. |
| `deploy/e2e.sh:1445-1452` | AC14 sends an A2A `message/send` round-trip through the gateway to the Hermes origin. | `a2a_identity` (read at runtime from the seeded agent's `config/a2a.json` `identity_key`). | CLEAN after fix — identity key only; previously this request used `LITELLM_MASTER_KEY` and was a finding. |

The `a2a_call` tool dispatch itself is performed by Hermes using the generated config; there is no separate in-repository sender implementation in registrar code. The docs' `a2a_call` references describe that runtime path, not additional HTTP senders. Gateway `/v1/agents` registration is a gateway control-plane request, not peer message delivery. The card lookup is separately inventoried above because it authenticates a gateway A2A route, but it does not send a peer message or use that gateway key as peer identity. Receive-side `A2A_PEER_TOKENS` / `A2A_TRUSTED_PEERS` exact matching is a separate inbound contract and is not an outbound-auth finding.

## Silent-401 contract

A2A receivers require an exact Bearer-token match against the configured peer identity and fail closed. Hermes intentionally **drops rejected A2A authentication with HTTP 401 without logging it**. A mismatched sender key can therefore look like ordinary silence: notifications or lifecycle messages never arrive, and receiver logs show no rejected-auth event. Absence of a log entry is not evidence that delivery succeeded.

### Operator diagnosis

1. Confirm the sender's generated `config.yaml` peer entry points at the intended edge and uses the sender's own `A2A_OWN_IDENTITY_KEY`; do not substitute `GATEWAY_API_KEY`, `LITELLM_MASTER_KEY`, or another model credential.
2. From an authorized sender-side diagnostic environment, make a harmless A2A request with the sender's identity key and inspect the HTTP status / JSON-RPC response. Keep the identity in its existing secret boundary; never paste it into tickets, shell history, or logs. A 401 points to the send credential or receiver's peer-token configuration, not to model authentication.
3. Verify receiver `A2A_PEER_TOKENS` contains the sender's identity and `A2A_TRUSTED_PEERS` includes its peer name, without printing token contents. Check the effective bundle and generated environment/config after the relevant container restart.
4. If necessary, temporarily enable narrowly scoped receiver-side rejected-auth diagnostics in a controlled maintenance window, logging only a peer identifier / rejection reason and never the token or Authorization header. Remove the temporary instrumentation after diagnosis; standard receiver logs are intentionally silent for these 401s.
5. Verify delivery with the receiver's side effect (notification/lifecycle event), not merely the sender's HTTP attempt. Live restarts and end-to-end delivery confirmation are owner-gated and remain pending below.

## Boundaries and pending verification

- **Cross-fleet context (out of this repository):** fleet-side sender scripts and hooks live in `the-cabal` and are covered by the-cabal PR 42 (identity-only `A2A_OWN_IDENTITY_KEY` senders, fail closed). This is a reference only; their contents are not duplicated or re-audited here.
- **PENDING:** receiver-side lifecycle/notify delivery verification requires live fleet restarts (owner-gated) and is tracked on bead `fleet-ops-1py.21`. It is not part of this static audit's verdict.
- Hermes silently drops rejected A2A authentication by design; an upstream feature request for optional rejected-auth logging exists.
