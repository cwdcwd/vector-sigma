# Vector Sigma registrar — self-host deploy example image.
#
# One image, three entrypoints (see deploy/README.md):
#   registrar:  node registrar/dist/index.js
#   seed:       node --import tsx deploy/seed/seed.ts   (E2E harness only)
#   device:     node registrant/dist/index.js  (compose-simulated device)
#
# Context is the REPO ROOT (docker compose sets it via build.context),
# because the seed needs registrar/ sources and the image needs all three
# workspaces built by the root npm workspaces install.
FROM node:22-bookworm-slim

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
COPY deploy/tsconfig.json deploy/
COPY deploy/seed/ deploy/seed/

RUN npm run build

# registrar listens here; the compose file publishes 127.0.0.1-only.
EXPOSE 3000

# Non-root runtime user: the ready marker + bundle files live on a volume
# owned by this uid/gid pair. The official node image already ships a `node`
# user at uid/gid 1000, so we reuse it — provisioning a second user at the
# same id can only ever fail (groupadd -g 1000: GID 1000 exists, exit 4).
# The device data volume mounts here. The mountpoint must exist in the image
# owned by node: a fresh named volume initializes from the image path's
# ownership (root-owned otherwise — the non-root registrant could not write
# its bundle).
RUN mkdir -p /data/agent && chown -R node:node /data/agent
USER node

CMD ["node", "registrar/dist/index.js"]