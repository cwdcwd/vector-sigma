# Exact-byte GHCR promotion runbook (fleet-ops-r3v)

How a Vector Sigma image gets from a scanned local OCI layout into GHCR, and
how the pipeline proves the bytes that landed are the bytes that were scanned.

This closes PR #61 review finding #4 (the promote job once ran a *second*
`docker buildx build --push` on a fresh runner, so nothing cryptographically
tied what was scanned to what was published) and finding #5 (remote
verification printed two digests side by side and never compared them).

## The invariant

**No release tag may exist unless every byte it advertises was re-read from
the registry and proven identical to the byte the content gate scanned.**

Two consequences, both enforced in code rather than in review:

- The promoter never rebuilds. It has no build context and no builder. It
  reads the OCI-layout tar that `stage-and-scan` already produced and scanned.
- Every write is a *content-addressed* write (by digest) followed by a
  read-back comparison, before any human-facing tag is applied.

## Pipeline (per component)

1. `stage-and-scan` — `docker buildx build --push=false --output type=oci`
   to a local tar, no registry auth, no cache. Runs `scripts/oci-gate-run.mjs
   scan` on the raw tar. Uploads **both** the descriptor and the layout tar
   (the tar is what gets published).
2. `e2e` — loads every component's scanned amd64 tar as
   `vs-e2e/<component>:ci` (`scripts/e2e-load-images.sh`) and runs
   `E2E_PREBUILT=1 test/e2e/e2e.sh --up` against them — the bytes about to be
   promoted, never a rebuild.
3. `all-components-gate` — aggregate, fail-closed: fails if any component or
   platform job, or the E2E, did not succeed; then, in the same job, builds
   and validates every component's local OCI index from only this run's
   scanned-and-passed child digests (one runner, not one per component).
4. `promote` (one job per component) — the only job with `packages:write`.
   Downloads the scanned layout tars and runs `scripts/ghcr-promote-run.mjs
   promote`.
5. `verify-remote` — ONE job, no `packages:write`, no credential. Runs
   `scripts/ghcr-promote-run.mjs verify` against every component's
   promotion record, and fails if any one fails. Kept separate from
   `promote` on purpose: the proof never runs where a write-capable token
   exists.
6. `scan` / `smoke` / `render` / `deploy` — unchanged in shape, now gated
   behind a real `verify-remote` instead of a dormant placeholder.

## What the promoter does, in order

STAGING (any failure here leaves the registry with **zero** tags):

1. Upload every blob the manifest references that HEAD does not already
   report (HEAD only decides whether to upload; it is never proof).
2. PUT each per-arch manifest **by digest** — a digest reference is
   content-addressed, so it can only ever point at those exact bytes, and no
   human-facing tag exists yet. This must precede the blob read-back: GHCR
   creates a package on its first manifest push, and blobs in a package that
   does not exist yet are not readable (a component's first-ever publish).
3. GET every blob back and compare byte-for-byte + re-hash; a 404 after a
   HEAD-skipped upload re-uploads once, a 404 after upload retries with
   backoff, and a blob that never becomes readable fails the promotion
   (`blob_unreadable`, no tags). Then GET the manifest back and compare.
4. Assemble the multi-arch index from only the scanned-and-passed child
   descriptors, PUT it **by digest**, GET it back, compare.

TAGGING (only reachable once every staging verification passed):

5. PUT each per-arch tag, read it back, require it to resolve to the staged
   digest.
6. PUT the index tag, read it back, require it to resolve to the index digest.

A tagging failure stops before the index tag is applied — a partially verified
release is never advertised as one coherent multi-arch release.

## What verification trusts

`verifyRemote` recomputes SHA-256 over the served bytes. It does **not** trust
the registry's `Docker-Content-Digest` header, and it does not trust the
promoter's own promote-time return value. It re-reads the published index and
every child **by digest** and fails closed on any difference.

Failure codes: `index_mismatch`, `child_missing`, `child_mismatch`,
`malformed_index`, `tag_unresolvable`.

## Credential handling

There is no `docker/login-action` anywhere in the promote path. The
`GITHUB_TOKEN` reaches the client only as the value of a named environment
variable (`--token-env`), is exchanged for a scoped bearer token, and is sent
only in an `Authorization` header — never in a URL, a log line, or an error
message. Tests pin all three of those properties.

## The owner switch

Live GHCR writing is gated on the repo Actions variable
**`VS_GHCR_PUBLISH_ENABLED`**. It is **not set** in this repo, so the
`promote` job's `if:` is false and `promote`/`verify-remote` — and every job
that `needs:` them — skip. A green PR pipeline therefore cannot by itself
become a live GHCR write on push to main; enabling publishing is a separate,
explicit owner action:

```
gh variable set VS_GHCR_PUBLISH_ENABLED --body true \
  --repo cwdcwd/vector-sigma
```

The release workflows (`release-registrar.yml`, `release-devices.yml`) only
trigger on a `registrar-v*` / `devices-v*` tag push, which is already an
explicit human act, but they carry the same variable gate.

## Safe first live probe: component-scoped dispatch

`build-images.yml` exposes a required `workflow_dispatch` choice named
`component`. Select one component (for example, `registrar`) for the first
live probe; `all` is the default and is intentionally explicit. The selector
changes only the `promote` and `verify-remote` matrices. The entire
`images.json` build/scan/index/E2E graph and `all-components-gate` still run
(`.github/workflows/_images.yml`), so no
component can publish before the full repository validation succeeds. A
single-component dispatch therefore writes only that component's package while
still enforcing the complete scan gate.

The selector is not authorization: keep `VS_GHCR_PUBLISH_ENABLED` unset unless
the owner explicitly approves a live GHCR write. With the switch unset, manual
dispatch remains validation-only and both publish jobs skip.

## Operating it

Promote (as CI does; omit `--scheme` in production — it is `https`):

```
node scripts/ghcr-promote-run.mjs promote \
  --registry ghcr.io \
  --repository cwdcwd/vector-sigma/registrar \
  --tag "$GITHUB_SHA" \
  --layout "linux/amd64=$TMP/layouts/registrar-amd64.tar" \
  --layout "linux/arm64=$TMP/layouts/registrar-arm64.tar" \
  --token-env GHCR_TOKEN --actor "$GITHUB_ACTOR" \
  --record "$TMP/promoted-registrar.json"
```

Verify (no credential needed for a public package — the verifier fetches an anonymous pull token, as GHCR requires):

```
node scripts/ghcr-promote-run.mjs verify \
  --registry ghcr.io \
  --record "$TMP/promoted-registrar.json"
```

Both exit non-zero with a `::error::` line on any failure.

## Rollback

A failed promotion never published a tag, so there is nothing to roll back —
re-run the job. If a release tag was applied and then found bad, cut a fresh
tag from the known-good commit; **never** move an existing tag (see
`balena-architecture.md`).

## What is NOT proven by this lane

Everything above is proven against unit-level fakes, a real `node:http`
registry socket, and the real script invoked as a child process. It has **not**
been run against live GHCR: GHCR's own media-type acceptance, `Location`
handling and auth quirks are still unconfirmed by a live write. The first real
run should be a manual `workflow_dispatch` on a scratch component, and the
promotion record's digests should be compared by hand before any tag-cut
release is allowed to run.
