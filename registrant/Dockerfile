# Vector Sigma registrant image — built from the workspace sources.
#
# Build context: the REPO ROOT (`docker build -f registrant/Dockerfile .`).
# ONE image for both fleets: the devices fleet's `registrant` service and the
# registrar (master) fleet's `registrant-own` service (fleet-ops-f57.14 — the
# master bootstraps its own identity through the same chain every device
# uses). Dependencies come from the root package-lock.json (`npm ci`).

# ---- build stage: full deps + compile --------------------------------
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY registrar/package.json registrar/
COPY registrant/package.json registrant/
RUN npm ci --no-audit --no-fund -w @vector-sigma/shared -w @vector-sigma/registrant

COPY shared/tsconfig.json shared/
COPY shared/src/ shared/src/
RUN npm run build -w @vector-sigma/shared

COPY registrant/tsconfig.json registrant/
COPY registrant/src/ registrant/src/
RUN npm run build -w @vector-sigma/registrant

# ---- runtime stage: prod deps + built output only ---------------------
FROM node:22.23.4-bookworm-slim
WORKDIR /app

# fleet-ops-1py.14 round 7b: npm's download cache never reaches a published
# layer. Cache in /tmp, rm both in the SAME RUN.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY registrar/package.json registrar/
COPY registrant/package.json registrant/
RUN npm ci --omit=dev --no-audit --no-fund -w @vector-sigma/shared -w @vector-sigma/registrant \
      --cache /tmp/.npm-build-cache \
    && rm -rf /tmp/.npm-build-cache /root/.npm

# Release CVE gate (trivy, fixable CRITICAL blocks): take the base image's
# pending Debian security fixes, and drop npm/corepack — the runtime is
# `node dist/index.js`, never npm, and npm's own bundled packages are where
# the base image's npm-side CVEs live.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/registrant/dist registrant/dist

# fleet-ops-1py.4: build-epoch for the HostClockProbe's wall-clock
# plausibility signal (clock-gate.ts): image build time in ms since epoch.
RUN date +%s000 > /app/build-epoch

# Data-volume mountpoint: fresh named volumes seed ownership from the image
# path; owned by the base image's built-in node user (uid/gid 1000) so the
# non-root registrant can write the 0600 bundle + ready marker.
RUN mkdir -p /data/agent && chown -R node:node /data/agent

# f57.13: CA shim — decodes VS_CA_CERT_B64 (the fleet variable carrying an
# internal CA) into NODE_EXTRA_CA_CERTS before the registrant starts. A no-op
# when no CA variables are set.
COPY images/common/hooks/vs-entrypoint.sh /usr/local/bin/vs-entrypoint.sh
RUN chmod 0755 /usr/local/bin/vs-entrypoint.sh

USER node
WORKDIR /app/registrant

ENTRYPOINT ["/usr/local/bin/vs-entrypoint.sh"]
CMD ["node", "dist/index.js"]
