#!/usr/bin/env bash
# scripts/resolve-published.sh — build once, deploy many: bind a release to
# the EXACT digests main's verified build-images run scanned and published.
# Nothing is rebuilt, and nothing is read from a mutable tag.
#
#   scripts/resolve-published.sh <main-record.json> <component> <commit-sha> <out-record.json>
#
# <main-record.json> is the promotion record main's run wrote (the artifact
# promoted-<component> of that run): its digests are the ones main's content
# gate scanned, its E2E ran and its verify job re-read. They are the source of
# truth. The registry is then checked AGAINST them:
#   - the record names this component's repository and this commit
#   - each tag (<sha>, <sha>-amd64, <sha>-arm64) still resolves to the
#     RECORDED digest: a tag moved after main's run fails the release instead
#     of being followed to unscanned bytes (PR #99 review)
#   - the recorded index re-hashes to its digest and is EXACTLY the two
#     recorded platform manifests (scripts/check-index.mjs)
# The output record is main's record, unchanged. Anonymous (empty regctl
# config). Fails closed.
set -euo pipefail

die() { echo "::error::resolve-published: $*" >&2; exit 1; }
main_record="${1:?usage: resolve-published.sh <main-record.json> <component> <commit-sha> <out-record.json>}"
component="${2:?}"; sha="${3:?}"; record="${4:?}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "commit must be a full 40-char sha, got '$sha'"
[ -f "$main_record" ] || die "${component}: no promotion record from main's run at ${main_record}"
command -v regctl >/dev/null || die "regctl not installed (scripts/install-regctl.sh)"

anon_home="$(mktemp -d)"
trap 'rm -rf "$anon_home"' EXIT
r() { HOME="$anon_home" regctl ${REGCTL_HOST:+--host "$REGCTL_HOST"} "$@"; }
sha256_of() { { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }

# The recorded values, validated for shape and for THIS component + commit.
fields="$(node -e '
const [file, component, sha] = process.argv.slice(1);
const fail = (m) => { console.error(m); process.exit(1); };
let r;
try { r = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (e) { fail(`unreadable record: ${e.message}`); }
const dg = (d) => typeof d === "string" && /^sha256:[0-9a-f]{64}$/.test(d);
if (typeof r.repository !== "string" || !r.repository.endsWith(`/${component}`)) fail(`record repository ${r.repository} is not ${component}`);
if (typeof r.registry !== "string" || !r.registry) fail("record has no registry");
if (r.index?.tag !== sha) fail(`record is for ${r.index?.tag}, not ${sha}`);
const plat = (p) => (r.perPlatform || []).filter((x) => x?.platform === p);
const amd = plat("linux/amd64"), arm = plat("linux/arm64");
if ((r.perPlatform || []).length !== 2 || amd.length !== 1 || arm.length !== 1) fail("record must have exactly one linux/amd64 and one linux/arm64 entry");
for (const e of [r.index, amd[0], arm[0]]) if (!dg(e.digest)) fail(`malformed digest ${e.digest}`);
if (amd[0].tag !== `${sha}-amd64` || arm[0].tag !== `${sha}-arm64`) fail("record platform tags do not match the commit");
console.log(`${r.registry}/${r.repository} ${r.index.digest} ${amd[0].digest} ${arm[0].digest}`);
' "$main_record" "$component" "$sha" 2>"${anon_home}/why")" || die "${component}: main's record is not valid for this release: $(cat "${anon_home}/why")"
read -r repo index_digest amd64_digest arm64_digest <<< "$fields"

# Tags must still point at what main scanned — never followed.
for pair in "${sha}=${index_digest}" "${sha}-amd64=${amd64_digest}" "${sha}-arm64=${arm64_digest}"; do
  tag="${pair%%=*}"; want="${pair#*=}"
  got="$(r image digest "${repo}:${tag}" 2>/dev/null || true)"
  [ "$got" = "$want" ] || die "${component}: tag ${tag} resolves to '${got}', but main's verified run published ${want} — refusing to deploy bytes main did not scan"
done

# The recorded index: its bytes, its shape.
r manifest get --format raw-body "${repo}@${index_digest}" > "${anon_home}/index.json"
got="sha256:$(sha256_of < "${anon_home}/index.json")"
[ "$got" = "$index_digest" ] || die "${component}: ${index_digest} read back as ${got}"
node "$(dirname "$0")/check-index.mjs" "${anon_home}/index.json" "$amd64_digest" "$arm64_digest" 2>"${anon_home}/why" \
  || die "${component}: recorded index is not exactly its two platform manifests: $(cat "${anon_home}/why")"

mkdir -p "$(dirname "$record")"
cp "$main_record" "$record"
echo "resolve-published: ${component} @ ${sha} -> index ${index_digest} (main's verified record; tags unchanged)"
