# Plan: remove Vector Sigma deployment details from container images

**Status:** Proposed for review only. This document does not authorize a deployment, package deletion, credential rotation, or a release tag.

## Goal

Stop publishing reusable images that disclose Vector Sigma's live deployment topology. Correct the image contents and runtime configuration first; then replace the affected deployed images and remove exposed GHCR versions where GitHub permits. Assume an image digest may already have been copied: deleting a registry version cannot recall pulled or cached copies.

The owner has authorized accepting a full Vector Sigma redeploy or rebuild if the reviewed implementation requires it. That makes a clean rebuild an option, not a reason to discard persistent data without a separate inventory and recovery plan.

## What is in scope

The repo's image workflow builds eight components for amd64 and arm64 and publishes on pushes to `main`; release workflows later use those images to build balena releases ([build workflow](../.github/workflows/build-images.yml), [balena architecture](balena-architecture.md)). The registrar and device images explicitly copy vendored operational documentation into their layers ([registrar Dockerfile](../balena/registrar/Dockerfile.hermes), [device Dockerfile](../balena/devices/Dockerfile.agent-hermes)). The master Tailscale image copies a serve configuration into its layer ([serve config](../balena/registrar/serve-config.json), [Dockerfile](../balena/registrar/Dockerfile.tailscale)). Compose also contains literal `extra_hosts` mappings for the tailnet master and enrolled device ([registrar compose](../balena/registrar/docker-compose.yml), [devices compose](../balena/devices/docker-compose.yml)).

Before choosing deletion targets, inventory the live GHCR package namespaces, versions/tags/digests, visibility, download counts, and consumers. Do not infer package ownership or public status from workflow comments. Confirm the images and their current layers with anonymous pulls and registry metadata; preserve the inventory as review evidence. Scan every built image, not just the two images already known to copy docs.

## Data classification and target state

1. **Never put secrets or identity in an image.** This includes registrar/database passwords, gateway keys, Tailscale auth keys/state, registrar keys, A2A/GitHub App credentials, and device identity bundles. Rotate any credential if a layer scan finds one; registry deletion is not remediation for a leaked credential.
2. **Remove live deployment-specific values from reusable layers.** Examples include tailnet DNS names and addresses, device tailnet IPs, live LAN endpoints, and operational documents that map the running fleet. Current source examples include the MagicDNS name/address in the master serve config and Compose host pins, and operational maps copied under `/opt/vs/docs`.
3. **Keep only values proven to be stable application contracts.** Compose service names used solely on an internal Compose network, ports, generic service roles, upstream version pins, and queue protocol semantics may remain if they are genuinely portable. The VS queue's canonical project ID is an identity contract for its shared database, not a credential; do not silently rotate or regenerate it. Prefer supplying it at boot from an explicit runtime contract if feasible, with fail-closed validation. Treat any identifier as deployment-specific until its role and portability are documented.
4. **Docs:** images may carry generic operator/user documentation, but not a live network map, private URLs, IPs, queue-host coordinates, or real deployment identifiers. Keep the authoritative operational runbooks in the private/source repository. If runtime docs are needed on devices, provide sanitized generic docs or a separately access-controlled delivery mechanism.

## Runtime configuration design to validate

Balena's Supervisor Compose dialect is a hard constraint: this repo documents no `${VAR}` substitution and specifically notes no variable path for `extra_hosts` in [devices compose](../balena/devices/docker-compose.yml). Do not claim a dashboard variable can directly replace an `extra_hosts` literal.

- **Tailscale serve config:** replace the master's baked live FQDN with startup-generated configuration from a validated balena runtime variable (or supported per-device Tailscale data). Preserve the pinned upstream entrypoint/containerboot behavior. Reject missing, malformed, or unexpected hostnames before starting the service. Test generated JSON, certificate/serve application, all three master routes, and devices' per-node `${TS_CERT_DOMAIN}` behavior on the pinned version.
- **Name-to-address reachability:** first test whether the existing runtime DNS path can resolve the tailnet name from every consumer container, including cold boot and after Tailscale reconnect. The runbook reports that the current DNS chain cannot resolve `ts.net`, which is why static hosts pins were introduced ([tailscale runbook](tailscale-runbook.md)). If runtime DNS fails, prototype and canary a runtime resolver/host-map mechanism compatible with balenaOS and Supervisor. Keep a per-deployment Compose pin only as a documented fallback if no tested runtime mechanism works; never substitute a made-up env-var syntax.
- **Queue join:** generate the config-only Beads join files from explicit runtime values where possible, preserve the canonical project ID and fail closed on mismatch. Never run `bd init` as part of an image build or startup. Keep queue behavior and client-version pins intact.
- **Build contexts and vendored docs:** remove or sanitize image COPY inputs and update vendored-drift tests/sync scripts so root docs cannot silently reintroduce live values. Ensure source context, build args, labels, and build logs do not leak them either.

## Execution sequence and gates

### A. Inventory and baseline

- Enumerate exact GHCR packages, all affected versions and multi-arch child digests, public accessibility, download counts, retention/restore window, and consumers. Save package metadata and image digests in the PR or a linked restricted evidence record; don't publish credentials or unnecessary live values in the PR.
- Pull each relevant image by digest without authentication and inspect image config, every filesystem layer (including deleted files retained in lower layers), labels, build metadata, and embedded docs. Produce a baseline scan with exact file/layer locations and classify each finding as secret, deployment-specific, or stable contract.
- Confirm the active balena release, pinned release policy, devices, named volumes, backup/recovery paths, and whether any outside consumer depends on GHCR. No deletion or deployment during this phase.

### B. Implement and prove corrected images

- Change the repository build inputs and runtime configuration according to the validated design above. Add regression tests that fail if known live topology patterns or credential-shaped values enter published image layers; keep a reviewed allowlist for unavoidable stable contracts.
- Build every component/platform locally or in PR CI without publishing. Scan final image layers and build metadata; compare against the baseline. Require zero secrets and zero disallowed live topology in every image.
- Exercise runtime-variable validation, Tailscale serve and name resolution, registrar/device enrollment, queue identity, health checks, and upgrade behavior on a disposable/canary deployment before any fleet-wide release.

### C. Deploy replacement safely

- Build/publish corrected images under new immutable digests; verify registry contents and anonymous pull behavior. Do not overwrite or delete the old versions yet.
- Prefer an in-place balena release/canary if tests show named volumes remain intact and runtime changes work. Verify `pgdata`, `doltdata`, `agent-data`, `ts-state`, and `primus-data` remain present and readable. A full reflash/fleet recreation, fleet move, volume purge, or identity reset requires explicit per-volume backup/restore and re-enrollment steps—even though a fresh deployment is acceptable to the owner.
- Verify all services become healthy, TLS/serve routes work, devices can register and reach the master, the queue project ID still matches, credentials/bundles remain delivered by their intended runtime path, and rollback to the prior balena release is understood. Record exact release IDs, image digests, and evidence.

### D. Remove exposed GHCR versions

- Only after corrected images are deployed and verified, identify each exact old public package version/digest again and check GitHub's current deletion rules and download threshold. GitHub documents restrictions for public package versions with more than 5,000 downloads and a 30-day restore window for eligible deletions; package-wide deletion may have different consequences. If deletion is blocked or ambiguous, stop and use the documented GitHub Support route rather than broadening permissions or changing visibility.
- Delete only the enumerated affected versions (or packages if explicitly justified), verify each deletion from a fresh registry read, and check that corrected digests remain available. Do not represent deletion as erasure from caches or downstream copies.
- If deletion was premature or disrupts consumers, use the documented restore window where eligible and restore the corrected deployment path; if a secret was exposed, rotate it regardless of package restore/deletion.

## Acceptance criteria

- Exact package/version/digest inventory and affected-consumer list reviewed.
- Every release image and architecture passes a layer-level scan: zero credentials and zero disallowed live deployment details, including in lower layers and build metadata.
- Runtime config is validated fail-closed; no unsupported Compose interpolation is relied upon; tailnet reachability, TLS identity, queue contract and device enrollment pass canary tests.
- Persistent-data disposition and rollback are documented and tested before any destructive redeploy.
- Corrected images are deployed and verified before old public versions are removed.
- Any GHCR deletion is limited to reviewed targets, subject to GitHub's actual eligibility, and is verified afterward. Report plainly that already-pulled copies cannot be recalled.

## Out of scope for this plan PR

This is a reviewable sequence, not authorization to execute it. It does not change visibility, delete packages, rotate credentials, alter balena fleets/devices/volumes, publish images, create release tags, or deploy. Those actions follow only after implementation review and the relevant release approvals.

## References

- [GitHub: deleting and restoring packages](https://docs.github.com/packages/learn-github-packages/deleting-and-restoring-a-package)
- [GitHub REST API: packages](https://docs.github.com/en/rest/packages/packages)
- [balena Supervisor Compose reference](https://docs.balena.io/reference/supervisor/docker-compose)
