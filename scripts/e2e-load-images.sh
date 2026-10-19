#!/usr/bin/env bash
# scripts/e2e-load-images.sh — import the scanned amd64 OCI layouts into the
# local docker daemon as vs-e2e/<component>:ci, the tags deploy/compose.e2e.yaml
# runs (E2E_PREBUILT=1 deploy/e2e.sh --up). E2E then exercises the exact
# bytes the content gate scanned and the promote job publishes.
#
# Usage: scripts/e2e-load-images.sh <dir holding <component>-amd64.tar>
#
# Import is `skopeo copy oci-archive: docker-daemon:` — NOT `docker load`.
# The tars are buildx type=oci layouts (index.json + blobs/, no legacy
# manifest.json); `docker load` reads those only on the containerd image
# store, and GitHub's hosted runners use the classic store, where it fails
# with "open .../blobs/json: no such file or directory". skopeo works on
# either store and carries the same config + layers. The imported image's
# layer diff IDs are checked against the layout's own config (identical on
# either store), so E2E provably runs the layers the gate scanned; the image
# ID is echoed per component as the evidence line. skopeo ships on the
# ubuntu-24.04 runner image.
#
# Loads exactly the images.json components the E2E compose runs (read from
# `docker compose config --images`; the seed harness is test tooling and
# always builds). Fail-loud: a missing tar, a failed import, or layers that
# differ from the layout's config exits non-zero. Each tar is
# deleted once imported — the Hermes images are ~4 GB unpacked and the
# runner's disk is finite.
set -euo pipefail

dir="${1:?usage: e2e-load-images.sh <layouts dir>}"
command -v skopeo >/dev/null || { echo "e2e-load-images: skopeo not found (apt-get install skopeo)" >&2; exit 1; }
catalog=" $(node scripts/image-catalog.mjs components | tr -d '[]"' | tr ',' ' ') "
needed="$(docker compose --env-file deploy/.env.e2e -f deploy/compose.yaml -f deploy/compose.e2e.yaml \
  config --images | sed -n 's#^vs-e2e/\(.*\):ci$#\1#p' | sort -u)"

for component in $needed; do
  [ "$component" = "seed" ] && continue
  case "$catalog" in
    *" $component "*) ;;
    *) echo "e2e-load-images: compose runs vs-e2e/$component:ci but images.json has no '$component'" >&2; exit 1 ;;
  esac
  tar="$dir/$component-amd64.tar"
  [ -f "$tar" ] || { echo "e2e-load-images: missing $tar" >&2; exit 1; }
  # The layout's config lists its layer diff IDs; the imported image must
  # report the same list (store-agnostic proof these are the scanned bytes).
  want="$(node scripts/oci-layout-diffids.mjs "$tar")"
  skopeo copy --quiet "oci-archive:$tar" "docker-daemon:vs-e2e/$component:ci"
  got="$(docker image inspect -f '{{json .RootFS.Layers}}' "vs-e2e/$component:ci")"
  [ "$got" = "$want" ] || { echo "e2e-load-images: vs-e2e/$component:ci layers $got != layout $want" >&2; exit 1; }
  rm -f "$tar"
  echo "e2e-load-images: vs-e2e/$component:ci <- $component-amd64.tar ($(docker image inspect -f '{{.Id}}' "vs-e2e/$component:ci"))"
done
