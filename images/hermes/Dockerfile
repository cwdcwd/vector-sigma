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