# Vector Sigma registrar image — built from the workspace sources.
#
# Build context: the REPO ROOT (`docker build -f registrar/Dockerfile .`).
# One source of truth: registrar/ + shared/ are compiled directly, and
# dependencies come from the root package-lock.json (`npm ci`), so the
# image installs exactly what the workspace tests ran against. Same image
# for the balena registrar fleet, the self-host compose (platforms/compose/), and E2E.
#
# Shipped scope: the runtime service only. The CI tooling that lives in
# this workspace (credential scanner, OCI content gate, GHCR promoter) is
# excluded at COPY time, so it is never even build input: the per-image
# credential scan (scripts/image-catalog.mjs inputs) skips exactly these
# paths, and registrar/test/image-build-config.test.ts proves no shipped
# module imports them.

# ---- build stage ------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first (layer-cache friendly). Every workspace manifest is
# present so `npm ci` can validate the lockfile; only the two workspaces
# this image needs are installed.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY registrar/package.json registrar/
COPY registrant/package.json registrant/
RUN npm ci --no-audit --no-fund -w @vector-sigma/shared -w @vector-sigma/registrar

COPY shared/tsconfig.json shared/
COPY shared/src/ shared/src/
RUN npm run build -w @vector-sigma/shared

COPY registrar/tsconfig.json registrar/
COPY --exclude=credential-scan --exclude=oci-gate --exclude=registry registrar/src/ registrar/src/
RUN npm run build -w @vector-sigma/registrar

# ---- runtime stage -----------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

# fleet-ops-1py.14 round 7b: npm's download cache must NOT ship in the
# published image (its content-addressed blobs embed the full text of every
# fetched registry artifact). Cache in /tmp and rm it in the SAME RUN.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY registrar/package.json registrar/
COPY registrant/package.json registrant/
RUN npm ci --omit=dev --no-audit --no-fund -w @vector-sigma/shared -w @vector-sigma/registrar \
      --cache /tmp/.npm-build-cache \
    && rm -rf /tmp/.npm-build-cache /root/.npm

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/registrar/dist registrar/dist

# Migrations run on start when MIGRATE_ON_START=true: drizzle's migrator
# reads ../drizzle relative to the compiled entrypoint (registrar/drizzle).
COPY registrar/drizzle/ registrar/drizzle/

# Non-root runtime: base-image built-in node user (uid/gid 1000).
USER node
WORKDIR /app/registrar

# Container listens on :3000; the balena compose publishes 127.0.0.1-only.
EXPOSE 3000

CMD ["node", "dist/index.js"]
