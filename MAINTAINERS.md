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

## Humans

The repo owner retains final authority over everything
documented above; primus's curator role operates under the
owner-exception classes (credential writes, secret handling, package
installs, and mutations of its own config or SOUL are never agent
self-service).