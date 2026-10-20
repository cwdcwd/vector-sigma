#!/usr/bin/env bash
# scripts/resolve-published.sh — build once, deploy many: turn the images
# MAIN already built, scanned, E2E'd, published and verified for a commit
# into the promotion record a release consumes. Nothing is rebuilt.
#
#   scripts/resolve-published.sh <registry> <repository> <commit-sha> <out-record.json>
#
# Reads main's tags for the commit (<sha>, <sha>-amd64, <sha>-arm64) and
# resolves each to its digest, then checks the index is EXACTLY those two
# platform manifests (scripts/check-index.mjs — the same rule publish
# enforces) and that its bytes hash to its digest. Writes the record in the
# format render-release-compose / release-ledger consume; the release's own
# verify job then re-reads every digest anonymously (verify-published.sh).
# Anonymous (empty regctl config). Fails closed.
set -euo pipefail

die() { echo "::error::resolve-published: $*" >&2; exit 1; }
registry="${1:?usage: resolve-published.sh <registry> <repository> <commit-sha> <out-record.json>}"
repository="${2:?}"; sha="${3:?}"; record="${4:?}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "commit must be a full 40-char sha, got '$sha'"
command -v regctl >/dev/null || die "regctl not installed (scripts/install-regctl.sh)"

anon_home="$(mktemp -d)"
trap 'rm -rf "$anon_home"' EXIT
r() { HOME="$anon_home" regctl ${REGCTL_HOST:+--host "$REGCTL_HOST"} "$@"; }
sha256_of() { { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }
repo="${registry}/${repository}"

resolve() { r image digest "${repo}:$1" 2>/dev/null || die "${repository}:$1 not found — has main's build-images run for ${sha} published this component?"; }
index_digest="$(resolve "$sha")"
amd64_digest="$(resolve "${sha}-amd64")"
arm64_digest="$(resolve "${sha}-arm64")"

r manifest get --format raw-body "${repo}@${index_digest}" > "${anon_home}/index.json"
got="sha256:$(sha256_of < "${anon_home}/index.json")"
[ "$got" = "$index_digest" ] || die "${repository}@${index_digest} read back as ${got}"
node "$(dirname "$0")/check-index.mjs" "${anon_home}/index.json" "$amd64_digest" "$arm64_digest" 2>"${anon_home}/why" \
  || die "${repository}:${sha} index is not exactly its two platform manifests: $(cat "${anon_home}/why")"

mkdir -p "$(dirname "$record")"
node -e '
const [repository, registry, tag, idx, amd, arm, out] = process.argv.slice(1);
const rec = { repository, registry, index: { tag, digest: idx }, perPlatform: [
  { platform: "linux/amd64", tag: `${tag}-amd64`, digest: amd },
  { platform: "linux/arm64", tag: `${tag}-arm64`, digest: arm },
] };
require("fs").writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
' "$repository" "$registry" "$sha" "$index_digest" "$amd64_digest" "$arm64_digest" "$record"
echo "resolve-published: ${repository} @ ${sha} -> index ${index_digest} (reusing main's verified images)"
