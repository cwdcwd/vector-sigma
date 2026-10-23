# Spike: secrets management — rotation, audit, BYO stores, no residency

Status: **spike proposal** (time-boxed investigation; nothing here is built).
Companion to [console-roadmap.md](console-roadmap.md).

## Why

Vector Sigma delivers secrets well: never baked, delivered once per slot,
written `0600`, rotated without reflash. What it does not yet give an
organization running it as a product:

1. **Central rotation and audit.** One place to rotate or revoke a secret
   across every agent that uses it, and to see *who used what, when*.
2. **Bring-your-own secret store.** Organizations already keep secrets in
   Bitwarden, 1Password, AWS Secrets Manager or HashiCorp Vault and will
   not re-type them into another database.
3. **No secret residency on agents.** Today an agent holds its secrets in
   plaintext files and process env for as long as it runs. A hijacked
   agent can read them; a stolen device carries them.

Priorities from the owner: **(1) and (2) first**, with (3) as the
architecture that makes (1) honest (usage can only be audited if the use
passes through something we control).

## Current state

What a bundle carries today (`registrar/src/structured-fields.ts`):

| Secret | Delivered to | Lifetime on the agent |
|---|---|---|
| `GATEWAY_API_KEY` | `config/agent.env` | Until rotated; long-lived |
| `SLACK_BOT_TOKEN` | `config/secrets.env` | Until rotated; long-lived |
| GitHub App PEM | `config/github-app.pem` | Until rotated; used to mint short-lived installation tokens |
| Secret-looking `extra_env` keys | `config/agent.env` | Until rotated |
| A2A signing key | Generated on the agent, held by the a2a-guard | Agent-resident by design |

- **At rest in the registrar:** bundles (including the values above) are
  stored as JSONB in `identity_blobs`. `db/key-crypto.ts` hashes the
  registrar's own keys; bundle contents have no application-level
  encryption and rely on database access control.
- **Rotation:** an owner edit bumps the bundle version; the agent's
  rotation watcher re-fetches. Rotating one value used by many agents
  means editing each agent's bundle.
- **Audit:** delivery and owner actions are logged; *use* of a secret is
  not visible to Vector Sigma.

Patterns Vector Sigma already uses that point the way:

- **Model credentials are already brokered:** agents hold only a gateway
  key; real provider keys stay on the gateway.
- **Signing is already brokered:** the a2a-guard holds the agent's signing
  key and signs outbound A2A on its behalf.
- **Short-lived tokens:** the GitHub identity wrapper mints installation
  tokens on demand from the PEM.

## Options reviewed

| Option | What it does | Fits (1) rotation/audit | Fits (2) BYO | Fits (3) no residency | Notes |
|---|---|---|---|---|---|
| **Hermes + Bitwarden Secrets Manager** ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/secrets/bitwarden)) | At startup, `bws` lists a project's secrets with a machine-account token and writes them into the agent process env (TTL cache, optional encrypted stale cache) | Partial: central store, rotation applies on next start | Bitwarden only | **No:** values land in agent env; bootstrap token is plaintext in `~/.hermes/.env` | Hermes-only; never blocks startup on failure |
| **Bitwarden Lite** ([docs](https://bitwarden.com/help/install-and-deploy-lite/)) | Single-container self-hosted Bitwarden server (ARM-capable, SQLite/Postgres/MySQL) | Store only | — | — | Labelled "personal use and home-labs, not business"; **self-hosting Secrets Manager requires an Enterprise license**. Poor fit as a product dependency |
| **Varlock credential proxy** ([docs](https://varlock.dev/guides/proxy/)) | Agent sees placeholder values; a proxy swaps in real values on outbound requests to allowed domains, scrubs responses, policy-checks and audits each request | **Yes:** every use is a logged, policy-checked request | Yes: plugin sources (1Password, AWS, Vault, `exec()`) | **Yes**, if the proxy runs outside the agent's container | **Preview** feature; not a hard boundary on the same host (Varlock's own guidance: pair with a sandbox) |
| **Infisical Agent Vault** ([post](https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents.md)) | Open-source credential broker/vault for agents, typically as an `HTTPS_PROXY` forward proxy | Yes | Infisical-centric | Yes, as a sidecar | Evaluate maturity and BYO-source support |
| **VS-native broker sidecar** | Our own sidecar extending the a2a-guard pattern: holds secrets, injects auth on egress, logs use | Yes, fully under our audit model | Through VS source plugins | Yes | Most control, most work; no third-party preview risk |
| **AgentCore Identity** (AWS) | Substrate-native token vault and credential providers for agents | Yes (AWS-side) | AWS-centric | Yes | The natural broker *on the AgentCore substrate*; VS should integrate, not duplicate |

## Proposed architecture

```
 secret sources (pluggable)         Vector Sigma                     agent host
 ┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────────┐
 │ registrar DB (default)   │  │ registrar                │  │ broker sidecar               │
 │ Bitwarden SM (plugin)    │─▶│  · secret catalog        │─▶│  · real values (memory only) │
 │ 1Password (plugin)       │  │  · per-agent grants      │  │  · injects auth on egress     │
 │ AWS SM / Vault (plugin)  │  │  · rotation fan-out      │  │  · allowlisted destinations   │
 └──────────────────────────┘  │  · usage audit ingest    │◀─│  · usage events → registrar   │
                               └──────────────────────────┘  │ agent container              │
                                                             │  · placeholders only         │
                                                             └──────────────────────────────┘
```

1. **Secret catalog in the registrar.** A secret becomes a first-class
   object (`name`, `source`, `source_ref`, `rotation_policy`, `owner`)
   instead of a value typed into each bundle. Bundles reference secrets by
   name; a grant table records which agents may use which secret.
2. **Pluggable sources** behind one interface (`resolve`, `listVersions`,
   `rotate?`, `watch?`). Default: the registrar's own store, with
   application-level encryption added (per-workspace key). Plugins:
   Bitwarden Secrets Manager, 1Password, AWS Secrets Manager, Vault.
   Bitwarden is **optional**, never required.
3. **Rotation fan-out.** Rotating a catalog secret (or the source changing
   it) bumps every granted agent's delivery in one action, with overlap
   windows for credentials that support two live values.
4. **Broker sidecar on each agent host** (substrate adapter decides how:
   a sidecar container on Balena/Compose; AgentCore Identity on
   AgentCore). The agent container gets placeholders; real values live only
   in the sidecar's memory; egress is allowlisted per secret.
5. **Usage audit.** The sidecar reports each brokered use (secret name,
   agent, destination, time, allow/deny) to the registrar; the console
   shows it per secret and per agent.
6. **Secrets that cannot be proxied** (signing keys, SSH, non-HTTP
   protocols) stay with a purpose-built guard like the a2a-guard, which
   signs on the agent's behalf. The GitHub App PEM moves into the sidecar,
   which mints installation tokens; the agent only ever sees short-lived
   tokens.

## Spike plan (time-boxed)

1. **Broker comparison:** Varlock proxy, Infisical Agent Vault, and a
   minimal VS-native sidecar, each in a Compose E2E with one agent. Score
   against: placeholder coverage for our real secrets (gateway key, Slack,
   GitHub), response scrubbing, egress allowlist, usage events we can
   ingest, ARM64 footprint on a Pi-class device, maturity/licensing,
   failure behaviour (broker down).
2. **Source plugin prototype:** the source interface with the registrar
   store and one external plugin (Bitwarden Secrets Manager via `bws`, as
   the user-requested case), resolving into a bundle.
3. **Rotation fan-out dry run:** one catalog secret granted to three agents;
   rotate; measure time until every agent's broker serves the new value.
4. **At-rest encryption:** design per-workspace encryption for stored
   bundle/secret values (key custody, rotation, backup restore).
5. **Write-up:** recommendation, chosen broker, migration path for
   existing bundles (values → catalog references), and console UI changes
   (Secrets page, grants, rotation, usage).

**Out of scope for the spike:** building the console Secrets page, changing
the bundle contract version, production rollout.

## Console impact (feeds the roadmap)

- New **Secrets** section: catalog, source, grants, last rotated, usage.
- Agent detail shows **which secrets the agent can use** (never values)
  and recent brokered use.
- **Rotate** fans out with a progress tracker (agents served new value /
  pending), like the new-agent bring-up tracker.
- Attention strip items: secret overdue for rotation, broker reporting
  denied requests, source plugin unreachable.

## Open questions

1. **Overlap rotation:** which providers support two live credentials
   (gateway keys yes; Slack and GitHub App keys need checking)?
2. **Broker failure mode:** fail closed (agent loses access) or serve the
   last value for a bounded window?
3. **Where the broker runs on Balena:** per-device sidecar (simple,
   per-host trust) or a master-device egress broker (central, but every
   call crosses the network)?
4. **At-rest key custody** for self-hosted installs: operator-held key,
   TPM, or the substrate's KMS?
