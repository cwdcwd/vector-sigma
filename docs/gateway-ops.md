# Gateway Ops Runbook — virtual keys, model routes, fallback verification

(fleet-ops-e5o.6) The operational half of gateway ownership. The
structure lives elsewhere — the config YAML, the Dockerfile, the
compose contract (see the registrar app README's gateway sections);
this doc is the **recipes**: how to audit keys, how to change a route
and prove it landed, how to verify fallbacks actually fail over, how to
detect and purge the DB-row shadow, and what the daily health pass
asserts. It names no fleet, agent, host, or gateway; every lesson is
stated generically so it translates to any LiteLLM deployment.

Audience, two hands: the **owner** (holds the master key in a password
manager; executes the mutating actions) and the **master device's
coordinator agent** (holds its own virtual key; executes the read-only
probes and the live verification). Master-key material may reach the
agent container through a fleet-variable cascade — reference it
(`$LITELLM_MASTER_KEY`), never print it.

## Rules of engagement

1. **Trust the live router, never the file.** The config file is
   *intent*; the running router's in-memory map — which a database row
   may be shadowing (§6) — is *state*. Every recipe below ends by
   reading state back, not by assuming the edit took.
2. **Pre-flight every admin command shape against the gateway's own
   `/openapi.json`** before it reaches the owner. Admin request/response
   shapes have drifted between LiteLLM releases more than once; the
   pinned image is the only contract. A 30-second `curl
   http://litellm:4000/openapi.json | grep <path>` beats a broken
   owner step.
3. **Dry-run default.** Read (GET) before any write (POST/DELETE). Every
   mutating owner step below is ONE bundled action that carries its own
   read-back verification — never a bare mutation.
4. **Identify keys by alias and hash, never by value.** A key's
   plaintext appears exactly once, at mint time, to the owner. Thread
   evidence carries aliases, hash prefixes, counts, and HTTP codes.
5. **No secrets in evidence** — not in the queue, chat, or repo.
   Commands below reference environment variables; probe bodies are
   filtered to non-secret fields before anything is pasted anywhere.

## Reach

| From | Base URL | Auth |
|---|---|---|
| Coordinator agent's container (master device) | `http://litellm:4000` (compose-internal) | own virtual key; master key via env reference for admin routes |
| Any CA-trusted LAN host (owner) | `https://<TLS_HOSTNAME>:8443` | CA per `docs/tls-runbook.md`; virtual key or master key |
| Owner, browser | `https://<TLS_HOSTNAME>:8443/ui` | master key login |

The stock gateway image ships **no curl** — in-container probes ride
the image's own `python3` (`urllib`), and its shell is dash: bashisms
like `/dev/tcp` do not exist there. The examples below use curl from
CA-trusted hosts and python3 in-container.

## Virtual keys

### Inventory audit (read-only; agent- or owner-executable)

`/key/list` returns **bare token strings by default** — pass
`return_full_object=true` or the response carries nothing you can
safely print. The `key_alias` filter is an **exact match**, not a
substring match.

```bash
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  "http://litellm:4000/key/list?return_full_object=true" \
| python3 -c 'import json,sys
ks=json.load(sys.stdin).get("keys",[])
print("total:",len(ks))
for k in ks:
    print(k.get("key_alias") or "(no alias)",
          "hash:"+str(k.get("key_hash"))[:12],
          "expires:",k.get("expires"),
          "spend:",k.get("spend"))'
```

Assert: every key row has an **alias** (an unnamed key is unauditable),
no key is expired-but-still-live, and spend on each key matches
expectation. A key that cannot be named should be rotated out (below).

### Mint (owner — one bundled action)

Virtual-key minting is owner-side. Response shapes are pre-flighted
against the pinned image's own routes (rule 2); the shape used here —
`POST /key/generate` → `{key: "sk-…", …}` — is the one the deploy E2E
exercises against the exact pinned image on every CI run.

**One action, probe first:** mint a *disposable* probe key (1h
duration), read it back by alias, delete it — then mint the real key.
The probe-mint proves the DB contract (token row written through to
postgres) minutes before the real mint, with zero cost if it fails.

```bash
# 1. probe-mint (disposable, self-expires in 1h)
curl -s -X POST http://litellm:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key_alias":"probe-mint-shape","duration":"1h"}'
# 2. read back by exact alias (asserts the row round-tripped)
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  "http://litellm:4000/key/list?key_alias=probe-mint-shape&return_full_object=true"
# 3. delete the probe
curl -s -X POST http://litellm:4000/key/delete \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key_aliases":["probe-mint-shape"]}'
# 4. real mint — the ONLY step that produces a keeper
curl -s -X POST http://litellm:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key_alias":"vs-<agent-or-use>","duration":"90d"}'
```

The plaintext key appears **once**, in the mint response, to the owner
alone: straight into the password manager, never into chat, the queue,
a commit, or a bundle draft (the delivery path for device keys is the
registrar bundle, not this doc). Optional scoping at mint time, if the
key should not ride the whole route table: `"models":
["<explicit-group>"]`, and budgets (`max_budget`, `rpm_limit`) for
spend control. Read the minted key back by alias (step 2's shape)
before delivering it anywhere — delivery before read-back is how a
typo'd alias becomes a support incident.

### Block, unblock, delete (owner — one action each)

`POST /key/block {"key":"<hash>"}` is the **reversible** first move
for a suspect key (spike, leak suspicion) — one key per call, by token
or token-hash (the request body is `{"key": …}`, a single string; the
plural `{"keys":[…]}` array shape belongs to `/key/delete` only).
`POST /key/unblock {"key":"<hash>"}` reverses it. `POST /key/delete
{"keys":[…]}` (or `{"key_aliases":[…]}`) is permanent. Rotation =
mint the new key → deliver it → block the old one → delete the old one
after the new one is verified live. `GET /key/info?key=<token-or-hash>`
is the read-only per-key status check between moves — note the `key`
parameter there takes the token value or its hash, not the alias.

## Model route changes

The route table ships in the config YAML **baked into the gateway
image** (the supervisor cannot bind-mount config), so a route change is
a repo change: edit the YAML in the repo → PR → merge → tag → the device
pulls the release → the supervisor recreates the container. There is
no live-mutation shortcut, by design — the file in git is the only
place routes are declared.

**LIVE verification after every route change** (rule 1 — never skip
this because "the config looked right"):

1. **Route table loaded:** `GET /v1/models` contains every explicit
   group the YAML declares — a group missing here means the new config
   did not load (stale image, failed release, or a YAML error the
   router swallowed).
2. **Real completion:** one real chat completion through a working key
   against the changed group. This is the only end-to-end proof — the
   route table can list a group whose upstream credential is dead.
3. **Error-path probe when fallbacks were touched:** run the fallback
   discriminator (below) in both directions.

**The rename hazard:** a model rename silently **orphans its fallback
map entry** — the map is keyed on the *old* alias, so the renamed group
fails over to nothing and hard-fails on the first upstream error. Any
rename MUST update `router_settings.fallbacks` in the same change, and
the verification pass MUST re-probe both the renamed group and its
fallback partner.

**The wildcard rule:** a `"*"` pass-through group *routes* arbitrary
names to the upstream, but it *cannot failover* — never list a
wildcard as a fallback target. Every fallback target must be an
explicit, named group.

## Fallback verification recipe

Two truths to check, in order: what the live map *says*, and what the
router *does*.

### Read the live map (read-only)

```bash
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  "http://litellm:4000/fallback/<model-name>"
# 200 {"model":"<name>","fallback_models":[…],"fallback_type":"general"}
# 404 = no live fallbacks for that model — the map lacks the entry
```

This reads the **live router's** fallback list — not the YAML file.
Divergence between this response and the file is the §6 shadow, until
proven otherwise. `GET /router/settings` reads the live router settings
the same way. (The write-side management endpoints under `/fallback`
require a DB-storage mode this deployment deliberately does not enable
— a `POST /fallback` returning `400 Database storage not enabled` is
the gateway refusing, correctly; fallback changes go through the YAML,
per above.)

### The discriminator probe (proves failover end-to-end)

Fail the primary on purpose, ask for it anyway, watch who answers. Two
ways to fail it, in preference order:

**(a) The credential cut (preferred — works on any deployment).**
Temporarily point the primary group's upstream credential at a dead
value in a scratch build of the config (or a scratch key on the
upstream), ship it to a test/staging instance, and probe there. On a
single-production-device topology this is a maintenance-window action:
edit → release → probe → revert-release, with the revert pre-staged.

**(b) The block endpoint (only where models are DB-stored).** The
admin `POST /model/block` takes `{"model_id":"<deployment-id>"}` —
a **deployment ID**, never a group name; find the deployment IDs
behind a group via `GET /v1/models` or the model-management list
endpoints, and block each deployment in the group individually
(`{"keys": …}`-style plural bodies do not exist here either). Caveat:
on a deployment that declares its routes in the config file only —
no `STORE_MODEL_IN_DB` — this endpoint manages the DB-stored model
table and **cannot block file-declared groups at all** (the endpoint
family exists for DB-managed model fleets). If `/model/block` 404s or
422s your group name, that is why: use (a).

The probe itself, with a WORKING virtual key:

```bash
curl -s http://litellm:4000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<primary-group>","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

**Pass:** 200 and the response's `model` field names the **fallback
target**, not the requested group. **Fail:** hard-fail — read the
error body (below), which names the actual mapping state.

Two facts that have bitten fleets before, both verified the hard way:

- **Fallbacks DO engage on 400-class errors.** A request that
  hard-fails with a 400 means the live map **lacks the entry** for
  that group — not that fallbacks "don't cover 400s". Diagnose the
  map, not the error class.
- **Read the error body, not the file.** The error body is the live
  router speaking:
  `{"error":{"message":"…","type":"…","param":null,"code":"400"}}` —
  the message names the missing model or mapping. The file cannot
  testify; it is not running.

## The DB-row-shadows-YAML trap

**Mechanism.** A database-connected gateway keeps a config table
(`LiteLLM_Config`, columns `param_name` / `param_value`). Router-settings
mutations made through the admin surface persist a row (classically
`param_name = "router_settings"`). At **every proxy start** the DB row
**overrides the YAML** — DB values win over file values (the only
exceptions: `None` values and empty lists, which fall through to the
file). The row survives every redeploy, every image rebuild, every
"but I changed the file" — the file edits are silently inert.

**Symptom:** you edit the YAML, ship the release, the live behavior
does not change. Or: a fallback that exists in the file never engages,
and the live map (read above) shows an old alias set.

**Probe (read-only; agent-executable):** compare the two truths —

```bash
# live map vs the YAML's router_settings.fallbacks
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  "http://litellm:4000/fallback/<model-name>"
```

Divergence between that response and the YAML is a shadowing row until
proven otherwise. `GET /router/settings` diverging from the file is
the same signal.

**Fix (owner — ONE bundled action):** in the postgres service terminal
(balenaCloud dashboard → device → postgres service, or the self-host
equivalent), against the gateway's own database:

```sql
-- 1. RECORD the row — the recorded param_value IS the rollback
SELECT param_name, param_value FROM "LiteLLM_Config";
-- 2. delete the shadowing row
DELETE FROM "LiteLLM_Config" WHERE param_name = 'router_settings';
```

Then recreate the gateway container (balenaCloud: restart the litellm
service; self-host: `docker compose up -d --force-recreate litellm`)
and **verify live**: the fallback read now matches the file, and the
discriminator probe passes in both directions. **Rollback** = re-INSERT
the recorded row (then recreate again). Paste-back evidence for the
fix is the *param_name list* before/after plus the post-fix live
reads — never the full `param_value` blob (it can embed connection
strings).

Do not skip step 1. Deleting an unrecorded row destroys the only copy
of state that may contain the fleet's only live record of a past
deliberate change.

## Health watch — what the daily pass asserts

Asserted daily, in this order, by whoever runs the fleet's health pass
(agent-executable from the master device; owner-executable from a
CA-trusted host):

1. **Process liveness:** `GET /health/liveliness` → 200. DB- and
   route-independent — a green here proves only that the process
   breathes. (Current releases also serve the correctly-spelled
   `/health/liveness`; pre-flight which one your pin answers — rule 2
   — and assert the one it serves.)
2. **Route table loaded:** `GET /v1/models` contains **every explicit
   group the config declares** — count them against the YAML.
3. **A real completion** through a working key. This is the only
   end-to-end assertion, and the one that catches what the first two
   cannot: a gateway can serve green liveness and a full model list
   while every completion fails on a dead upstream credential or an
   orphaned route. If the fleet's daily pass asserts only #1, it is a
   heartbeat monitor, not a health check.

**Escalation order on any failure:** run the fallback discriminator
(§5) → the shadow probe (§6) → the route-change verification (§4), in
that order — cheapest probes first, and each one's output is the next
one's input.

## The memory plane (e5o.3)

The gateway serves the fleet's cross-session memory store at
`/v1/memory` (stock on the pinned tag; DB-backed by the same prisma
migrations as the key tables — no config block, no feature flag). Agent
tooling for it ships in both Hermes images (the `gateway-memory` plugin
+ the `06-vs-memory-tools` boot hook).

**Keys:** two route-restricted virtual keys per agent —
`memory-shared-<agent>` (team-scoped) + `memory-private-<agent>` (no
team) — both `allowed_routes`-locked to the memory API. Because
`allowed_routes` is a hard allowlist for every role INCLUDING admins
(source-verified on the pinned tag), these keys can do nothing but
memory reads/writes; a leaked memory key leaks the store, not the
gateway.

**The scoped key-creator key:** the registrar console's
*Mint memory keys* action mints the per-agent pair using a creator key
bound to a `proxy_admin`-role user whose own `allowed_routes` is locked
to the mint surface (`/user/new`, `/team/new`, `/team/list`,
`/team/member_add`, `/key/generate`) — never the master key. Setup is a
one-time owner action recorded in the registrar README
(`GATEWAY_KEY_CREATOR_KEY` + `GATEWAY_KEY_MINT_BASE_URL` on the
registrar service). The creator key appears in NO bundle, NO image, and
NO device env.

**Daily pass addition (the memory leg):** after the completion probe,
one memory round-trip through an agent's shared key —
`GET /v1/memory/<known-conventions-key>` → 200. This proves the DB row
path (prisma), the key's route lock still admits the memory route, and
the store answers — without writing anything. A 401/403 means the key
rotated or the row changed; a 404 on a key that should exist means the
DB lost rows (check the postgres volume before anything else).

**Inventory audit addition:** the key inventory sweep should flag (a)
any `memory-*` alias whose agent no longer exists in the registrar, and
(b) any key carrying `allowed_routes` containing `/v1/memory` whose
alias does NOT match the `memory-*` scheme — both are drift signals.

## The A2A mesh plane (j7g.1)

Mesh identity keys (`vs-<agent>-a2a`) are minted by the REGISTRAR's
mesh-enroll action — never by hand, never by an agent. The minted
shape is hardcoded server-side (registrar/src/mesh-enroll.ts): models
empty, tpm unset, `allowed_routes` locked to `/a2a`, `/a2a/*`,
`/v1/agents`. The route lock is the whole containment story: a mesh
key can ride the mesh and nothing else — no model calls, no key
management, no memory routes.

**The creator key now also serves the mesh-enroll action.** Its
`allowed_routes` lock extends the e5o.3 mint surface with `/key/list`
(the enroll's liveness probe) and `/v1/agents` (the card-row
registration). Two provisioning shapes, in priority order:

1. `GATEWAY_KEY_CREATOR_KEY` set on the registrar service env (the
   e5o.3 owner setup) — used as-is; nothing changes.
2. **Registrar-side bootstrap** (the j7g.1 design call): when the env
   var is unset, the first mesh-enroll call mints the scoped
   key-creator key from the composition master key
   (`LITELLM_MASTER_KEY` must reach the registrar service for this),
   caches it in-process, and records its argon2id hash in the
   `gateway_creator_key` table. The bootstrap is SELF-HEALING: a
   registrar restart re-mints (the old registrar-managed alias is
   deleted first via the master key). A hand-minted `key-creator`
   alias with no marker row is REFUSED — an owner-held credential is
   never silently destroyed; the message names the manual step.

The master key is therefore used ONLY by the bootstrap (and never
reaches the enroll's steady-state calls). When the owner later
service-scopes `LITELLM_MASTER_KEY` (the standing hardening option),
the env-set creator key (shape 1) keeps the capability green with no
registrar access to the master at all.

**Daily pass addition (the mesh leg):** `GET /key/list` for each
enrolled `vs-<agent>-a2a` alias → present, `models: []`, mesh-only
`allowed_routes`. `GET /v1/agents` → every enrolled agent's row
present. A missing alias means the mesh key was deleted (re-enroll
heals); a widened `allowed_routes` means the row was hand-edited —
revoke and re-enroll.

**Inventory audit addition:** flag any `vs-*-a2a` alias whose agent
row is absent from the registrar, and any key with mesh routes whose
alias does NOT match the `vs-*-a2a` scheme.

**Kill switches:** deleting the primus machine-key row
(`mesh_enroll_keys`, console → Mesh-enroll keys → Revoke) kills the
machine-auth trigger instantly; revoking the `key-creator` alias at
the gateway kills all minting (the registrar refuses with the
not-configured fallback on the next call). Both are owner actions.

## The model-key plane (fleet-ops-1py.46)

Every device's LLM serving credential — the `GATEWAY_API_KEY` line of
`config/agent.env` — can be provisioned by the registrar console
instead of a hand-mint (device page → Actions → **Mint model key**).
Alias scheme: `model-<agent>` (deterministic, same sanitization as the
memory scheme). Minted by the same scoped key-creator key as the memory
keys — its j7g.1 route lock already covers the whole surface (`/key/list`
probe, `/user/new`, `/key/generate`) — and route-locked at mint time to
the completions surface only: `/v1/chat/completions`, `/v1/completions`,
`/v1/responses`, `/v1/embeddings`, `/v1/models` (bare + `/*` pairs). A
model key serves the agent's model calls and nothing else — no key
management, no mesh, no memory routes. The minted value reaches the
device through the bundle plane (0600) and is never shown in the console
(the no-secret-output rule: registrar UI output renders no key values).

**Decision table (mirrors the mesh-enroll enroll):** MINT when the alias
is absent (the agent's `agent-<name>` user row is ensured idempotently
first); OPEN — nothing re-minted, nothing changed — when the alias is
live and the device bundle already carries a key (the bundle is the
truth); REFUSE when the alias is live but the bundle carries nothing:
the plaintext is unrecoverable, so the message names the recovery step
(revoke the alias in the LiteLLM console, re-run the mint). Never
re-mint over a live alias.

**Daily pass addition (the model leg):** `GET /key/list` for each
`model-<agent>` alias → present, `allowed_routes` completions-only. A
missing alias means the key was deleted at the gateway — re-run the
console action to mint fresh (the bundle without a live alias is inert;
delivery needs the provision step again).

**Inventory audit addition:** flag any `model-*` alias whose agent row
is absent from the registrar, and any key carrying a completions route
whose alias does NOT match the `model-` scheme — both are drift
signals, same posture as the memory and mesh audits.
## Gateway upgrade & rollback (LiteLLM 1.x)

This procedure covers the stock LiteLLM image and its PostgreSQL state. It is
for a controlled staging upgrade, not an instruction to mutate production.
The non-production verification for this change is the CI end-to-end job,
which boots the rebuilt gateway image on the pull request. A live production
upgrade is owner-gated and out of scope for this branch.

### Before the upgrade: backup and rollback anchor

1. Confirm the currently serving image reference and record its immutable local
   image ID/digest. Tag that exact image in the available image store as a
   rollback anchor **before** building or swapping anything (for example,
   `docker tag <current-image-id> litellm:rollback-<change-id>`). Do not rely on
   a moving upstream tag as the rollback copy.
2. Take a custom-format PostgreSQL dump of the LiteLLM database using the
   deployment's established database credentials (do not put credentials in
   shell history or this runbook):

   ```bash
   umask 077
   pg_dump -Fc --dbname="$DATABASE_URL" --file=litellm-before-upgrade.dump
   chmod 600 litellm-before-upgrade.dump
   pg_restore --list litellm-before-upgrade.dump > litellm-before-upgrade.list
   ```

   Require `pg_dump` and `pg_restore --list` to exit successfully and confirm
   the listing contains the expected LiteLLM schema objects before proceeding.
   The dump is sensitive: it can contain stored prompts and other request data.
   Keep it access-restricted (mode `0600`), in approved encrypted storage, and
   delete the working copy once the upgrade is trusted and the backup-retention
   policy permits. Never attach it to a ticket or commit it.
3. Record the current image reference, database backup location, and a
   successful pre-upgrade health/model baseline without recording credentials
   or prompt bodies. Confirm the previous image can be recreated before the
   maintenance window.

### Build and swap

1. Build the new image from the reviewed Dockerfile while the existing gateway
   container continues serving. Keep the image stock; do not patch LiteLLM.
   Confirm the built image identifies the intended version before the swap.
2. Stop/recreate the gateway service with the new image using the deployment's
   normal owner-controlled rollout mechanism. Preserve the PostgreSQL volume;
   do not remove or reinitialize it.
3. Wait for startup and database migrations to finish. Read health and startup
   logs until the service is ready and there are no migration errors. Do not
   start verification traffic while migrations are still running.
4. If a config-key compatibility question cannot be settled from repo-local
   evidence, explicitly verify it at this first staged boot: inspect startup
   logs and the live router for the existing `model_list` entries and their
   `model_name` / `litellm_params` (`model`, `api_base`, `api_key`),
   `router_settings.fallbacks`, and `general_settings` (`master_key`,
   `database_url`). Confirm environment-variable resolution and both configured
   fallback directions. These keys are deliberately not changed by this
   upgrade; do not guess at renames or deprecations.

### Verification battery

After readiness, run and record results (status, model/group alias, and timings;
never key values, authorization headers, or prompt contents):

- Health endpoint responds successfully and reports the gateway ready.
- Make one minimal model call through every configured tier/group, including
  each explicit model and configured fallback direction; prove a real upstream
  completion, not merely that `/v1/models` lists it.
- Complete one MCP round-trip using the normal non-production test client.
- Complete one A2A send and receive between the test peers.
- Exercise a disposable virtual key with a small budget: confirm an allowed
  call succeeds and the expected budget state/limit is visible; remove or let
  the throwaway key expire afterward.
- Verify spend logging is still produced and inspect the recorded request
  fields for credential redaction, specifically the request-body redaction
  introduced by LiteLLM #43635. Check only sanitized field presence/shape;
  never print or copy stored prompt/request bodies.
- The automated non-production E2E regression (AC9c) enables prompt storage
  only in its disposable runtime database, submits synthetic credential
  canaries to the isolated LiteLLM runtime fixture pinned to the same 1.105.1
  image digest as the gateway, using its explicit `runtime-spendlogs-test`
  model whose only upstream is the local mock Ollama service (no external
  provider traffic). It reads the stored spend row via
  `/spend/logs/ui/{request_id}`, asserts every canary is absent from the row and
  all five credential-named fields contain `REDACTED_BY_LITELLM`, then restores
  prompt storage to off. Never reuse real credentials or run this probe against
  production.
- If anything consumes the authenticated `/api/usage` endpoint, make one
  one-time authenticated shape probe from the boundary where its credential
  already lives. Record only field names and non-sensitive types/counts,
  compare with the consumer's expectations, and fail soft if the upstream
  shape differs. Do not expose the credential or response contents containing
  sensitive usage details.

Non-production verification for this branch is CI e2e booting the rebuilt
gateway on the PR. The battery above is the staged/live operator checklist;
 it does not authorize production rollout. Live production upgrade requires
 explicit owner approval and is outside this branch.

### Rollback

1. If verification fails, restore the rollback anchor by retagging the saved
   old image to the deployment's expected image reference, then recreate the
   gateway service with that image. Example: `docker tag
   litellm:rollback-<change-id> <deployment-image-reference>` followed by the
   normal service recreate. Keep PostgreSQL and its volume intact initially.
2. The newer LiteLLM may have migrated the schema. First attempt to run the old
   image against the migrated schema and verify health. Restore the database
   dump **only if the old version cannot run on the migrated schema**; a dump
   restore is a destructive rollback of database state accumulated since the
   backup and requires owner approval. If needed, stop writes, preserve the
   failed post-upgrade database for diagnosis, restore the pre-upgrade dump to
   the intended database, and verify with the old image before reopening
   traffic.
3. Repeat the health, one model call per configured tier, MCP, A2A, and
   budget-key checks. Retain the protected dump only under the approved
   retention policy, then securely remove working copies once the rollback or
   upgrade is trusted.

## Evidence discipline

Whatever lands on the work-tracking thread: aliases, hash prefixes,
counts, HTTP codes, the recorded row's param_name — **never** key
values, never the mint response body, never a raw `param_value` blob.
A probe that cannot be pasted safely has not been filtered enough:
filter it in the probe (the python one-liners above), not by hand.

## Ollama native routing (SpendLogs preservation)

Ollama Cloud's OpenAI-compatible `/v1` endpoint reuses response IDs from
`chatcmpl-0` through `chatcmpl-999`. LiteLLM uses the provider response ID
as the SpendLogs `request_id`; once an ID repeats, `skip_duplicates` silently
drops the successful SpendLogs row. The request itself succeeds, so the missing
rows are easy to mistake for low traffic. The two explicit GLM groups therefore
use LiteLLM's native `ollama_chat` provider at `https://ollama.com` (native
`/api/chat`, with no `/v1`); the wildcard remains on the existing
`OLLAMA_CLOUD_API_BASE` `/v1` route for compatibility. Native responses omit
provider IDs, allowing LiteLLM to mint unique request IDs.

**Native-path trade-offs:** Ollama reports cache hits as
`prompt_eval_cached_count`, which LiteLLM does not currently map. LiteLLM thus
shows 0% cached and overstates Ollama cost by about 3–4× even though Ollama
continues caching. Also, `reasoning_effort` maps to think on/off for non-`gpt-oss`
models, so low/high effort variants behave alike.

Context limits in `/v1/models` are configuration-dependent: LiteLLM needs
`model_info.max_input_tokens` for aliases absent from its cost map. The
`glm-5.3` route declares 1,000,000 tokens. The repository does not verify a
`glm-5.2` limit, so its value is intentionally omitted pending verification.

**How to verify:** issue successful requests through each explicit route and
confirm SpendLogs row counts increase per successful request. Prometheus
request counters provide a fallback comparison if SpendLogs rows appear
missing; the compose end-to-end smoke remains a CI check.
