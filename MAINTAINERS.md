# Maintainers

## Vector Sigma lane — vectorsigma-primus[bot]

**primus** (GitHub identity: `vectorsigma-primus[bot]`, GitHub App
**VectorSigma-Primus**, app id 5137374) is the **maintainer** of the
Vector Sigma lane — the VS fleet's coordinator agent (fleet-ops-f57.14),
self-hosted on the master device and operating this repo's lane through
the fleet's A2A/queue discipline.

This is a **documented designation, not a GitHub-enforced role**: a bot
cannot hold a GitHub maintainer/admin role, and GitHub Apps do not
resolve as code owners (`.github/CODEOWNERS` marks primus's entry
advisory-only for exactly this reason). The designation is honest
framing for a real operational fact — primus curates the VS work queue,
files and works lane beads, and drives this repo's releases as the VS
coordinator.

**Contributor** is already true in the plain GitHub sense: the
VectorSigma-Primus App holds write access to this repository (PRs,
commits, reviews-at-head) — nothing further is needed for that grant.

## Device agents — per-agent GitHub Apps (advisory registry)

Every VS device agent that needs to write to this repository gets its
OWN GitHub App, minted by the repo owner — one App per agent keeps the
actor distinguishable from humans and from every other agent, which is
what branch protection needs to separate agent work from human
approval. The same mechanics apply to primus (above). The naming
convention: App **VectorSigma-\<AgentName\>** → login
`vectorsigma-<agent-slug>[bot]`.

The PEM private key never lives in this repo, an image layer, or a
compose file: the registrar console's structured bundle editor carries
it per device row (write-only field `github_app_pem`, delivered to
`config/github-app.pem` on the agent's host, mode 0600), alongside the
`GH_APP_ID` / `GH_APP_SLUG` env lines. The `05-vs-github-identity`
boot hook derives git's credential wiring from the bundle on every
boot; the `vs-github-identity` wrapper mints short-lived installation
tokens on demand. See [docs/vs-github.md](docs/vs-github.md) for the
full contract (auth path, PR lifecycle, pitfalls, and the owner's
minting click-path).

| Agent | GitHub identity | GitHub App | App id |
|---|---|---|---|
| primus | `vectorsigma-primus[bot]` | VectorSigma-Primus | 5137374 |

*(Registry rows are added by PR when the owner mints a new agent's App
— the PR that documents a minted App lands after the mint, never
before; the App id is public record, the PEM never enters the repo.)*

These are **documented designations, not GitHub-enforced roles** — the
same advisory-only posture as primus's entry above.

## Humans

The repo owner retains final authority over everything
documented above; primus's curator role operates under the
owner-exception classes (credential writes, secret handling, package
installs, and mutations of its own config or SOUL are never agent
self-service).