# images/agent/Dockerfile — the VS devices agent runtime
# (fleet-ops-j7g.1: the runtime swap this file's b1r forward shape
# documented — "when the swap lands, this file becomes the build").
#
# The official Hermes Agent v0.22.5 stable image, pinned to its verified
# multi-arch manifest digest (SAME release as primus; update both together) plus:
#   1. bd 1.2.2 baked FULL READ-WRITE (the scotty tarball+sha256 supply-
#      chain pattern VERBATIM — ARG BD_VERSION=1.2.2, arch derived from
#      uname -m [legacy-builder-safe; NO TARGETARCH — the f57.21 guard],
#      checksums.txt-verified, fail-loud). Devices are queue WORKERS, not
#      curators — still read-write (claim + comment + close), never the
#      scotty bd-readonly wrapper posture.
#   2. The identity gate (gate.sh — the placeholder image's own contract,
#      kept): no ready marker, no agent. It wraps the image's ENTRYPOINT
#      so the official bootstrap chain (s6 /init -> cont-init.d ->
#      main-wrapper) runs ONLY once identity exists — the same marker gate
#      as the placeholder, now guarding the real runtime.
#   3. The A2A mesh wiring hook (images/common/hooks/vs-a2a-wiring.sh as
#      /etc/cont-init.d/04-vs-a2a-wiring — the j7g.1 CODE contract):
#      derives the runtime env (model route, gateway URL+key, A2A
#      identity/trusted-peers/public-url/peer-tokens, TLS CA) from the
#      registrar-delivered bundle on EVERY boot, so mesh rotations land
#      with no hands. Runs AFTER 01-hermes-setup (stage2 seeds .env when
#      absent; this hook then merges the bundle lines INTO it).
#   4. The queue join is DELIVERED, not baked: devices are queue workers
#      whose join differs per deployment (dolt host/port arrive via the
#      bundle's extra_env BEADS_* keys, per the runbook) — the b1r primus
#      bake was master-specific (compose-service dolt host, baked join);
#      a baked join here would freeze a device-specific dolt host into
#      an N-device image. NEVER a device-side bd init (the 2026-09-09
#      lockout class).
#   5. The device environment map + queue conventions + A2A dispatch
#      discipline + the gateway ops runbook at /opt/vs/docs, copied
#      straight from docs/. e5o.1: the devices environment map is
#      device-environment.md (the WORKER map) — NEVER the master's
#      vs-environment.md (wrong-map regression, CI-fatal in
#      registrar/test/image-build-config.test.ts).
#
# Built from the REPO ROOT context (docker build -f platforms/balena/devices/
# images/agent/Dockerfile .): CI builds it once, scans it, E2Es those
# bytes and promotes them to GHCR; balena pulls the published digest.

# ── CVE-2026-111497 (GHSA-9v8h-qqgm-4m35): Brotli decoder out-of-bounds write ──
# Fixed upstream in Brotli 1.2.1; Debian trixie's libbrotli1 1.1.0-2+b7 has no
# fix yet, and libcurl, freetype, libjxl and ffmpeg in the base link it (libcurl
# decompresses Content-Encoding: br from any server). Build 1.2.1 from Google's
# release tarball (sha256-pinned) and drop its shared libraries in place of
# Debian's below: same soname (.1), additive ABI. Remove this stage once Debian
# ships a fixed libbrotli1 (the final RUN's version check will still pass).
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS brotli
ARG BROTLI_VERSION=1.2.1
ARG BROTLI_SHA256=98d35d11a78dc453aebb7d10c3748f3f73ff78c8267c0dc697b8631f67bf7e8f
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl cmake gcc make libc6-dev \
    && curl -fsSL -o /tmp/brotli.tar.gz "https://github.com/google/brotli/archive/refs/tags/v${BROTLI_VERSION}.tar.gz" \
    && echo "${BROTLI_SHA256}  /tmp/brotli.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/brotli.tar.gz -C /tmp \
    && cmake -S "/tmp/brotli-${BROTLI_VERSION}" -B /tmp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
         -DBROTLI_DISABLE_TESTS=ON -DCMAKE_INSTALL_PREFIX=/opt/brotli \
    && cmake --build /tmp/build -j"$(nproc)" \
    && cmake --install /tmp/build \
    && ls /opt/brotli/lib*/libbrotlidec.so.1

FROM nousresearch/hermes-agent:v0.22.5@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d

# Release CVE gate (trivy, fixable CRITICAL blocks) — the upstream base's
# pending fixes, in the image we ship:
#   - Debian security updates (perl, mbedtls, kernel UAPI headers, docker-cli)
#   - PyJWT / anyio in the Hermes venv (patch-level, pinned)
#   - npm 11.21.1 (same major as the base): its bundled tar is patched. npm is
#     kept, not removed — Hermes may launch npx-based MCP servers at runtime.
# HIGH remediation (2026-10-20, reported-not-blocking policy; fixable HIGHs
# cleared where a fixed upstream release exists):
#   - uv 0.12.24 replaces the base's 0.11.6 (bundled rustls-webpki / quinn-proto)
#   - venv: aiohttp 3.14.4, tornado 6.5.9, urllib3 2.8.0, httpx2 + httpcore2
#     2.12.0 (hermes-agent pins aiohttp==3.14.3 / httpx2==2.7.0 in extras —
#     overridden, as PyJWT is; those pins are extras-only, so `uv pip check`
#     still reports just the PyJWT override and the base's own msal one)
#   - CRITICAL, 2026-10-21: certifi 2026.10.19 (GHSA-6q48-6c7w-9gw2, compromised
#     emSign roots) and pillow 13.0.0 (CVE-2026-112403). hermes-agent hard-pins
#     certifi==2026.5.20 and Pillow==12.3.0, so `uv pip check` flags both too;
#     Hermes's own code uses none of the APIs Pillow 13 removed.
#   - node: patch releases dropped in place of the vulnerable copies inside
#     Hermes's own trees (same major/minor, unchanged dependency ranges). Each
#     target must exist at the expected version, so a base bump that moves or
#     fixes one fails the build instead of silently skipping it.
# npm CVE overrides, 2026-10-26: moot at v0.22.5, removed. The base's dependency
# tree moved: opt/hermes/node_modules/{brace-expansion,source-map-js} and
# opt/hermes/ui-tui/node_modules/undici no longer exist at those paths (ui-tui
# became a workspace package with hoisted root deps; verified absent on both
# arches against the real v0.22.5 image bytes — not just the manifest). The
# remaining two targets (photon sidecar undici, @grpc/grpc-js) already ship
# past their fix versions natively (7.30.0 >= 7.29.1, 1.14.6 >= 1.14.5), so
# forcing a pinned downgrade-then-reinstall cycle buys nothing. Re-add a
# targeted override here only if a future base bump reintroduces a vulnerable
# version at a path that still exists.
COPY --from=ghcr.io/astral-sh/uv:0.12.24@sha256:3af4716e991d6956a41e573eab705d0ee08500cd829ed30293eb8472f372c65a /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && uv pip install --no-cache --python /opt/hermes/.venv/bin/python 'PyJWT==2.14.0' 'anyio==4.14.2' \
         'aiohttp==3.14.4' 'tornado==6.5.9' 'urllib3==2.8.0' 'httpx2==2.12.0' 'httpcore2==2.12.0' \
         'certifi==2026.10.19' 'pillow==13.0.0' \
         'PyYAML==6.0.3' \
    && npm install -g --no-audit --no-fund --cache /tmp/.npm-cve-cache npm@11.21.1 \
    && rm -rf /tmp/.npm-cve-cache /root/.npm

# CVE-2026-111497 (Brotli, see the brotli stage above): three copies to fix.
#   - node: the base's /usr/local/bin/node is v26.5.1 (Brotli is built into
#     node:zlib); the official 26.12.1 binary replaces it (same major).
#   - libbrotli1: the 1.2.1 build replaces Debian's shared libraries in place.
#   - brotlicffi 1.2.0.2 in the Hermes venv vendors the vulnerable decoder;
#     1.2.1.0 vendors the fix.
# The final check fails the build unless all three report fixed versions.
COPY --from=node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec /usr/local/bin/node /usr/local/bin/node
COPY --from=brotli /opt/brotli/ /tmp/brotli/
RUN deb="$(ldconfig -p | awk '/libbrotlidec\.so\.1 /{print $NF; exit}')" \
    && [ -n "$deb" ] || { echo "brotli-cve: ldconfig has no libbrotlidec.so.1 (did the base drop libbrotli1?)" >&2; exit 1; } \
    && libdir="$(dirname "$(readlink -f "$deb")")" \
    && [ -d "$libdir" ] && [ "$libdir" != "/" ] || { echo "brotli-cve: bad library dir '$libdir'" >&2; exit 1; } \
    && for lib in common dec enc; do \
         src="$(ls /tmp/brotli/lib*/libbrotli${lib}.so.1.*.* | head -1)"; \
         cp -f "$src" "$libdir/" && ln -sf "$(basename "$src")" "$libdir/libbrotli${lib}.so.1"; \
         for old in "$libdir"/libbrotli${lib}.so.1.*.*; do \
           [ "$(basename "$old")" = "$(basename "$src")" ] || rm -f "$old"; \
         done; \
       done \
    && rm -rf /tmp/brotli && ldconfig \
    && uv pip install --no-cache --python /opt/hermes/.venv/bin/python 'brotlicffi==1.2.1.0' \
    && [ "$(node -v)" = "v26.12.1" ] || { echo "brotli-cve: node is $(node -v), expected v26.12.1" >&2; exit 1; } \
    && /opt/hermes/.venv/bin/python -c 'import ctypes, importlib.metadata as m, sys; \
v = ctypes.CDLL("libbrotlidec.so.1").BrotliDecoderVersion(); \
c = m.version("brotlicffi"); \
print("brotli-cve: libbrotlidec 0x%x, brotlicffi %s" % (v, c)); \
sys.exit(0 if v >= 0x1002001 and c == "1.2.1.0" else 1)'

# ── GitHub App identity wrapper + wiring hook (fleet-ops-e5o.5) ────────
# The pinned official image ships git + openssl + the runtime venv
# python (with PyJWT) but NO GitHub tooling of any kind — a device
# agent has no documented path to write to the repo. The wrapper below
# mints short-lived installation tokens from the agent's OWN App
# private key (delivered via the registrar bundle, never baked); the
# 05- boot hook derives the GIT_CONFIG_* env lines that make plain git
# authenticate as <slug>[bot]. Sources: images/common/{bin,hooks}/vs-github-identity.{py,sh}
# (docs/vs-github.md is the usage doc).
COPY images/common/bin/vs-github-identity.py /usr/local/bin/vs-github-identity
COPY images/common/hooks/vs-github-identity.sh /etc/cont-init.d/05-vs-github-identity
RUN chmod 0755 /usr/local/bin/vs-github-identity /etc/cont-init.d/05-vs-github-identity

# ── bd 1.2.2: prebuilt release binary (the images/scotty/Dockerfile + harness pattern) ──
# Pinned per the fleet convention (fleet/conventions/bd-version-pin: bd
# 1.3.x auto-migrates the shared Dolt schema and would lock out every
# 1.2.2 client — NEVER bump past the fleet pin).
ARG BD_VERSION=1.2.2
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) arch=arm64 ;; \
         x86_64) arch=amd64 ;; \
         *) echo "ERROR (j7g.1): unsupported build host uname -m '${arch}' — expected aarch64 or x86_64; refusing to guess the bd release asset (images/agent/Dockerfile)" 1>&2; exit 1 ;; \
       esac \
    && tarball="beads_${BD_VERSION}_linux_${arch}.tar.gz" \
    && curl -fsSL -o /tmp/checksums.txt "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/checksums.txt" \
    && curl -fsSL -o "/tmp/${tarball}" "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/${tarball}" \
    && want="$(grep -F "${tarball}" /tmp/checksums.txt | cut -d' ' -f1)" \
    && { [ -n "$want" ] || { echo "ERROR (j7g.1): checksums.txt at bd ${BD_VERSION} has no entry for ${tarball} — refusing to install an unverified binary (images/agent/Dockerfile)" 1>&2; exit 1; }; } \
    && got="$(sha256sum "/tmp/${tarball}" | cut -d' ' -f1)" \
    && { [ "$want" = "$got" ] || { echo "ERROR (j7g.1): sha256 mismatch for ${tarball}: want ${want}, got ${got} — refusing to install (images/agent/Dockerfile)" 1>&2; exit 1; }; } \
    && tar -xzf "/tmp/${tarball}" -C /tmp \
    && mv /tmp/bd /usr/local/bin/bd \
    && chmod 0755 /usr/local/bin/bd \
    && rm -f "/tmp/${tarball}" /tmp/checksums.txt

# ── The identity gate (the placeholder image's own contract, kept) ────────
COPY images/agent/gate.sh /usr/local/bin/gate.sh
RUN chmod 0755 /usr/local/bin/gate.sh

# ── The A2A wiring hook (cont-init, AFTER stage2's 01-hermes-setup) ──────
COPY images/common/hooks/vs-a2a-wiring.sh /etc/cont-init.d/04-vs-a2a-wiring
RUN chmod 0755 /etc/cont-init.d/04-vs-a2a-wiring

# Signed A2A identity (docs/a2a-signed-identity.md): the guard sidecar + its s6 longrun. Dark until
# the wiring hook writes $HERMES_HOME/a2a-guard/guard.json (a bundle carrying peer_keys); until then
# the service exits and stays down, so behavior is unchanged.
COPY images/common/bin/vs-a2a-guard.py /usr/local/bin/vs-a2a-guard
COPY images/common/s6/a2a-guard /etc/s6-overlay/s6-rc.d/a2a-guard
RUN chmod 0755 /usr/local/bin/vs-a2a-guard /etc/s6-overlay/s6-rc.d/a2a-guard/run \
         /etc/s6-overlay/s6-rc.d/a2a-guard/finish \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/a2a-guard

# fleet-ops-1py.47.1: the hub router (same as the primus image): the board
# pipeline router over the baked vs_ops queue join — dark until the owner
# provides a VS_HUB_AGENTS roster; then sweeps stage ready beads against WIP
# caps and route stage agents' HANDOFF comments via board metadata.
COPY images/common/bin/vs-hub-router.py /usr/local/bin/vs-hub-router
COPY images/common/s6/vs-hub-router /etc/s6-overlay/s6-rc.d/vs-hub-router
RUN chmod 0755 /usr/local/bin/vs-hub-router /etc/s6-overlay/s6-rc.d/vs-hub-router/run \
         /etc/s6-overlay/s6-rc.d/vs-hub-router/finish \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/vs-hub-router

# ── Docs: the WORKER environment map + the shared conventions ─────────────
COPY docs/queue-conventions.md \
     docs/device-environment.md \
     docs/a2a-conventions.md \
     docs/gateway-ops.md \
     docs/memory-conventions.md \
     docs/vs-github.md \
     docs/vs-boot-workflows.md \
     /opt/vs/docs/
COPY images/agent/hermes-agent-defaults.yaml /opt/vs/hermes-agent-defaults.yaml

# ── The gateway-memory plugin + install hook (fleet-ops-e5o.3) ────────────
# Source: images/common/gateway-memory/ (sha-stamped by provenance-sha256.txt).
# The 06- hook installs it into $HERMES_HOME/plugins/ and seeds
# plugins.enabled on every boot (PluginManager's allow-list gate — a
# copied-but-unlisted plugin registers NOTHING). Memory KEYS arrive via
# the bundle's extra_env, never baked. Lexically after 05-, fail-soft.
COPY images/common/gateway-memory /opt/vs/gateway-memory
COPY images/common/hooks/vs-memory-tools.sh /etc/cont-init.d/06-vs-memory-tools
RUN chmod 0755 /etc/cont-init.d/06-vs-memory-tools

# ── The identity gate as ENTRYPOINT ────────────────────────────────────────
# The upstream image's ENTRYPOINT is the dispatcher; this image's gate
# REPLACES it — identity first, then the gate execs the dispatcher so
# the official bootstrap chain (s6 /init -> cont-init.d, including the
# 04-vs-a2a-wiring hook) runs only once identity exists. The gate execs
# (never forks), so the dispatcher stays PID 1 under balena.
ENTRYPOINT ["/usr/local/bin/gate.sh"]