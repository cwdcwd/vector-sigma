# images/litellm/Dockerfile — the VS fleet's own LiteLLM gateway
# image (fleet-ops-f57.12).
#
# The balena supervisor cannot bind-mount files into services, so the config is
# baked. The platforms/compose/ self-host runs the SAME image (platforms/compose/compose.yaml) — one
# artifact, one env contract, no twin drift.
#
# Tag scheme note: LiteLLM moved to plain-semver content tags in July 2026
# ("main-stable" is legacy but still advances); pin the stock 1.105.1 release.
# The stock image ENTRYPOINT is docker/prod_entrypoint.sh (execs
# `litellm "$@"`), which our entrypoint shim re-execs after assembling
# DATABASE_URL from parts.

# Base is pinned to the ghcr registry INDEX digest (multi-arch manifest list,
# both amd64+arm64 CI legs), not the floating 1.105.1 tag: the content gate's
# httpx2 2.13.0 byte-identity pins (upstream-allowlist-data.gen.ts,
# pip-httpx2-rfc1918 entry) are valid only for exactly these bytes.
# Resolved 2026-10-18 from an anonymous pull of ghcr.io/berriai/litellm:1.105.1;
# re-derive the allowlist pins BEFORE bumping this digest (gate contract).
FROM ghcr.io/berriai/litellm@sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802

# CRITICAL remediation (release gate, 2026-10-21): certifi 2026.10.19 over the
# base venv's 2026.4.22 (GHSA-6q48-6c7w-9gw2, compromised emSign roots). The
# stock venv has no pip/uv, so uv is bind-mounted for this one step only (no
# binary shipped). The base layer's pinned bytes are untouched; the content
# gate scans the new layer like any other.
RUN --mount=from=ghcr.io/astral-sh/uv:0.12.24@sha256:3af4716e991d6956a41e573eab705d0ee08500cd829ed30293eb8472f372c65a,source=/uv,target=/tmp/uv \
    /tmp/uv pip install --no-cache --python /app/.venv/bin/python 'certifi==2026.10.19' \
    && /app/.venv/bin/python -c 'import certifi, sys; v = certifi.__version__; print("certifi", v); sys.exit(v != "2026.10.19")'
# CVE-2026-111497 (GHSA-9v8h-qqgm-4m35, Brotli decoder out-of-bounds write): the
# pinned base ships nodejs-26 26.11.1 (Brotli built into node:zlib) and Wolfi's
# brotli 1.2.0 shared libraries. Wolfi has both fixes (nodejs-26 26.12.1,
# brotli 1.2.1); upgrade exactly those packages and fail the build unless the
# loaded versions are fixed.
RUN apk add --no-cache --upgrade nodejs-26 libbrotlicommon1 libbrotlidec1 libbrotlienc1 \
    && [ "$(node -v)" = "v26.12.1" ] || { echo "brotli-cve: node is $(node -v), expected v26.12.1" >&2; exit 1; } \
    && /app/.venv/bin/python -c 'import ctypes, sys; \
v = ctypes.CDLL("libbrotlidec.so.1").BrotliDecoderVersion(); \
print("brotli-cve: libbrotlidec 0x%x" % v); sys.exit(0 if v >= 0x1002001 else 1)'
COPY images/litellm/litellm-config.yaml /app/config.yaml
COPY images/litellm/litellm-entrypoint.sh /app/litellm-entrypoint.sh

ENTRYPOINT ["/app/litellm-entrypoint.sh"]
CMD ["--config", "/app/config.yaml", "--port", "4000"]