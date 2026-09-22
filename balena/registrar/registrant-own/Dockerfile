# Vector Sigma registrar-fleet: registrant-own image (vendored sources).
#
# fleet-ops-f57.14: the master device's OWN registrant — the dogfood
# proof. primus (the VS coordinator Hermes) bootstraps its identity
# through the SAME chain every device uses: this registrant polls the
# compose-internal registrar (http://registrar:3000 pre-TLS by the
# bead's contract; flips to https with the Caddy edge exactly like the
# devices fleet) and applies the owner-prepared primus bundle to the
# shared primus-data volume.
#
# This image is built by balena remote builders from a context CONFINED
# to balena/registrar/registrant-own/ (balena compose build contexts
# must stay inside the app source dir), so the registrant + shared
# workspace sources are vendored here byte-for-byte.
# registrant/test/vendored-drift.test.ts (root suite, runs in CI) pins
# that: it fails when the vendored copies drift from the workspace
# originals. Regenerate the copies on upstream change.
#
# No lockfile: every dependency retained here is zero-transitive
# (zod, @types/node, typescript — verified in the root lockfile), so
# `npm install` is deterministic without one. See README.md.

# ---- build stage: full deps + compile --------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Vendored manifests first (layer-cache friendly), then sources.
COPY package.json ./
COPY shared/package.json ./shared/
RUN npm install --no-audit --no-fund

COPY shared/tsconfig.json ./shared/
COPY shared/src/ ./shared/src/
RUN npm run build -w @vector-sigma/shared

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# ---- runtime stage: prod deps + built output only ---------------------
FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json ./
COPY shared/package.json ./shared/
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/dist ./dist

# Data-volume mountpoint: fresh named volumes seed ownership from the
# image path; owned by the base image's built-in node user (uid/gid
# 1000 — fleet convention docker-base-image-builtin-user) so the
# non-root registrant can write the 0600 bundle + ready marker.
RUN mkdir -p /data/agent && chown -R node:node /data/agent

# f57.13: CA shim twin (byte-identical to deploy/vs-entrypoint.sh — pinned
# by registrant/test/vendored-drift.test.ts). Decodes VS_CA_CERT_B64 (the
# devices-fleet variable carrying the VS internal CA) into
# NODE_EXTRA_CA_CERTS before the registrant starts. A no-op on the
# compose-internal http URL today; the https flip provisions the CA on
# this fleet exactly as on the devices fleet.
COPY vs-entrypoint.sh /usr/local/bin/vs-entrypoint.sh
RUN chmod 0755 /usr/local/bin/vs-entrypoint.sh

USER node

ENTRYPOINT ["/usr/local/bin/vs-entrypoint.sh"]
CMD ["node", "dist/index.js"]