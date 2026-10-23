# images/scotty/Dockerfile — the VS queue dashboard (fleet-ops-f57.15).
#
# Fleet-proven stack, pinned (the bead's provenance contract):
#   - Bead Me Up Scotty v0.3.0 = cc55734df9ba44262b34a2133f0f10f410021e19
#     (tag 12de35a9; verified 2026-09-21: v0.3.0's tag object points at cc55734)
#   - the fleet's 8ea deep-link patch (hydrated-tab hang, fleet-ops-8ea:
#     sha256 8f75790df31eda440666a3ca97fafbdaa249741c3de49a345ffcea53ee9f9b37,
#     5227B/122L, verified byte-exact this session; applies clean to cc55734)
#   - bd CLI pinned at 1.2.2 (fleet convention fleet/conventions/bd-version-pin:
#     bd 1.3.x auto-migrates the shared Dolt schema and would lock out every
#     other client — NEVER bump past the fleet pin; upstream Dockerfile defaults
#     to BD_VERSION=1.1.0, so the pin is load-bearing)
#
# The build fetches the upstream source at the pinned commit from GitHub
# (public, MIT) and applies the vendored patch from THIS repo — no other
# network access needed. The balena remote builder receives only this app dir
# (balena-app-dir-self-contained convention), so the vendored patch must live
# in platforms/balena/registrar/ with this Dockerfile.
#
# Result: image = scotty @ cc55734 + 8ea patch + bd 1.2.2 + bd-readonly wrapper
# at /usr/local/bin/bd (scotty's default BD_BIN) with the real binary at
# /usr/local/bin/bd.real — the two-layer read-only posture (see bd-readonly).

FROM node:26.12.1-slim AS source
# NOTE: cloned with --filter=blob:none is NOT used: we need working-tree bytes
# to build. Depth-1 clone at the pinned SHA; the tag object is verified at
# build time by asserting the checked-out HEAD equals the pin.
ARG SCOTTY_SHA=cc55734df9ba44262b34a2133f0f10f410021e19
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /scotty
RUN git clone --quiet --no-checkout https://github.com/brendan-appstart/bead-me-up-scotty.git src \
    && cd src \
    && git fetch --quiet origin "${SCOTTY_SHA}" \
    && git checkout --quiet "${SCOTTY_SHA}" \
    && test "$(git rev-parse HEAD)" = "${SCOTTY_SHA}"
# Apply the fleet's 8ea patch (vendored in-repo; hash-checked at build start).
COPY images/scotty/scotty-8ea-deep-link.patch /tmp/scotty-8ea-deep-link.patch
RUN sha256sum /tmp/scotty-8ea-deep-link.patch | grep -q '^8f75790df31eda440666a3ca97fafbdaa249741c3de49a345ffcea53ee9f9b37' \
    && cd /scotty/src \
    && git apply --check /tmp/scotty-8ea-deep-link.patch \
    && git apply /tmp/scotty-8ea-deep-link.patch

# ── bd 1.2.2: prebuilt release binary (upstream scotty Dockerfile shape) ─────
FROM node:26.12.1-alpine AS bd
# Pinned per the fleet convention (fleet/conventions/bd-version-pin: bd 1.3.x
# auto-migrates the shared Dolt schema — NEVER bump past the fleet pin).
# f57.21: the release asset arch is derived INSIDE the RUN from `uname -m`,
# NOT from TARGETARCH. Automatic population of TARGETARCH / TARGETPLATFORM is
# BuildKit-only; balena's remote builder is the LEGACY builder, which sets
# neither — registrar-v1.1.1 deploy run 36205380041 failed with
#   ADD failed: failed to GET .../beads_1.2.2_linux_.tar.gz with status 404
# (empty arch). uname -m is builder-agnostic, reports the true build arch
# (aarch64->arm64 on the Pi, x86_64->amd64 in CI; under a qemu cross-build
# it reports the emulated target arch), and fails loud on anything else.
# The tarball is verified against the release's own checksums.txt at the
# SAME v${BD_VERSION} pin before install — fail-loud on mismatch, matching
# the 8ea-patch hash-pin supply-chain posture.
ARG BD_VERSION=1.2.2
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) arch=arm64 ;; \
         x86_64) arch=amd64 ;; \
         *) echo "ERROR (f57.21): unsupported build host uname -m '${arch}' — expected aarch64 or x86_64; refusing to guess the bd release asset (images/scotty/Dockerfile)" 1>&2; exit 1 ;; \
       esac \
    && tarball="beads_${BD_VERSION}_linux_${arch}.tar.gz" \
    && wget -q -O /tmp/checksums.txt "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/checksums.txt" \
    && wget -q -O "/tmp/${tarball}" "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/${tarball}" \
    && want="$(grep -F "${tarball}" /tmp/checksums.txt | cut -d' ' -f1)" \
    && [ -n "$want" ] || { echo "ERROR (f57.21): checksums.txt at bd ${BD_VERSION} has no entry for ${tarball} — refusing to install an unverified binary (images/scotty/Dockerfile)" 1>&2; exit 1; } \
    && got="$(sha256sum "/tmp/${tarball}" | cut -d' ' -f1)" \
    && [ "$want" = "$got" ] || { echo "ERROR (f57.21): sha256 mismatch for ${tarball}: want ${want}, got ${got} — refusing to install (images/scotty/Dockerfile)" 1>&2; exit 1; } \
    && tar -xzf "/tmp/${tarball}" -C /tmp \
    && mv /tmp/bd /usr/local/bin/bd.real \
    && rm -f "/tmp/${tarball}" /tmp/checksums.txt

# ── Eleventy: self-contained tree for the showcase publisher ─────────────────
# Upstream shape verbatim: the app locates node_modules/@11ty/eleventy/cmd.cjs
# by scanning the filesystem (lib/showcase/generate.ts) — never imported, so
# Next's standalone tracing does NOT include it. Install complete here and
# copy into the runner below (version kept in sync with upstream package.json).
FROM node:26.12.1-alpine AS eleventy
WORKDIR /eleventy
# markdown-it (pulled in transitively by eleventy) ships source maps containing
# a stock RFC1918 example literal. This stage installs without a lockfile, so
# the floating transitive version silently changes bytes: markdown-it@14.3.3
# (published 2026-10-16) tripped the fail-closed OCI content gate on both
# architectures (PR #62 CI run). Pin the newest release whose map bytes are
# already pinned in registrar/src/oci-gate/upstream-allowlist-data.gen.ts
# (14.3.0/14.3.1/14.3.2) so the gate's exact-artifact SHA check passes.
RUN npm install --no-save @11ty/eleventy@3.1.6 markdown-it@14.3.2

# ── Builder: scotty npm ci + build (upstream shape, 8ea-patched tree) ─────────
FROM node:26.12.1-alpine AS builder
WORKDIR /app
COPY --from=source /scotty/src/package.json /scotty/src/package-lock.json ./
RUN npm ci
# Release CVE gate: next 16.3.4 (scotty's upstream lock at cc55734) carries a
# fixable CRITICAL; 16.3.6 is the patch release that fixes it.
# 16.3.8 + sharp >= 0.35.5 (next's image optimizer dep): the fixable HIGHs
# reported 2026-10-20. sharp can't be a direct dependency (upstream's
# `overrides: { sharp: ^0.35.4 }` forbids it), so the lock is updated within
# that range and the result asserted.
RUN npm install --no-audit --no-fund --save-exact next@16.3.8 \
    && npm update --no-audit --no-fund sharp \
    && node -e 'const v=JSON.parse(require("fs").readFileSync("node_modules/sharp/package.json","utf8")).version.split(".").map(Number); if (v[0]!==0||v[1]!==35||v[2]<5) { console.error("sharp "+v.join(".")+" < 0.35.5"); process.exit(1); } console.log("sharp "+v.join("."))'
COPY --from=source /scotty/src/ ./
# Standalone output is opt-in upstream (next.config.ts); the image runs the
# standalone server. NEXT_STANDALONE=1 mirrors the upstream Dockerfile.
ENV NEXT_STANDALONE=1
RUN npm run build

# ── Runner: upstream shape + our wrapper layer ───────────────────────────────
FROM node:26.12.1-slim AS runner
WORKDIR /app
# Release CVE gate: the base image's pending Debian security fixes, and no
# npm/corepack in the runtime (it runs `node server.js`; npm's own bundled
# packages carry the base image's npm-side CVEs).
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
ENV PORT=3306
ENV HOSTNAME=0.0.0.0
ENV HOME=/home/nextjs
ENV XDG_CONFIG_HOME=/home/nextjs/.config
# Upstream user setup (uid/gid 1001, world-writable home/config so any
# --user remap can still write app settings — docker-base-image-builtin-user
# convention: keep the image's own user shape rather than forking it).
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --create-home --home-dir /home/nextjs nextjs \
 && mkdir -p /home/nextjs/.config \
 && chown -R nextjs:nodejs /home/nextjs \
 && chmod 0777 /home/nextjs /home/nextjs/.config
# Copy the standalone server, static assets, and public files (upstream
# order). Next's tracing puts a PARTIAL @11ty into the standalone
# node_modules; it would shadow the complete tree below (eleventyBin()
# checks cwd first) — drop it, then provide the full eleventy tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
RUN rm -rf ./node_modules/@11ty
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Eleventy for the showcase publisher; /node_modules sits on eleventyBin()'s
# upward search path and never collides with the standalone node_modules.
COPY --from=eleventy --chown=nextjs:nodejs /eleventy/node_modules /node_modules
# bd: real binary + the read-only wrapper in its default PATH slot. bd itself
# is glibc-linked (embedded Dolt, CGO) — slim (not alpine) runner, same as
# upstream.
COPY --from=bd /usr/local/bin/bd.real /usr/local/bin/bd.real
COPY --chown=nextjs:nodejs images/scotty/bd-readonly /usr/local/bin/bd
# f57.15: the join-config workspace BEADS_REPO points at (server-mode join to
# the dolt service — config-only, NEVER bd init inside the image; the
# project_id is the fleet contract set by the coordinator, see
# queue-join/metadata.json + docs/vs-queue-bootstrap.md).
COPY --chown=nextjs:nodejs images/common/queue-join /queue-join
RUN chmod 0755 /usr/local/bin/bd /usr/local/bin/bd.real
USER nextjs
EXPOSE 3306
CMD ["node", "server.js"]