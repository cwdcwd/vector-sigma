#!/usr/bin/env bash
# scripts/verify-published.sh — the independent, ANONYMOUS proof that what
# the registry serves is what was scanned.
#
#   scripts/verify-published.sh <records-dir> <component> [<component> ...]
#
# For each component's promotion record (<records-dir>/promoted-<c>.json):
# every digest (index + both platforms) is re-read and its bytes must hash
# to that digest, and every tag must resolve to its recorded digest. Runs
# with an EMPTY regctl config (no credentials, ever), so the proof never
# depends on the writer's token. Checks every component, then fails if any
# check failed.
set -uo pipefail

records="${1:?usage: verify-published.sh <records-dir> <component>...}"
shift
[ $# -gt 0 ] || { echo "::error::verify-published: no components given" >&2; exit 1; }
command -v regctl >/dev/null || { echo "::error::verify-published: regctl not installed" >&2; exit 1; }

# Anonymous by construction: a fresh HOME means no regctl/docker credentials.
anon_home="$(mktemp -d)"
trap 'rm -rf "$anon_home"' EXIT
r() { HOME="$anon_home" regctl ${REGCTL_HOST:+--host "$REGCTL_HOST"} "$@"; }
sha256_of() { { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }

failed=0
for component in "$@"; do
  rec="${records}/promoted-${component}.json"
  if [ ! -f "$rec" ]; then
    echo "::error::verify-published: ${component}: no promotion record at ${rec}"
    failed=1
    continue
  fi
  # lines: "<ref-base> <tag> <digest>" for the index and each platform
  pairs="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const base = `${r.registry}/${r.repository}`;
    for (const e of [r.index, ...r.perPlatform]) console.log(base, e.tag, e.digest);
  ' "$rec")" || { echo "::error::verify-published: ${component}: unreadable record"; failed=1; continue; }
  ok=1
  while read -r base tag digest; do
    got="sha256:$(r manifest get --format raw-body "${base}@${digest}" | sha256_of)"
    if [ "$got" != "$digest" ]; then
      echo "::error::verify-published: ${component}: ${digest} read back as ${got}"
      ok=0
    fi
    resolved="$(r image digest "${base}:${tag}" 2>/dev/null || true)"
    if [ "$resolved" != "$digest" ]; then
      echo "::error::verify-published: ${component}: tag ${tag} resolves to '${resolved}', expected ${digest}"
      ok=0
    fi
  done <<< "$pairs"
  if [ "$ok" = 1 ]; then
    echo "verify-published: VERIFIED ${component} — index + both platforms re-read anonymously, byte-identical, tags resolve"
  else
    failed=1
  fi
done
exit "$failed"
