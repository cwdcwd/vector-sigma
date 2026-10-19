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

COPY images/litellm/litellm-config.yaml /app/config.yaml
COPY images/litellm/litellm-entrypoint.sh /app/litellm-entrypoint.sh

ENTRYPOINT ["/app/litellm-entrypoint.sh"]
CMD ["--config", "/app/config.yaml", "--port", "4000"]