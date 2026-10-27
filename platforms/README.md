# platforms/ — where Vector Sigma runs

Vector Sigma is split into three layers:

- **What runs** is platform-neutral: the images listed in
  [`images.json`](../images.json), built from `registrar/`, `registrant/` and
  `images/<component>/`. CI builds each one once, scans it, runs the E2E on
  those exact bytes and promotes them to GHCR by digest
  (`.github/workflows/_images.yml`). No image knows which platform it is on;
  everything platform-specific arrives as environment and delivered bundles.
- **What runs together** is a stack: [`stack/registrar.yaml`](../stack/registrar.yaml)
  defines the registrar stack once. `scripts/render-stack.mjs` renders it
  into each compose-shaped adapter (`platforms/compose/compose.yaml`,
  `platforms/balena/registrar/docker-compose.yml`); the spec's `x-compose` /
  `x-balena` blocks are the only places they differ, and CI fails if a
  rendered file is stale. A new compose-shaped platform is a new renderer
  target; a non-compose one (AgentCore) reads the same spec.
- **How it runs** is a platform adapter, one directory per deploy target
  under `platforms/`. An adapter owns only deployment configuration: which
  images run together, their wiring, volumes, network edge and how secrets
  reach them. It never builds or vendors image sources.

| Adapter | Status | Runs |
|---|---|---|
| [`balena/registrar`](balena/registrar/README.md) | live | the master device: registrar, postgres, gateway, queue, primus, serve edge |
| [`balena/devices`](balena/devices/README.md) | live | each agent device: agent runtime, registrant, serve edge |
| [`compose`](compose/README.md) | supported | the registrar stack on any Docker host; also the base of the CI E2E |
| [`agentcore`](agentcore/README.md) | design | agent/primus runtime on Amazon Bedrock AgentCore Runtime; design only, no deploys |

## The adapter contract

An adapter is correct when:

1. **It consumes promoted images by digest or commit-SHA tag.** Never a
   floating tag and never a local build in a release path. For balena,
   `scripts/render-release-compose.mjs` rewrites each `build:` block to its
   GHCR digest from the promotion records.
2. **It delivers secrets at runtime.** Platform variables, `.env` or a secret
   manager. Never image layers or build args.
3. **It keeps the env contract.** Each service reads the same variables
   whatever the platform (see the service READMEs and `.env.example`). If an
   adapter needs a new variable, it goes in the image's contract first.
4. **Its stack is covered by a test.** Compose-shaped adapters are checked
   by `registrar/test/` contract tests and the compose E2E.

## Adding AWS AgentCore (next)

AgentCore Runtime hosts agent containers, so the natural first cut is the
**agent** image (and primus) on AgentCore, with the registrar stack staying
on a compose-shaped platform. Expect the adapter to need:

- an **ECR mirror** of the promoted digests (AgentCore pulls from ECR),
  copied by digest so the scanned bytes are what runs;
- **arm64** images, which the catalog already builds;
- an **entrypoint shim** for AgentCore's HTTP/A2A invocation contract,
  added to `images/agent/` behind an env switch, so the image stays one
  artifact for every platform;
- **identity delivery** through AWS (for example, Secrets Manager read
  by the registrant) in place of the balena device bootstrap key;
- a **deploy definition** (CDK or similar) under `platforms/agentcore/`
  plus a release workflow beside the balena ones.

Check the current AgentCore Runtime documentation for its exact port,
protocol and architecture requirements when building it; they're
summarized here only to size the work.

The adapter design (boundary, protocol choice, IAM separation, open
questions) is worked out in [`agentcore/README.md`](agentcore/README.md);
the implementation itself is a separate bead.
