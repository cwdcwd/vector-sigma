# Gateway & agent hardening plan

**Status:** proposed · **Scope:** the LiteLLM gateway image (`balena/registrar`), the
Hermes device/agent templates (`balena/devices`, `deploy/`), and operator docs.

This plan carries over lessons from running the same stack — LiteLLM gateway + Ollama Cloud +
Hermes agents over A2A — in a production fleet during October 2026. Every item is expressed as
config-driven defaults, templates, or operator documentation: no deployment-specific names,
hostnames, addresses, or credentials belong in this repo.

Items are ordered by impact. Section 1 fixes problems the current defaults very likely already
have; later sections are improvements.

---

## 1. Correctness bugs in the current defaults

### 1.1 Ollama Cloud on the OpenAI-compatible endpoint silently drops spend logs
**Today:** `litellm-config.yaml` routes Ollama Cloud models as `openai/<model>` against
`OLLAMA_CLOUD_API_BASE` (`https://ollama.com/v1`).

**Problem:** Ollama Cloud's `/v1` endpoint returns response ids from a small reused range
(`chatcmpl-0` … `chatcmpl-999`). LiteLLM uses the provider response id as the SpendLogs
`request_id`, which is unique and inserted with `skip_duplicates`. Once the id range is used,
**every later successful request collides and is silently not logged** — no error, no warning.
Failed requests still log (they get a LiteLLM-minted id), so the logs show only failures.
Prometheus counters still see the traffic, which is how the gap can be confirmed.

**Fix:** route Ollama Cloud through LiteLLM's native provider:
```yaml
- model_name: ollama-cloud/glm-5.3
  litellm_params:
    model: ollama_chat/glm-5.3
    api_base: https://ollama.com          # native /api/chat, no /v1
    api_key: os.environ/OLLAMA_CLOUD_API_KEY
```
Native responses carry no id, so LiteLLM mints unique ones and every request is logged.
Tool calls, streaming, and thinking work on the native path.

**Known trade-offs of the native path (document them):**
- Ollama reports cache hits in `prompt_eval_cached_count`, which LiteLLM does not yet map
  (upstream issue #45021, fix PR #45030 open). Until it merges, LiteLLM shows Ollama traffic
  as 0% cached and **overstates Ollama cost ~3–4×**. Ollama itself does cache on this path.
- `reasoning_effort` maps to think on/off for non-`gpt-oss` models, so low/high effort variants
  of the same model behave alike.

### 1.2 Ollama spend records as $0
**Today:** no `model_info` pricing on the Ollama groups, so cost tracking and budgets see $0.

**Fix:** add per-model `model_info` pricing (`input_cost_per_token`,
`cache_read_input_token_cost`, `output_cost_per_token`) from ollama.com/pricing.

For the **authoritative bill**, document Ollama's read-only usage endpoint:
`GET https://ollama.com/api/usage` with the same Bearer key. It returns per-day buckets
(`request_count`, `usage_usd`, `input_tokens`, `cached_input_tokens`, `output_tokens`) scoped to
the calling key. It is undocumented upstream, so consumers must fail soft. Run it where the key
already lives (e.g. inside the gateway container) so the key never leaves that boundary.

### 1.3 Agent keys see an empty model list
**Today:** keys granted `models: ["*"]` alongside a `"*"` pass-through model group.

**Problem:** LiteLLM's "all models" grant is the special value `all-proxy-models`. A key list
containing `"*"` is treated as a wildcard route; with a provider-less `"*"` group it expands to
nothing, so `/v1/models` returns an empty list to agent keys (calls still work). Hermes then
cannot read the model's context window and falls back to 256K, which shrinks its post-compression
context tail.

**Fix (pick one, document both):** set `model.context_length` explicitly in the agent template
(see 3.3), and/or grant keys `all-proxy-models` instead of `"*"` (test that this does not change
which pass-through model names a key may call).

### 1.4 Gateway image is pinned to an old release
**Today:** `FROM ghcr.io/berriai/litellm:1.100.1`.

**Fix:** move to the current stable (1.105.1 at time of writing). Notable: request-body
credentials are kept out of stored spend-log requests (#43635), decisions/System One routes are
mainline, auto-router fixes. Upgrade procedure in 4.5. Keep the image stock — no code patches;
known gaps are tracked upstream and picked up by upgrading.

---

## 2. Cost defaults

### 2.1 Cheaper default model
**Today:** only `glm-5.3` and `glm-5.2` (≈ $1.40 / $0.26 cached / $4.40 per 1M in/out).

Agent turns are input-dominated (≈100 input tokens per output token, as each turn resends the
conversation), so input and cached-input rates drive cost. Ship a cheaper default and keep the
large model for heavy work:

| Role | Suggested model | Why |
|---|---|---|
| default | `glm-5.3-flash` | ≈9× cheaper per typical turn than `glm-5.3`, 1M context, tools + thinking |
| heavy reasoning | `glm-5.3` | best quality, use sparingly |
| background / cron | `nemotron-3-super` | near-zero input cost; not for real work |
| fallback | `deepseek-v4.1-flash` | cheapest cached input; half price off-peak |

Each gets pricing (1.2) and a fallback chain.

### 2.2 Optional auto-router template
Offer a commented `auto_router/complexity_router` group (tiers SIMPLE/MEDIUM/COMPLEX/REASONING
mapped to whatever providers the operator configures), with `session_affinity: true` so a
session stays on one model and keeps its prompt cache. Two pitfalls to document:
- **`context_compaction` must be `false` when any tier is `ollama_chat/*`.** Compaction sizes the
  chosen deployment via a model-map lookup that raises `ModelNotMappedError` for models absent
  from LiteLLM's map; it is not caught, so every request on that tier silently falls back to the
  next fallback model (visible only in Prometheus fallback counters). Declaring `model_info`
  limits does not help — the global map lookup raises first. Related: upstream #23054. Client-side
  compression (3.1) makes router compaction redundant.
- `classification_rubric` belongs to the LLM-judge classifier; the heuristic classifier silently
  ignores it.

### 2.3 Per-key budgets
Add an example of weekly caps on agent keys (`max_budget` + `budget_duration: 7d`). Caveat: the
cap is checked against the key's running spend, which only resets at `budget_reset_at`; when
adding caps to existing keys, call `POST /key/{token}/reset_spend` with `{"reset_to": 0}` or the
key may be blocked immediately on lifetime spend. Budgets also gate MCP calls made with that key.

---

## 3. Hermes agent template defaults

Ship these in the device/agent config template (all overridable):

### 3.1 Absolute compression cap
```yaml
compression:
  threshold_tokens: 128000
```
Hermes compresses at a fraction of the model's context window (default 0.50). With 1M-window
models that means ≈500K tokens before compressing — observed in practice as 150–250K-token
prompts on every turn. An absolute cap bounds per-turn input regardless of model.

### 3.2 Tool-output caps
```yaml
tool_output:
  max_bytes: 20000
file_read_max_chars: 40000
tool_budget:
  mcp_result_size_chars: 20000
```
Large tool results are what refill context fastest (observed: 58K → 131K in three minutes during
audit work, stalling compression because the oversized results sit in the protected tail).
Oversized output still spills to `cache/spillover/` with a pointer.

### 3.3 Explicit context length and summary model
```yaml
model:
  context_length: 1000000     # match the gateway's declared window for the default model
auxiliary:
  compression:
    provider: custom
    model: <a fast model whose context window >= the main model's>
    base_url: <gateway /v1 URL>
```
Pinning the summary model avoids routing summaries through a router (observed 48–100 s per
summary) and satisfies Hermes' rule that the summary model's window must be at least the main
model's.

---

## 4. A2A and operations

### 4.1 A2A credentials — audit every send path
Per-agent identity keys (`A2A_PEER_TOKENS`) are already the design here. Audit that **no** send
path — startup/notify hooks, helper scripts, watchdogs — authenticates A2A with the agent's
gateway/model key or falls back to it. Receivers do an exact Bearer match, fail closed, and
**drop 401s without logging**, so a wrong-key path fails silently (in the source fleet, restart
notifications were lost for a month this way). Remove any "last resort" fallback to the gateway
key. Consider an upstream Hermes feature request for logging rejected A2A auth.

### 4.2 Liveness without LLM calls
Check agent health via the Hermes dashboard's public `GET /api/status` (`gateway_running`,
platform states) rather than sending agents a chat message — an hourly "are you alive?" ping
costs a full agent session per agent per hour. Keep at most one daily end-to-end LLM ping.

### 4.3 Reverse-proxy front for the gateway
If the gateway sits behind Caddy (or similar):
- LiteLLM keys sent as `X-Litellm-Api-Key` are **not** redacted by Caddy's default log
  redaction (it covers `Authorization`/`Cookie`). Add a log filter deleting that header.
- To get real client IPs: `use_x_forwarded_for: true`, and trust XFF only from the proxy. If the
  trust is pinned to the proxy's container IP, **pin that IP in compose** (`ipv4_address` outside
  the network's dynamic `ip_range`) — container IPs reshuffle on stack restarts and a stale pin
  silently disables the trust.
- Do not publish the gateway's plain-HTTP port or the database port beyond loopback.

### 4.4 Decisions lane (optional)
If agents use `/v1/systemone` or `/v1/decisions`, document a `decide` group on a fast hosted
decision-capable model with a self-hosted decision model as fallback (router fallbacks apply to
decision calls). Note that `score` question `criteria` must be a list of levels, and route any
decision over sensitive free text to the self-hosted model only.

### 4.5 Gateway upgrade runbook
Document the procedure: dump the database (`pg_dump -Fc`, verify with `pg_restore --list`), tag the
running image as a rollback anchor, bump the pinned base, build while the old container serves,
swap, wait for migrations, verify (health, model calls on each tier, MCP, A2A, budgets), and keep
the rollback commands (retag + recreate; restore the dump only if the old version cannot run on
the migrated schema). Stored prompts make the dump sensitive — keep it 0600 and delete it once the
upgrade is trusted.

---

## Suggested order
1. Section 1 (data loss and wrong costs today): 1.1 → 1.2 → 1.3 → 1.4.
2. Section 3 (agent templates) together with 2.1 (default model), since both cut tokens per turn.
3. 2.2–2.3, then section 4.

## Out of scope
Deployment-specific values (hosts, keys, budgets, model choices) stay in each operator's own
config. This repo ships defaults, templates, and documentation only.
