# images/agent/Dockerfile — the VS devices agent runtime
# (fleet-ops-j7g.1: the runtime swap this file's b1r forward shape
# documented — "when the swap lands, this file becomes the build").
#
# The pinned official Hermes image (SAME v2026.9.21 tag as the master's
# primus image — the parity pin; do NOT bump independently) plus:
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

# ── Docs: the WORKER environment map + the shared conventions ─────────────
COPY docs/queue-conventions.md \
     docs/device-environment.md \
     docs/a2a-conventions.md \
     docs/gateway-ops.md \
     docs/memory-conventions.md \
     docs/vs-github.md \
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