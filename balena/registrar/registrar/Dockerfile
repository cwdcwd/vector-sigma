# Vector Sigma registrar-fleet: registrar image (vendored sources).
#
# Built by balena remote builders from a context confined to
# balena/registrar/registrar/ (balena compose build contexts must stay
# inside the app source dir), so the registrar + shared workspace
# sources are vendored here byte-for-byte, pinned by
# registrant/test/vendored-drift.test.ts in the root suite (CI fails
# on drift). Regenerate the copies on upstream change (see
# balena/devices/README.md for the recipe; same pattern).
#
# No lockfile: all dependencies are exact-pinned; @node-rs/argon2
# ships prebuilt platform binaries (npm fetches the linux-arm64-gnu
# optional package for aarch64 at install time), so `npm install` is
# deterministic enough for a tagged-release flow where the drift test
# pins every vendored byte and CI gates every tag.

# ---- build stage ------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json ./
COPY shared/package.json ./shared/
RUN npm install --no-audit --no-fund

COPY shared/tsconfig.json ./shared/
COPY shared/src/ ./shared/src/
RUN npm run build -w @vector-sigma/shared

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# ---- runtime stage -----------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json ./
COPY shared/package.json ./shared/
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/dist ./dist

# Migrations run on start when MIGRATE_ON_START=true (balena variable):
# drizzle's migrator reads ../drizzle relative to the compiled entrypoint.
COPY drizzle/ ./drizzle/

# Non-root runtime: base-image built-in node user (uid/gid 1000).
USER node

# Registrar serves :3000 on the fleet's private network; balena
# publishes no ports (devices reach it over the fleet's network).
EXPOSE 3000

CMD ["node", "dist/index.js"]