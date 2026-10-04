# gateway-memory — provenance

This plugin is a product-agnostic copy of the origin fleet's `fleet-memory`
Hermes plugin, shipped in the VS agent images per the shared-memory ruling
(fleet-ops-e5o.2, owner rulings 2026-10-04: "Adopt", "Bake").

- **Origin version:** fleet-memory 1.0.0 (5 files, ~290 lines, stdlib-only)
- **Copy taken:** 2026-10-04 (fleet-ops-e5o.3)
- **Changes vs origin, by design (reviewed, not drift):**
  1. Product-agnostic rename: `fleet-memory` → `gateway-memory`;
     tools `fleet_memory_{get,set,list}` → `memory_{get,set,list}`; env keys
     `LITELLM_MEMORY_{SHARED,PRIVATE}_KEY` → `GATEWAY_MEMORY_{SHARED,PRIVATE}_KEY`.
     "LiteLLM" and origin-fleet names removed from all user-visible strings
     (the fleet-agnostic content rule; "gateway" is the generic term).
  2. `plugin.yaml` `requires_env` declares BOTH keys — the origin declares
     only the shared one (the verified gap from the peer consult; tools.py
     reads both).
  3. `FLEET_MEMORY_BASE_URL` keeps its name (the retarget seam is already
     supported; renaming it would fork the env contract).
  4. The gateway base-URL DEFAULT is emptied (the origin's default pointed
     at its own fleet's gateway host).
     No default gateway: an unset env now fails loud with a clear error
     instead of silently targeting the origin fleet's store from a VS
     host — a cross-fleet data-leak guard. The bundle always delivers
     the env; the default is never the working path on any fleet.
- **Everything else is unrestructured** — the origin's logic, error shapes,
  and scope semantics are byte-preserved modulo the rename map above.

## Drift check

A vendored copy that silently diverges from this source-of-truth dir is the
failure mode the provenance stamp exists to catch. `provenance-sha256.txt`
records the sha256 of every file in THIS dir at bake time; the image build
re-derives them and fails loud on mismatch. If the origin plugin changes
upstream, re-copy it here (re-applying the rename map), regenerate the
stamp, and the drift test (registrar/test/gateway-memory.test.ts) enforces
the parity contract in CI.