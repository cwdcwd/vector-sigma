# images/hermes/Dockerfile — primus (the VS coordinator Hermes)
# custom image (fleet-ops-b1r).
#
# Built from the REPO ROOT context (docker build -f platforms/balena/registrar/
# images/hermes/Dockerfile .): CI builds it once, scans it, E2Es those bytes and
# promotes them to GHCR; every platform/ pulls the published digest.
# Every COPY reads the canonical source (images/, docs/) — there
# are no vendored copies to drift. The official Hermes image pin is the same tag the compose used
# before this lane (do NOT bump independently — the tag is the auditable
# lineage and the compose's parity pin):
#   FROM nousresearch/hermes-agent:v2026.9.21
#
# What this image adds to the official one (the b1r lane, owner ruling
# 2026-09-29: primus must be fully rebuildable from the repo with zero
# manual steps — bake, don't runtime-install):
#   1. bd 1.2.2, full read-write, at /usr/local/bin/bd — primus is the
#      queue CURATOR; this is NOT the scotty bd-readonly wrapper posture
#      (scotty reads; primus creates/closes/claims beads).
#   2. the queue join config at /opt/vs/queue-join/.beads (config-only
#      join; the canonical project_id is the fleet contract) — a boot
#      hook copies it to $HERMES_HOME/vs-queue at first boot.
#   3. environment docs at /opt/vs/docs (queue-conventions.md +
#      vs-environment.md — primus's own map; a2a-conventions.md — the
#      dispatch-discipline doc, e5o.4; gateway-ops.md — the gateway
#      ops runbook, e5o.6).
#
# Supply-chain posture: the bd tarball is fetched at the pinned release
# and sha256-verified against the release's own checksums.txt in the
# same RUN, fail-loud — the images/scotty/Dockerfile posture (f57.21), which is
# the 8ea hash-pin posture. The base image ships curl (not wget): the
# scotty pattern is adapted to curl only where the tool differs.

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

FROM nousresearch/hermes-agent:v2026.9.21

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
COPY --from=ghcr.io/astral-sh/uv:0.12.24@sha256:3af4716e991d6956a41e573eab705d0ee08500cd829ed30293eb8472f372c65a /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && uv pip install --no-cache --python /opt/hermes/.venv/bin/python 'PyJWT==2.14.0' 'anyio==4.14.2' \
         'aiohttp==3.14.4' 'tornado==6.5.9' 'urllib3==2.8.0' 'httpx2==2.12.0' 'httpcore2==2.12.0' \
         'certifi==2026.10.19' 'pillow==13.0.0' \
    && npm install -g --no-audit --no-fund --cache /tmp/.npm-cve-cache npm@11.21.1 \
    && mkdir /tmp/cve-pack \
    && for spec in \
         /opt/hermes/node_modules/brace-expansion=5.0.9=5.0.11 \
         /opt/hermes/node_modules/source-map-js=1.2.1=1.2.2 \
         /opt/hermes/ui-tui/node_modules/undici=6.28.0=6.28.1 \
         /opt/hermes/plugins/platforms/photon/sidecar/node_modules/undici=7.29.0=7.29.1 \
         /opt/hermes/plugins/platforms/photon/sidecar/node_modules/@grpc/grpc-js=1.14.4=1.14.5; do \
         dir="${spec%%=*}"; rest="${spec#*=}"; have="${rest%%=*}"; want="${rest#*=}"; \
         name="$(node -p "require('$dir/package.json').name")"; \
         got="$(node -p "require('$dir/package.json').version")"; \
         [ "$got" = "$have" ] || { echo "cve-override: $dir is $got, expected $have" >&2; exit 1; }; \
         tgz="$(npm pack --silent --cache /tmp/.npm-cve-cache --pack-destination /tmp/cve-pack "$name@$want")" \
           && [ -n "$tgz" ] && [ -f "/tmp/cve-pack/$tgz" ] \
           || { echo "cve-override: npm pack $name@$want failed" >&2; exit 1; }; \
         rm -rf "$dir" && mkdir -p "$dir" && tar -xzf "/tmp/cve-pack/$tgz" -C "$dir" --strip-components 1 --no-same-owner \
           || { echo "cve-override: extracting $name@$want into $dir failed" >&2; exit 1; }; \
         now="$(node -p "require('$dir/package.json').version")" \
           && [ "$now" = "$want" ] \
           || { echo "cve-override: $dir is '$now' after replacement, expected $want" >&2; exit 1; }; \
         echo "cve-override: $name $have -> $now at $dir"; \
       done \
    && rm -rf /tmp/cve-pack /tmp/.npm-cve-cache /root/.npm

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

# ── bd 1.2.2: prebuilt release binary (images/scotty/Dockerfile pattern, VERBATIM
# mechanism) ──────────────────────────────────────────────────────────────
# Pinned per the fleet convention (fleet/conventions/bd-version-pin: bd
# 1.3.x auto-migrates the shared Dolt schema and would lock out every
# 1.2.2 client — NEVER bump past the fleet pin).
# The release asset arch is derived INSIDE the RUN from `uname -m`, NOT
# from TARGETARCH. Automatic population of TARGETARCH / TARGETPLATFORM is
# BuildKit-only; balena's remote builder is the LEGACY builder, which sets
# neither — registrar-v1.1.1 deploy run 36205380041 failed with
#   ADD failed: failed to GET .../beads_1.2.2_linux_.tar.gz with status 404
# (empty arch). uname -m is builder-agnostic, reports the true build arch
# (aarch64->arm64 on the Pi, x86_64->amd64 in CI; under a qemu cross-build
# it reports the emulated target arch), and fails loud on anything else.
# The tarball is verified against the release's own checksums.txt at the
# SAME v${BD_VERSION} pin before install — fail-loud on mismatch, matching
# the 8ea-patch hash-pin supply-chain posture. The base image ships curl
# (not wget — the scotty image's alpine stage used wget): same fetch shape,
# curl invocations.
ARG BD_VERSION=1.2.2
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) arch=arm64 ;; \
         x86_64) arch=amd64 ;; \
         *) echo "ERROR (b1r): unsupported build host uname -m '${arch}' — expected aarch64 or x86_64; refusing to guess the bd release asset (images/hermes/Dockerfile)" 1>&2; exit 1 ;; \
       esac \
    && tarball="beads_${BD_VERSION}_linux_${arch}.tar.gz" \
    && curl -fsSL -o /tmp/checksums.txt "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/checksums.txt" \
    && curl -fsSL -o "/tmp/${tarball}" "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/${tarball}" \
    && want="$(grep -F "${tarball}" /tmp/checksums.txt | cut -d' ' -f1)" \
    && { [ -n "$want" ] || { echo "ERROR (b1r): checksums.txt at bd ${BD_VERSION} has no entry for ${tarball} — refusing to install an unverified binary (images/hermes/Dockerfile)" 1>&2; exit 1; }; } \
    && got="$(sha256sum "/tmp/${tarball}" | cut -d' ' -f1)" \
    && { [ "$want" = "$got" ] || { echo "ERROR (b1r): sha256 mismatch for ${tarball}: want ${want}, got ${got} — refusing to install (images/hermes/Dockerfile)" 1>&2; exit 1; }; } \
    && tar -xzf "/tmp/${tarball}" -C /tmp \
    && mv /tmp/bd /usr/local/bin/bd \
    && chmod 0755 /usr/local/bin/bd \
    && rm -f "/tmp/${tarball}" /tmp/checksums.txt

# ── Queue join config + docs + the boot hook ─────────────────────────────
# The join is CONFIG-ONLY (config-only proven live, fleet-ops-b1r lab):
# .beads/metadata.json (canonical project_id bcde5891-… the fleet
# contract) + .beads/dolt-server.port. NEVER bd init in image builds —
# a second init rewrites the shared DB's project_id (the 9-09 lockout
# class). The password NEVER lives here: primus receives
# BEADS_DOLT_PASSWORD via the composition env (fleet variable cascades
# or compose entry, mirroring the scotty posture).
COPY images/common/queue-join /opt/vs/queue-join
# Primus's doc set: its own environment map (vs-environment.md) plus the
# shared conventions — straight from docs/.
COPY docs/queue-conventions.md \
     docs/vs-environment.md \
     docs/a2a-conventions.md \
     docs/gateway-ops.md \
     docs/memory-conventions.md \
     docs/vs-github.md \
     /opt/vs/docs/
COPY images/hermes/vs-queue-join.sh /etc/cont-init.d/03-vs-queue-join
RUN chmod 0755 /etc/cont-init.d/03-vs-queue-join
# j7g.1: the A2A mesh wiring hook — primus is a mesh member too (the
# coordinator's Hermes serves its own card through the master gateway).
# Same contract as the devices agent image: derives A2A_* env + the
# config.yaml managed section from the registrar-delivered bundle on
# every boot. 04- prefix: after stage2 (01-), lexically after the queue
# join (03-) — both hooks are independent and fail-soft.
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

# fleet-ops-1py.47.1: the hub router — the board pipeline router over the
# baked vs_ops queue join ($HERMES_HOME/vs-queue, the 03-vs-queue-join
# workspace). Same dark-until-configured posture as the guard: with no
# VS_HUB_AGENTS roster (an owner compose/balena env choice) the s6 longrun
# idles; with one, every sweep verifies the workspace contract, stages
# ready beads against WIP caps, validates stage agents' HANDOFF comments
# and re-pings stale work via the a2a-guard's signed outbound route.
COPY images/common/bin/vs-hub-router.py /usr/local/bin/vs-hub-router
COPY images/common/s6/vs-hub-router /etc/s6-overlay/s6-rc.d/vs-hub-router
RUN chmod 0755 /usr/local/bin/vs-hub-router /etc/s6-overlay/s6-rc.d/vs-hub-router/run \
         /etc/s6-overlay/s6-rc.d/vs-hub-router/finish \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/vs-hub-router

# e5o.5: the GitHub App identity wiring hook — primus writes to this
# repo too (the same per-agent App mechanics as the devices: the bundle
# carries github-app.pem + GH_APP_ID/GH_APP_SLUG; the hook derives the
# GIT_CONFIG_* env lines so plain git authenticates as the App). 05-
# prefix: lexically after the A2A wiring (04-), both fail-soft.
# The wrapper itself ships in the SAME venv python the image already
# provides (PyJWT included) — see the COPY of vs-github-identity.py
# to /usr/local/bin below.
COPY images/common/hooks/vs-github-identity.sh /etc/cont-init.d/05-vs-github-identity
COPY images/common/bin/vs-github-identity.py /usr/local/bin/vs-github-identity
RUN chmod 0755 /etc/cont-init.d/05-vs-github-identity /usr/local/bin/vs-github-identity

# j7g.1 mesh-enroll: the thin primus CLI (images/common/bin/vs-mesh-enroll.py). One command per agent: vs-mesh-enroll <agent>
# calls the registrar's /v1/mesh-enroll machine-auth action, which
# mints/opens the vs-<agent>-a2a sentinel server-side and merges BOTH
# sides' bundles. The CLI reads its auth (MESH_ENROLL_KEY) from the
# bundle's config/agent.env via $HERMES_HOME — NEVER from image layers.
# The venv python the image already ships runs it (stdlib-only).
COPY images/common/bin/vs-mesh-enroll.py /usr/local/bin/vs-mesh-enroll
RUN chmod 0755 /usr/local/bin/vs-mesh-enroll

# e5o.3: the gateway-memory plugin + its install hook. The plugin copy
# (images/common/gateway-memory/, product-agnostic VS copy of the origin
# fleet-memory plugin) is sha-stamped by provenance-sha256.txt. The
# 06- hook copies it into $HERMES_HOME/plugins/ and seeds
# plugins.enabled — PluginManager gates user plugins through the
# allow-list, so the copy alone would register NOTHING. Keys arrive via
# the bundle's extra_env (GATEWAY_MEMORY_{SHARED,PRIVATE}_KEY), never
# baked. Lexically after 05-, both fail-soft.
COPY images/common/gateway-memory /opt/vs/gateway-memory
COPY images/common/hooks/vs-memory-tools.sh /etc/cont-init.d/06-vs-memory-tools
RUN chmod 0755 /etc/cont-init.d/06-vs-memory-tools

# Entrypoint/CMD are inherited from the official image: the dispatcher
# → /init → cont-init.d (01- stage2, 02- profile reconcile, 03- queue
# join, 04- A2A wiring, 05- GitHub identity, 06- memory tools) →
# main-wrapper → hermes. Nothing is overridden;
# the compose's `command: [gateway, run]` keeps flowing through the same
# chain.