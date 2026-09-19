# balena/registrar — registrar-fleet app

The balena multi-container app for the **registrar fleet**: the Vector
Sigma registrar API + admin console, backed by its own Postgres, on one
dedicated balenaOS device (Raspberry Pi 5). Built by balena remote
builders when a `registrar-v*` tag is pushed (`deploy-registrar.yml`).
Deployed fleet: `g_c_d/vector-sigma-master`.

```
balena/registrar/
├── docker-compose.yml        # registrar + postgres
├── README.md
└── registrar/                 # VENDORED workspace sources (context dir)
    ├── Dockerfile            # multi-stage: build → runtime (non-root)
    ├── package.json          # exact-pinned deps, workspaces: shared
    ├── tsconfig.json
    ├── drizzle/              # migrations (MIGRATE_ON_START=true)
    ├── shared/               # vendored @vector-sigma/shared
    └── src/                  # vendored registrar sources
```

## Why the sources are vendored

Same constraint as [balena/devices/](../devices/README.md): balena
build contexts are confined to the app source dir, so the registrar +
shared sources live here byte-for-byte identical to the workspace
originals, pinned by `registrant/test/vendored-drift.test.ts` in the
root test suite. Regenerate on upstream change:

```bash
cp -f registrar/package.json balena/registrar/registrar/package.json  # then re-pin versions to the lockfile
cp -f registrar/tsconfig.json balena/registrar/registrar/tsconfig.json
cp -f shared/tsconfig.json balena/registrar/registrar/shared/tsconfig.json
cp -f shared/src/index.ts balena/registrar/registrar/shared/src/index.ts
cp -f registrar/src/*.ts balena/registrar/registrar/src/        # flat src/
cp -f registrar/src/db/*.ts balena/registrar/registrar/src/db/
cp -f registrar/drizzle/*.sql balena/registrar/registrar/drizzle/
cp -f registrar/drizzle/meta/* balena/registrar/registrar/drizzle/meta/
```

Note: the vendored `package.json` is NOT byte-identical to the
workspace one (the workspace manifest carries vitest/pg-mem/drizzle-kit
dev tooling the image does not need, and `workspaces` is scoped to the
vendored `shared/`); the drift test pins its dependency versions to
the root lockfile instead.

## Runtime configuration (service-scoped balena variables)

| Variable | Service | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | registrar | yes | `postgres://<user>:<password>@postgres:5432/<db>` — same Postgres role/database values the postgres service creates. |
| `POSTGRES_USER` | postgres | yes | Postgres superuser name created at first init of the data volume. |
| `POSTGRES_PASSWORD` | postgres | yes | Postgres password. Device-scoped balena variable. |
| `POSTGRES_DB` | postgres | yes | Database name. |
| `SESSION_SECRET` | registrar | yes | Admin-console HMAC session secret (≥16 chars). Device-scoped. |
| `MIGRATE_ON_START` | registrar | yes | Must be `true` — migrations run on boot. |
| `PORT` | registrar | no | Defaults to 3000. |
| `LOG_LEVEL` | registrar | no | Defaults to `info`. |
| `TRUST_PROXY` | registrar | no | `true` only if a reverse proxy sits in front (not in this LAN-only topology). |

The postgres service variables must agree with `DATABASE_URL`. The
registrar's admin console + API ride the same port (3000), published on
the device LAN interfaces.

## Failure domain & recovery

This device is the **identity source and the entire reflash-recovery
path**: a devices-fleet device without identity cannot recover until
this registrar returns (accepted residual — the registrar fleet exists
precisely to give it its own failure domain). Its Postgres data lives on
the balena named volume `pgdata` — survives container updates and host
OS updates. balenaOS host recovery does NOT preserve `pgdata` in every
disaster scenario: the registrar runbook covers a Postgres dump
cadence as an owner step.

## First flash

Per [balena-architecture.md](../../docs/balena-architecture.md): flash
the spare Pi 5 with the registrar-fleet image, pin the fleet at
provisioning, push the first `registrar-v*` tag (owner action), then
provision devices per the devices runbook.