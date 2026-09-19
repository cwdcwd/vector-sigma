# balena/devices — devices-fleet app

The balena multi-container app for the **devices fleet**: agent runtime
+ registrant sharing the persistent `agent-data` volume. Built by
balena remote builders when a `devices-v*` tag is pushed
(`deploy-devices.yml`). Deployed fleet: `g_c_d/vector-sigma`.

```
balena/devices/
├── docker-compose.yml   # agent + registrant, shared volume, healthchecks
├── agent/
│   ├── Dockerfile       # placeholder runtime image (swap point)
│   └── gate.sh          # blocks on /data/agent/ready.marker, then execs
├── registrant/          # VENDORED workspace sources (see below)
│   ├── Dockerfile       # multi-stage: build → runtime (non-root)
│   ├── package.json     # exact-pinned deps, workspaces: shared
│   ├── tsconfig.json
│   ├── shared/          # vendored @vector-sigma/shared (types + zod)
│   └── src/             # vendored registrant sources
└── README.md
```

## Why the sources are vendored

balena build contexts are **confined to the app source dir** —
`build.context` must point inside the app (`docs.balena.io/reference/
supervisor/docker-compose`), and this dir is what the deploy workflow
uploads to the remote builders. The registrant + shared sources
therefore cannot reference `../../registrant` the way `deploy/`'s
compose does.

Instead, the sources live here **byte-for-byte identical** to the
workspace originals, pinned by `registrant/test/vendored-drift.test.ts`
in the root test suite (CI fails on drift). To change the registrant:
edit the workspace copy, then regenerate:

```bash
cp registrant/src/*.ts balena/devices/registrant/src/
cp registrant/tsconfig.json balena/devices/registrant/tsconfig.json
cp shared/src/index.ts balena/devices/registrant/shared/src/
cp shared/tsconfig.json balena/devices/registrant/shared/tsconfig.json
```

## Why no package-lock.json

Every dependency retained in the vendored manifest is zero-transitive —
`zod`, `@types/node`, `typescript` resolve to no dependencies of their
own (verified against the root lockfile), and `@vector-sigma/shared`
is vendored adjacent as a `file:` workspace. A lockfile would be
dead weight duplicating what the exact version pins already guarantee;
`npm install` here is deterministic without one. The drift test pins
the versions match the root lockfile.

## Runtime configuration

No `environment:` entries — balena compose performs **no variable
substitution**, and every runtime value arrives as a balenaCloud
dashboard variable (`REGISTRAR_URL`, `REGISTRAR_KEY` per device;
`BALENA_DEVICE_UUID` auto-injected). The full table:
[balena-devices-runbook.md](../docs/balena-devices-runbook.md).

## Layout constraints honored

- compose-file **v2.4** semantics (balena's base): no v3 fields used;
  `depends_on` is not used at all (the supervisor orders container
  starts itself, and the agent's gate makes ordering explicit anyway).
- **Named volume only** (`agent-data`) — no bind mounts.
- Healthchecks are **process liveness** (`kill -0 1`): they catch
  alive-but-broken containers and exec-arch mismatches, but never gate
  on the ready marker (an unprovisioned device legitimately has none).
- Images ship `/data/agent` pre-created owned by uid/gid 1000 so a
  fresh named volume seeds node-user ownership (the registrant runs
  non-root and must write the 0600 bundle + marker).
- Update strategy: balena default (`download-then-kill`), generous
  `stop_grace_period` (60s agent / 30s registrant) for SIGTERM/WAL
  evidence standard.