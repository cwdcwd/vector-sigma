#!/usr/bin/env bash
# scripts/e2e-load-images.sh — load the scanned amd64 OCI layouts into the
# local docker daemon as vs-e2e/<component>:ci, the tags deploy/compose.e2e.yaml
# runs (E2E_PREBUILT=1 deploy/e2e.sh --up). E2E then exercises the exact
# bytes the content gate scanned and the promote job publishes.
#
# Usage: scripts/e2e-load-images.sh <dir holding <component>-amd64.tar>
#
# Loads exactly the images.json components the E2E compose runs (read from
# `docker compose config --images`; the seed harness is test tooling and
# always builds). Fail-loud: a missing tar or an unreadable load exits
# non-zero. Each tar is deleted once loaded — the Hermes images are ~4 GB
# unpacked and the runner's disk is finite.
set -euo pipefail

dir="${1:?usage: e2e-load-images.sh <layouts dir>}"
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
  out="$(docker load -i "$tar")"
  id="$(printf '%s\n' "$out" | sed -n 's/^Loaded image ID: //p' | tail -1)"
  [ -n "$id" ] || id="$(printf '%s\n' "$out" | sed -n 's/^Loaded image: //p' | tail -1)"
  [ -n "$id" ] || { echo "e2e-load-images: could not read the loaded image from: $out" >&2; exit 1; }
  docker tag "$id" "vs-e2e/$component:ci"
  rm -f "$tar"
  echo "e2e-load-images: vs-e2e/$component:ci <- $component-amd64.tar ($(docker image inspect -f '{{.Id}}' "vs-e2e/$component:ci"))"
done
