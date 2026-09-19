# vector-sigma

> *"Before Cybertron's fall, every new robot passed through Vector Sigma."*

Device identity registrar for autonomous agent fleets. Named for the G1
Transformers supercomputer that imparted personality to every new robot —
this is that, for devices: a fleet device boots empty, calls home, and
receives the complete identity bundle that makes it *itself*.

## What it does

- **Registrar** — REST service (TypeScript · Fastify · Node.js · Postgres)
  that stores per-device identity bundles and delivers them exactly once
  at first boot. Two-factor device auth, one-shot delivery slots, hashed
  keys, append-only audit log. Ships with a lightweight admin console for
  editing bundles without touching the database.
- **Registrant** — the device-side caller (TypeScript, own container).
  Clock gate → identity check → registrar call → 0600 bundle write →
  config assembly → ready marker → stays resident as the rotation watcher.
- **Balena device app** — docker-compose multi-container app for
  balenaOS devices: agent runtime container + registrant, sharing a
  persistent data volume. No identity = no agent start.
- **Self-host deploy example** — registrar + Postgres compose for any
  single host.

## Design principles

- **Identity lives in the data partition.** A device is its state volume;
  the container is disposable wrapping. Reflash → re-fetch → the device
  is itself again, unattended.
- **Secrets are delivered, never baked.** No secrets in image layers, in
  build args, or in platform variables beyond each device's own bootstrap
  key.
- **Delivery-only API.** The registrar hands out identity bundles; it
  never mints upstream credentials. Those stay with the operator at their
  sources.
- **Everything is config-driven.** No hostnames, agent names, or
  deployment specifics in code. Point a device at any registrar with
  `REGISTRAR_URL`.

## Repository layout

```
registrar/    # Fastify service: bootstrap API + admin console + DB
registrant/   # device-side caller + rotation watcher
shared/       # bundle-contract types shared by both ends
balena/       # two fleet apps: balena/registrar/ + balena/devices/
deploy/       # generic self-host example (registrar + postgres)
docs/         # engineering spec + balena architecture
```

## Status

Registrar skeleton, registrant, admin console, and the self-host deploy
example + simulated-device E2E are merged. Next: the two-fleet balena
deployment ([docs/balena-architecture.md](docs/balena-architecture.md))
and its GitHub Actions pipelines — the **devices-fleet app ships in this
repo** ([balena/devices/](balena/devices/README.md)), with the owner
runbook ([docs/balena-devices-runbook.md](docs/balena-devices-runbook.md))
and canary checklist
([docs/balena-devices-canary-checklist.md](docs/balena-devices-canary-checklist.md));
the registrar-fleet app is a separate deliverable.

Engineering spec: [docs/engineering-spec.md](docs/engineering-spec.md).

## License

MIT (code); docs CC-BY-4.0.