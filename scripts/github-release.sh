#!/usr/bin/env bash
# scripts/github-release.sh — record a deployed release tag as a GitHub Release.
#
#   scripts/github-release.sh <owner/repo> <tag> <balena-release> <release-evidence.json> [asset...]
#
# Runs LAST in the release workflows, after the fleet advance succeeded, so a
# GitHub Release exists only for a tag that actually deployed. The notes are:
#   - the balena release the fleet now targets, the commit and the run
#   - the exact index + per-arch digests from the release-evidence ledger
#   - GitHub's generated changelog since the previous tag of the same line
#     (registrar-v* or devices-v*), so the two lines never interleave
# Assets (the ledger, the rendered compose, ...) are attached as-is.
# Idempotent: re-running a release updates the notes and replaces the assets.
# Needs GH_TOKEN with contents: write.
set -euo pipefail

repo="${1:?usage: github-release.sh <owner/repo> <tag> <balena-release> <release-evidence.json> [asset...]}"
tag="${2:?}"; balena_release="${3:?}"; ledger="${4:?}"; shift 4
[ -f "$ledger" ] || { echo "::error::github-release: no release-evidence ledger at ${ledger}" >&2; exit 1; }

line="${tag%-v*}"
[ "$line" != "$tag" ] || { echo "::error::github-release: tag ${tag} is not <line>-v<version>" >&2; exit 1; }

# Previous tag of the same line by version order (not date), for the changelog.
prev="$(gh api "repos/${repo}/tags" --paginate --jq '.[].name' \
  | grep -E "^${line}-v[0-9]" | sort -V | awk -v t="$tag" '$0 == t { print p; exit } { p = $0 }')"

notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT

{
  echo "Deployed to balena release \`${balena_release}\` (fleet advanced by the release workflow)."
  echo
  echo "- Commit: ${GITHUB_SERVER_URL:-https://github.com}/${repo}/commit/$(node -p 'require(process.argv[1]).commit' "$ledger")"
  [ -n "${GITHUB_RUN_ID:-}" ] && echo "- Release run: ${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${GITHUB_RUN_ID}"
  echo
  echo "### Images (main's verified build, deployed by digest)"
  echo
  node -e '
const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const short = (d) => "`" + d.slice(0, 19) + "`";
console.log("| Component | Index | linux/amd64 | linux/arm64 |");
console.log("|---|---|---|---|");
for (const [name, c] of Object.entries(l.components)) {
  const p = (plat) => (c.perPlatform.find((x) => x.platform === plat) || {}).digest || "?";
  console.log(`| ${name} | ${short(c.indexDigest)} | ${short(p("linux/amd64"))} | ${short(p("linux/arm64"))} |`);
}
' "$ledger"
  echo
  echo "Full digests: \`release-evidence.json\` (attached)."
  echo
  gh api "repos/${repo}/releases/generate-notes" -f tag_name="$tag" ${prev:+-f previous_tag_name="$prev"} --jq .body
} > "$notes"

if gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  gh release edit "$tag" -R "$repo" --title "$tag" --notes-file "$notes"
  [ "$#" -eq 0 ] || gh release upload "$tag" -R "$repo" --clobber "$@"
  echo "github-release: updated ${tag}"
else
  gh release create "$tag" -R "$repo" --verify-tag --title "$tag" --notes-file "$notes" "$@"
  echo "github-release: created ${tag}${prev:+ (changes since ${prev})}"
fi
