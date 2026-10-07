# SOUL amendment — primus management authority (j7g.1)

**Status: PROPOSED. Ships as documentation; the owner pastes the clause
into primus's bundle SOUL.md at tag time (owner action, per ruling 2,
Slack 2026-10-07: "Primus should have full management control on the
gateway and on the fleet except for things like managing AI provider
keys").**

## The proposed clause

Paste this into `SOUL.md` in primus's registrar bundle (console →
Devices → primus → Edit bundle → `soul_contents`), replacing or
extending the standing authority paragraph:

```markdown
## Management authority (owner ruling 2026-10-07)

You hold full management control of the VS gateway and the VS fleet —
including minting A2A mesh identity keys for enrolled devices via the
registrar's mesh-enroll action (`vs-mesh-enroll <agent>` on this host;
the registrar mints, merges, and registers server-side; keys reach
devices through the bundle plane, never through you) — excepting AI
provider credential management (upstream model API keys and the
gateway master key remain owner-side) and the standing owner-gated
classes (credential writes, secret handling, package installs, and
mutations of your own config or SOUL).
```

## What the clause covers

The mesh-enroll capability shipped in registrar release v1.3.0
(fleet-ops-j7g.1): `POST /v1/mesh-enroll` on the registrar, driven by
primus's scoped machine key (`MESH_ENROLL_KEY`, delivered in the
bundle), or the console's per-device **Enroll in A2A mesh** action.

**Primus never holds minting credentials.** The scoped key-creator key
lives only in the registrar service container (the e5o.3 custody
invariant). The API returns `{alias, action, merged}` only — key
material never crosses to the caller; identity keys reach enrolled
devices through the registrar's bundle delivery plane, 0600,
device-local. The owner kill switch is deleting the primus machine-key
row in the console (Mesh-enroll keys → Revoke): the enroll surface
refuses all calls until a new key is minted and delivered.

**The exceptions stay owner-side** per the ruling's own carve-out and
the standing ADR-0001 owner-exception classes: upstream model API keys
(`OLLAMA_CLOUD_API_KEY`), the gateway master key
(`LITELLM_MASTER_KEY`), and every credential write, secret handling,
package install, or self-config/SOUL mutation.

## The mechanism, for the record

- `registrar/src/mesh-enroll.ts` — the enroll core: sentinel-shape
  mint (models empty, tpm unset, `allowed_routes` mesh-only,
  hardcoded server-side), the MINT/OPEN/REFUSE decision table,
  both-sides bundle merge, gateway card-row registration, audit rows
  for success AND failure.
- `POST /v1/mesh-enroll` — the machine-auth trigger (Bearer + argon2id
  hash row + per-IP rate limiter + audit), mirroring the device-API
  pattern. `mk_`-prefix key class, structurally distinct from device
  (`bk_`) and admin (`ak_`) keys.
- `scripts/vs-mesh-enroll.py` (baked at `/usr/local/bin/vs-mesh-enroll`
  on the primus image) — the one-command CLI; reads `MESH_ENROLL_KEY`
  from the bundle's `config/agent.env`, never from image layers.
- Console: **Mesh-enroll keys** page (mint show-once + revoke) and the
  per-device **Enroll in A2A mesh** action (owner-side trigger of the
  same core).
- The creator-key bootstrap (see docs/gateway-ops.md): the registrar
  mints its own scoped key-creator key from the composition master key
  when `GATEWAY_KEY_CREATOR_KEY` is unset — the e5o.3 one-time owner
  setup, automated, self-healing across registrar restarts.