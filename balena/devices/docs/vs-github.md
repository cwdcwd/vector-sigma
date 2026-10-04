# VS GitHub — how a VS agent writes to this repo

You are a Vector Sigma fleet agent. When your work needs to change this
repository (code, docs, vendored trees), you do it **as your own GitHub
App identity** — every commit, PR, and review you author shows up as
`<your-app-slug>[bot]`, distinguishable from the owner, from humans, and
from every other agent. This document is the contract for that identity:
how it reaches you, how writes authenticate, the PR lifecycle, and the
pitfalls. It is baked into your image at `/opt/vs/docs/vs-github.md` and
lives in the vector-sigma repo at `docs/vs-github.md`.

## Your identity is a GitHub App — one per agent

- One App **per agent** (not per device, not one shared App for the
  fleet): branch protection can only separate agent work from human
  approval if the actor is distinguishable, and one App per agent keeps
  every agent's writes attributable.
- The App is **minted by the repo owner** — an owner-only console step.
  No agent ever creates, renames, or deletes a GitHub App.
- The App's private key (a PEM file) is **host-held, never baked**: it
  arrives in your registrar bundle and lives only on your host's data
  volume, mode 0600. It is never in an image layer, a compose file, a
  commit, a chat message, or a log. If you ever see a PEM body printed
  anywhere, treat it as an incident — report it, never propagate it.

## What your bundle carries

The registrar console's structured bundle editor holds, per device row:

| Bundle field | Lands at | Nature |
|---|---|---|
| `github_app_pem` | `$HERMES_HOME/config/github-app.pem` (0600) | secret — write-only in the console; blank keeps the existing value |
| `extra_env`: `GH_APP_ID` | `$HERMES_HOME/.env` | non-secret — your App's numeric id |
| `extra_env`: `GH_APP_SLUG` | `$HERMES_HOME/.env` | non-secret — your App's slug (the `[bot]` login without the suffix) |

All three must be present for GitHub identity to wire up. If your PEM
field is empty, or `GH_APP_ID`/`GH_APP_SLUG` are missing, ask the owner
(through the lane) — never mint or fake any of them yourself.

## The wiring is automatic

The `05-vs-github-identity` boot hook (runs on every container start,
after the A2A wiring hook) reads your bundle and derives the `.env`
lines that make **plain `git` authenticate as your App**:

- `GH_APP_PEM_PATH` — where the wrapper finds your PEM (the bundle copy).
- `GIT_CONFIG_COUNT=3` + `GIT_CONFIG_KEY_0..2`/`GIT_CONFIG_VALUE_0..2` —
  git's env-configuration channel: a credential helper that mints
  short-lived installation tokens on demand, plus `user.name` =
  `<slug>[bot]` and `user.email` = `<id>+<slug>[bot]@users.noreply.github.com`
  so your commits are attributed correctly.

Consequences, all without any local git config of your own:

- `git clone` / `git pull` / `git push` over `https://github.com/...`
  just work — the helper answers every credential ask.
- Tokens are minted per push (they live one hour); git never caches one.
- If your bundle later loses its PEM (or the id/slug lines), the hook
  **removes** the whole managed block on the next boot — a dropped
  identity never leaves a stale credential path behind.

## The wrapper: `vs-github-identity`

Everything git doesn't cover goes through the wrapper at
`/usr/local/bin/vs-github-identity` (zero-dependency Python; signs with
PyJWT when present, else falls back to `openssl`; mints installation
tokens from your PEM on demand):

```sh
vs-github-identity whoami        # identity check: app, bot login, installation, accessible repos
vs-github-identity token         # mint a fresh installation token (stdout; 1h TTL)
vs-github-identity api METHOD /repos/<owner>/<repo>/... '["json", "body"]'
```

`whoami` is your preflight before any write session — it proves the PEM,
the id, and the installation all line up without printing any secret.

## The PR lifecycle

Every change to this repo, however small, goes through a pull request —
the default branch is protected and rejects direct pushes by design
(`GH013: changes must be made through a pull request`).

1. **Branch**: `git checkout -b <agent-slug>/<lane-slug>` off the
   current `main`.
2. **Commit + push**: normal git; commits land as `<slug>[bot]`.
3. **PR**: open it against `main` (via `vs-github-identity api POST
   /repos/<owner>/<repo>/pulls '{"title":…,"head":…,"base":"main"}'`
   or your normal PR tooling).
4. **Peer review**: a peer VS agent or the owner reviews at the PR
   head. CI must be green.
5. **Merge**: the submitter merges at the reviewed head (re-verify the
   head is unchanged, the merge is clean, and checks are green in the
   same operation).

**Release tags are owner-only** (`registrar-v*`, `devices-v*`). A lane's
acceptance ends at the merged PR; tagging is the owner's one-step action
on top of a green main, never an agent step.

## Where identity designations live

- **MAINTAINERS.md** — the advisory registry: one entry per minted App
  (agent, App name, app id). Bots cannot hold GitHub-enforced maintainer
  roles; the registry documents real operational designations.
- **`.github/CODEOWNERS`** — advisory-only lines mirroring the registry.
  GitHub Apps do not resolve as code owners, so these are documentation
  for humans, never a review gate (the branch ruleset's
  `require_code_owner_review` stays off for exactly this reason).
- **The registrar console** — the live bundle: the PEM field and the
  `GH_APP_ID`/`GH_APP_SLUG` env lines are the source of truth for what
  your host holds.

## Pitfalls (learned the hard way — honor them)

- **Stale installation token**: tokens live ~1h. A git or API call that
  401s after working earlier is usually a stale token — re-run (every
  wrapper invocation re-checks the clock and re-mints) before
  diagnosing a broken credential.
- **Workflow-file pushes**: if your change touches
  `.github/workflows/`, your App needs the *Workflows: Read and write*
  permission — without it, GitHub rejects the whole push
  (`refusing to allow a GitHub App to create or update workflow …`).
  Get the grant first (owner step), or split the PR so workflow files
  ride a separate, explicitly-granted change.
- **A fresh-mint 403 is a scope gap, not a token problem**: if a
  freshly-minted token still gets 403 on one specific operation, the
  App's permission set is missing that scope. Stop retrying; route the
  ask to the owner (grant) instead.
- **Never print secrets**: no PEM bodies, no installation tokens — not
  in logs, threads, PR bodies, or docs. `whoami` output is the safe
  evidence shape (names and ids only).
- **The PEM is not the token**: the PEM (long-lived, host-held, from the
  bundle) signs a JWT; the JWT mints the installation token
  (short-lived, per-use). Never confuse custody rules: PEM never leaves
  the host; tokens are never stored.

## Owner appendix — minting a per-agent App (the exact click-path)

Owner-only steps, once per agent, when a device agent first needs repo
write access:

1. GitHub (owner account) → **Settings → Developer settings → GitHub
   Apps → New GitHub App**.
2. Fields: **GitHub App name** `VectorSigma-<AgentName>`; homepage URL
   this repo's URL; **Where can this GitHub App be installed**:
   *Only on this account*. Create.
3. **Permissions & events → Repository permissions**: *Contents* — Read
   and write; *Pull requests* — Read and write; *Metadata* — Read-only
   (auto-required). Add *Workflows* — Read and write only if that agent
   will push workflow-file changes (see the pitfall above).
4. Note the **App ID** (numeric) and the **slug** (the account-style
   login, e.g. `vectorsigma-<agent-slug>`).
5. **Private keys → Generate a private key** — the PEM downloads. This
   is the only time the PEM body exists outside your custody chain.
6. **Install App** → install on the account that owns this repository,
   granting access to **this repository only**.
7. Deliver to the agent: registrar admin console → the device row →
   structured bundle editor → paste the PEM into `github_app_pem`, add
   `GH_APP_ID` / `GH_APP_SLUG` to `extra_env`, save. The rotation
   watcher delivers on its next poll; the device applies on its next
   container recreate.
8. Record the designation in `MAINTAINERS.md` (registry row) and the
   advisory line in `.github/CODEOWNERS` via a normal PR.
9. Evidence standard for the delivery: registrar console audit rows or
   a masked key-prefix check (e.g. `head -c 40 … | sha256sum`-style,
   or "the console row exists for field X") — **values never**.