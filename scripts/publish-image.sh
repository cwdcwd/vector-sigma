#!/usr/bin/env bash
# scripts/publish-image.sh — publish ONE component's scanned bytes to the
# registry, digest for digest, and write its promotion record.
#
#   scripts/publish-image.sh \
#     --component <name> --registry ghcr.io --repository <owner>/<repo>/<name> \
#     --tag <commit-sha> --layouts <dir> --descriptors <dir> --index <file> \
#     --record <out.json>
#
# Inputs are what _images.yml already produced and validated: the scanned
# OCI layout tars (<dir>/<name>-{amd64,arm64}.tar), the content gate's scan
# descriptors (<dir>/<name>-{amd64,arm64}.descriptor.json, carrying each
# scanned image-manifest digest) and the index the gate assembled from ONLY
# those digests (<file>). Nothing is rebuilt.
#
# Order (no human-facing tag before every byte it names is proven):
#   1. copy each platform's scanned image manifest + blobs by DIGEST
#      (regctl image copy ocidir://…@<digest> → <repo>@<digest>)
#   2. push the gate-assembled index by DIGEST (its bytes, unmodified)
#   3. read every manifest back by digest; its bytes must hash to that digest
#   4. tag the platform manifests, then the index; each tag must resolve back
#   5. write the promotion record (the format render/ledger consume)
# Authentication is whatever `regctl registry login` configured (CI: the
# workflow's GITHUB_TOKEN, in the promote job only). Fails closed.
set -euo pipefail

die() { echo "::error::publish-image: $*" >&2; exit 1; }
need() { [ -n "${2:-}" ] || die "missing $1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --component) component="$2" ;;
    --registry) registry="$2" ;;
    --repository) repository="$2" ;;
    --tag) tag="$2" ;;
    --layouts) layouts="$2" ;;
    --descriptors) descriptors="$2" ;;
    --index) index_file="$2" ;;
    --record) record="$2" ;;
    *) die "unknown argument $1" ;;
  esac
  shift 2
done
for v in component registry repository tag layouts descriptors index_file record; do need "--${v/_file/}" "${!v:-}"; done
command -v regctl >/dev/null || die "regctl not installed (scripts/install-regctl.sh)"

repo="${registry}/${repository}"
sha256_of() { { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }
digest_from_descriptor() {
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).manifestDescriptor?.digest;if(!/^sha256:[0-9a-f]{64}$/.test(d||""))process.exit(1);console.log(d)' "$1" \
    || die "$1 carries no scanned manifest digest"
}

declare_digest() { eval "digest_$1=\"\$2\""; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

index_digest="sha256:$(sha256_of < "$index_file")"
for arch in amd64 arm64; do
  declare_digest "$arch" "$(digest_from_descriptor "${descriptors}/${component}-${arch}.descriptor.json")"
done

# The gate-assembled index must be EXACTLY the two scanned image manifests:
# two descriptors, one linux/amd64 + one linux/arm64, each pointing at that
# platform's scanned digest. Containment is not enough — an extra entry would
# make an unscanned image reachable through the published index.
node "$(dirname "$0")/check-index.mjs" "$index_file" "$digest_amd64" "$digest_arm64" 2>"${work}/index-check" \
  || die "index ${index_file} is not exactly the two scanned manifests: $(cat "${work}/index-check")"

# 1. Scanned bytes, by digest.
for arch in amd64 arm64; do
  eval d="\$digest_${arch}"
  mkdir -p "${work}/${arch}"
  tar -xf "${layouts}/${component}-${arch}.tar" -C "${work}/${arch}"
  regctl image copy "ocidir://${work}/${arch}@${d}" "${repo}@${d}" >/dev/null
  echo "publish-image: ${component} ${arch} ${d} copied"
done

# 2. The gate's index, unmodified, by digest.
regctl manifest put --content-type application/vnd.oci.image.index.v1+json "${repo}@${index_digest}" < "$index_file"
echo "publish-image: ${component} index ${index_digest} pushed"

# 3. Read back by digest: the stored bytes must hash to the address.
for d in "$digest_amd64" "$digest_arm64" "$index_digest"; do
  got="sha256:$(regctl manifest get --format raw-body "${repo}@${d}" | sha256_of)"
  [ "$got" = "$d" ] || die "${component}: ${d} read back as ${got}"
done

# 4. Tags last; each must resolve to the digest it was given.
tag_and_check() {
  regctl image copy "${repo}@$1" "${repo}:$2" >/dev/null
  got="$(regctl image digest "${repo}:$2")"
  [ "$got" = "$1" ] || die "${component}: tag $2 resolves to ${got}, expected $1"
}
tag_and_check "$digest_amd64" "${tag}-amd64"
tag_and_check "$digest_arm64" "${tag}-arm64"
tag_and_check "$index_digest" "${tag}"

# 5. The promotion record (consumed by render-release-compose + the ledger).
mkdir -p "$(dirname "$record")"
node -e '
const [repository, registry, tag, idx, amd, arm, out] = process.argv.slice(1);
const rec = { repository, registry, index: { tag, digest: idx }, perPlatform: [
  { platform: "linux/amd64", tag: `${tag}-amd64`, digest: amd },
  { platform: "linux/arm64", tag: `${tag}-arm64`, digest: arm },
] };
require("fs").writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
' "$repository" "$registry" "$tag" "$index_digest" "$digest_amd64" "$digest_arm64" "$record"
echo "publish-image: ${component} published and tagged ${tag} (index ${index_digest})"
