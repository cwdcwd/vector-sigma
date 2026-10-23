# images/seed/Dockerfile — the E2E seed harness (test/e2e/compose.e2e.yaml `seed`).
#
# Test tooling only, never published: the seed provisions the deterministic
# E2E devices, bundles and keys straight into the registrar's database, so it
# needs the full workspace sources + dev dependencies (tsx). Every service
# that SHIPS runs its own images.json image (registrar/Dockerfile,
# registrant/Dockerfile, the balena/ Dockerfiles) — in CI, the exact scanned
# bytes that get promoted.
#
# Context is the REPO ROOT (compose.e2e.yaml sets build.context: ..).
FROM node:22.23.4-bookworm-slim

WORKDIR /app

# Root lockfile + workspaces first (layer-cache friendly), then sources.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY registrar/package.json registrar/
COPY registrant/package.json registrant/
RUN npm ci

COPY shared/ shared/
COPY registrar/ registrar/
COPY registrant/ registrant/
COPY test/e2e/tsconfig.json test/e2e/
COPY test/e2e/seed/ test/e2e/seed/

RUN npm run build

USER node
CMD ["node", "--import", "tsx", "test/e2e/seed/seed.ts"]
