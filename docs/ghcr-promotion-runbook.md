# Exact-byte GHCR promotion runbook (fleet-ops-r3v)

> New to this? Start with [image-pipeline.md](image-pipeline.md), the plain-language overview.

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
   Downloads the scanned layout tars, scan descriptors and gate-assembled
   index, and runs `scripts/publish-image.sh` (the pinned `regctl`).
5. `verify-remote` — ONE job, no `packages:write`, no credential. Runs
   `scripts/verify-published.sh` against every component's promotion
   record, and fails if any one fails. Kept separate from
   `promote` on purpose: the proof never runs where a write-capable token
   exists.
6. `scan` / `smoke` / `render` / `deploy` — unchanged in shape, now gated
   behind a real `verify-remote` instead of a dormant placeholder.

## What publishing does, in order

`scripts/publish-image.sh`, per component. It uses **`regctl`**
(regclient.org), installed by `scripts/install-regctl.sh` at a pinned version
and verified against a pinned SHA-256 before it runs. There is no in-repo
registry client.

STAGING (any failure here leaves the registry with **zero** tags):

1. Copy each platform's **scanned image manifest + blobs by digest** straight
   from the scanned OCI layout (`regctl image copy ocidir://…@<digest>
   <repo>@<digest>`). The digest comes from the content gate's scan
   descriptor, so only the scanned manifest can be copied, and a digest
   reference cannot point at anything else.
2. Push the **index the gate assembled** (`all-components-gate`), its bytes
   unmodified, **by digest**. The script first checks it names exactly the two
   scanned digests.
3. Read every manifest back **by digest**; its bytes must re-hash to that
   digest.

TAGGING (only reachable once every staging check passed):

4. Tag each platform manifest, then the index; each tag is read back and must
   resolve to the digest it was given.
5. Write the promotion record (`promoted-<component>.json`) — the same format
   the release tail (`render-release-compose.mjs`, `release-ledger.mjs`)
   consumes.

regctl pushes a manifest only after its blobs, so a component's first-ever
publish (a GHCR package that does not exist yet) needs nothing special — the
blob-before-manifest read-back trap the old in-repo client fell into
(2026-10-20) cannot occur.

## What verification trusts

`scripts/verify-published.sh` runs in its own job with no write scope and an
**empty regctl config** (a fresh `HOME`), so it can only ever read
anonymously. For each component it re-reads the index and both platform
manifests **by digest** and recomputes SHA-256 over the served bytes (it does
not trust the registry's digest header), and checks every tag resolves to its
recorded digest. It checks every component, then fails if any check failed.

## Credential handling

The `GITHUB_TOKEN` appears in exactly one step of the promote job: it is piped
to `regctl registry login --pass-stdin`, so it is never on a command line, in a
URL or in a log line. The verify job never logs in. Tests pin both properties
(`promote-structural-gate.test.ts`).

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

Install the pinned regctl, log in, publish (as CI does):

```
scripts/install-regctl.sh "$HOME/bin"
printf '%s' "$GHCR_TOKEN" | regctl registry login ghcr.io -u "$GITHUB_ACTOR" --pass-stdin
scripts/publish-image.sh \
  --component registrar --registry ghcr.io \
  --repository cwdcwd/vector-sigma/registrar --tag "$GITHUB_SHA" \
  --layouts "$TMP/layouts" --descriptors "$TMP/descriptors" \
  --index "$TMP/indexes/registrar-index.json" \
  --record "$TMP/records/promoted-registrar.json"
```

Verify, anonymously:

```
scripts/verify-published.sh "$TMP/records" registrar
```

Both exit non-zero with a `::error::` line on any failure.

## Rollback

A failed promotion never published a tag, so there is nothing to roll back —
re-run the job. If a release tag was applied and then found bad, cut a fresh
tag from the known-good commit; **never** move an existing tag (see
`balena-architecture.md`).

## What has been proven live

- 2026-10-19: the first GHCR writes (`registrar`, then 8 of 9 components) and
  the anonymous verify (after the token fix, #93).
- 2026-10-20: the regctl publish + verify scripts run end to end against a
  local registry with the real scanned `tailscale-devices` layouts: digests
  preserved, tags resolve, a re-pointed tag and a missing record both fail.
