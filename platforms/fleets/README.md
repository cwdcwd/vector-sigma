# platforms/fleets — per-fleet deployment config (first cut)

One JSON file per fleet instance. It selects a target (`aws` or `balena`), pins
the promoted image digests from `images.json`, and names the instance's own
endpoints. It holds **no secrets**: the validator rejects credential-shaped
keys. Secrets come from the platform (Secrets Manager / AgentCore Identity for
AWS; balenaCloud dashboard variables for Balena).

Design source: [`docs/plans/agentcore-platform-plan.md`](../../docs/plans/agentcore-platform-plan.md)
(fleet-ops-210.1). Scope is docs, config and validation only. Nothing here
deploys, touches AWS, or changes an existing Balena fleet.

## Files

| Path | Purpose |
|---|---|
| `scripts/fleet-deploy-plan.mjs` | Dry-run Balena deploy plan for a deployable config's own apps (prints commands, executes nothing). |
| `scripts/fleet-config.mjs` | Validator. `node scripts/fleet-config.mjs <fleet.json>` exits 1 on error. |
| `examples/aws-fleet.example.json` | Sample AWS instance (`status: example`). |
| `examples/balena-fleet.example.json` | Sample Balena instance (`status: example`). |
| `registrar/test/fleet-config.test.ts` | Vitest coverage of the validator rules. |

## Config fields

- `fleet_id`: stable name, `^[a-z][a-z0-9-]{1,38}$`. Drives naming and tags.
- `status`: `deployable` (default) or `example`. Examples may use placeholder
  digests and are never deployed. A deployable config must pin real digests.
- `target`: `aws` or `balena`. Exactly one of the `aws` / `balena` blocks is allowed.
- `images`: component → `sha256:` digest. Must include `registrar`, `registrant`,
  `agent`, `hermes`, `litellm`, `scotty`. Each name must be an `images.json` component.
- `endpoints`: `registrar_url`, `gateway_url`, `queue_url` (https, instance-unique).
- `database`: `{"kind":"rds-postgres","endpoint":"<host>.rds.amazonaws.com"}` for
  AWS, or `{"kind":"container"}` for Balena.
- `aws`: `account` (12 digits), `region`, `agentcore_runtime`, `ecs_cluster`.
- `balena.fleets`: `registrar` and `devices` app names (`<org>/<app>`). Existing
  production apps (`g_c_d/vector-sigma`, `g_c_d/vector-sigma-master`) are refused.
- `last_known_good` (optional): the digest set to re-pin on rollback.

## Run / validate

```sh
node scripts/fleet-config.mjs platforms/fleets/examples/*.json
cd registrar && npx vitest run test/fleet-config.test.ts
```

## Build and deploy the Balena test fleet (no existing behavior changes)

1. Copy a Balena example to a new file and set a new `fleet_id` plus its own
   `balena.fleets` apps. Do not reuse production app names.
2. Pin real promoted digests in `images` (from `images.json` promotion records).
   Set `status` to `deployable` only after this.
3. Validate with the command above.
4. Deploy. The `registrar-v*` / `devices-v*` tag workflows are NOT an isolated path:
   they deploy only to the repository variables `vars.REGISTRAR_FLEET` and
   `vars.DEVICES_FLEET` and ignore `balena.fleets`. Do not push a release tag to
   reach a new instance. Use this fleet-safe path instead (no CI, no tag, no
   network writes until step c):

   a. Build the digest-pinned release bundles from the promotion records of an
      already-published `main` run. Download the `promoted-<component>` artifacts
      for that run into `<records>/`. Then render both apps from those records.
      The renderer pins from the records and resolves nothing:

      ```sh
      node scripts/render-release-compose.mjs --app registrar --registry-owner cwdcwd \
        --repo vector-sigma --records-dir <records> --out release/registrar
      node scripts/render-release-compose.mjs --app devices --registry-owner cwdcwd \
        --repo vector-sigma --records-dir <records> --out release/devices
      ```

      Each run writes `release/<app>/docker-compose.yml` and a provenance file.
      Do not hand-edit the compose; a missing record makes the render fail closed.

   b. Print the deploy plan for this instance's own apps:

      ```sh
      node scripts/fleet-deploy-plan.mjs platforms/fleets/<fleet>.json \
        --release <32-hex-release-id> --source-dir release
      ```

      The `--release` id is the commit that `balena deploy` prints. You do not have
      it until step c has run, so pass a placeholder id for this dry run, or
      rerun the planner after the deploys with the real id. The planner refuses
      example, non-balena, invalid and production-app configs, and it executes nothing.

   c. Run the two `balena deploy` commands from the plan by hand, with the
      `--source` directories from `release/`. Read the release id each deploy
      prints. Then run the two `balena fleet pin` commands with that id. The
      existing workflows and the production variables are unchanged.

## AWS (not deployable yet)

The AWS target is validated and documented only. Deployment waits for an
isolated dev account and a written deploy go (plan gates G1/G2). Existing
AgentCore/CDK code lives in `platforms/agentcore/` and is reused as-is. The
ECR mirror remains dry-run (`scripts/ecr-mirror-plan.mjs`).

## Rollback

- Rollback is by digest, not by rebuild. Re-pin `images` to `last_known_good`,
  validate, then redeploy the same bytes through the existing release path.
- Balena: roll back through the app's own release history.
- AgentCore: re-point the endpoint to the previous runtime version.
- Database rollback is never implied by an image rollback. It needs a separate owner decision.
