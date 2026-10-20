#!/usr/bin/env bash
# scripts/install-regctl.sh — install the pinned, checksum-verified regctl
# (github.com/regclient/regclient) the publish path uses to copy the scanned
# OCI layouts into GHCR digest-for-digest. Fails closed on a checksum mismatch.
#
#   scripts/install-regctl.sh [dest-dir]     # default: /usr/local/bin
#
# Bump: change REGCTL_VERSION and the matching sha256 (from the release's own
# asset, verified before committing); never use a floating "latest".
set -euo pipefail

REGCTL_VERSION="v0.11.6"
pinned_sha256() {
  case "$1" in
    linux-amd64) echo "8e0e62a497fcdb8048d18aa927a139613176ba0531f412bc541044e28f9856bd" ;;
    darwin-arm64) echo "5b52b71861abc300ab513e87a4c3794cff6508035ac7f6b6bdfa1fa5688c0040" ;;
  esac
}

dest="${1:-/usr/local/bin}"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "install-regctl: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
platform="${os}-${arch}"
want="$(pinned_sha256 "$platform")"
[ -n "$want" ] || { echo "install-regctl: no pinned checksum for ${platform}" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "https://github.com/regclient/regclient/releases/download/${REGCTL_VERSION}/regctl-${platform}"
got="$(sha256sum "$tmp" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$tmp" | cut -d' ' -f1)"
[ "$got" = "$want" ] || { echo "install-regctl: sha256 mismatch for regctl ${REGCTL_VERSION} ${platform}: want ${want}, got ${got}" >&2; exit 1; }
install -m 0755 "$tmp" "${dest}/regctl"
"${dest}/regctl" version --format '{{.VCSTag}}' | sed 's/^/install-regctl: installed regctl /'
