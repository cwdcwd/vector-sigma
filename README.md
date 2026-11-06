# vector-sigma

> *"Before Cybertron's fall, every new robot passed through Vector Sigma."*

Vector Sigma is an **agentic software factory**: a platform where AI agents
can take software work from a queued task through implementation, testing,
review, and release. Humans set priorities, permissions, and approval
boundaries; agents do the repeatable engineering work and leave evidence at
each handoff.

The factory is more than an agent runtime or an identity registrar. It brings
together the agent fleet, a work queue and routing pipeline, the tools and
identity agents need, shared software repositories, and a build-and-release
system that tests and promotes the exact artifacts it deploys.

Named for the G1 Transformers supercomputer that imparted personality to
every new robot, Vector Sigma also handles the identity side of the factory:
a fleet device boots empty, calls home, and receives the complete identity
bundle that makes it *itself*.

## How the factory works

1. **Work is queued** in the Vector Sigma fleet's own Beads queue and grouped
   by project. The queue router assigns eligible work to configured developer,
   test, and review stages; owner-call work stays with the owner.
2. **Agents build and verify** changes in project repositories, recording
   commands, results, and handoff evidence with the work item. Human-set
   trust, review, and deployment gates remain in force.
3. **CI builds the software** from the repository's image catalog, scans and
   tests those exact image bytes, and promotes them by digest. Release jobs
   reuse the verified images rather than rebuilding them.
4. **Platform adapters deploy** the approved artifacts to their target
   environments. The adapter boundary keeps software images separate from
   platform-specific wiring and runtime configuration.

See [docs/queue-conventions.md](docs/queue-conventions.md),
[docs/vs-hub-router.md](docs/vs-hub-router.md), and
[docs/image-pipeline.md](docs/image-pipeline.md) for the operating details.

## What it provides

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
registrar/    # Fastify service: bootstrap API + admin console + DB (+ its Dockerfile)
registrant/   # device-side caller + rotation watcher (+ its Dockerfile)
shared/       # bundle-contract types shared by both ends
images/       # every other image: one dir per images.json component;
              #   images/common/ = boot hooks, CLIs, plugin baked into several images
images.json   # THE image list: CI builds, scans, E2Es and promotes exactly these
stack/        # THE stack definitions (which images run together, how wired);
              #   rendered into each platform by scripts/render-stack.mjs
platforms/    # where those images run — one adapter per deploy target
  balena/     #   registrar + devices fleet apps (live)
  compose/    #   plain Docker Compose on any host (self-host)
  agentcore/  #   Amazon Bedrock AgentCore (design)
test/e2e/     # compose-simulated fleet E2E, run on the exact CI-built bytes
scripts/      # repo tooling: image catalog, scans, promote, release render
docs/         # engineering spec, runbooks, conventions (some baked into images)
```

Images are platform-neutral; a platform is only *how* they are run and
configured. See [platforms/README.md](platforms/README.md) for the adapter
contract (and what adding AWS AgentCore will take).

## Where it runs today

The platform-neutral images and stack definitions are deployed through
platform adapters:

- **Balena registrar fleet** — the control plane, including the registrar,
  gateway, queue services, and Primus coordinator.
- **Balena devices fleet** — agent runtimes enrolled and configured by the
  registrar.
- **Docker Compose** — a supported self-host deployment and the basis of
  the simulated-fleet end-to-end test.
- **Amazon Bedrock AgentCore** — an adapter design, not a deployed
  environment.

See [platforms/README.md](platforms/README.md) for adapter status and
[docs/engineering-spec.md](docs/engineering-spec.md) for the component
contracts. The registrar, registrant, and admin console are factory
infrastructure: identity provisioning is one part of Vector Sigma, not the
whole product.

## License

MIT (code); docs CC-BY-4.0.