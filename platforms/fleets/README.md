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
4. Deploy with the existing release path, unchanged: push a `registrar-v*` or
   `devices-v*` tag (`.github/workflows/release-registrar.yml` / `release-devices.yml`).
   Point those apps at the new instance's dashboard variables, never at the
   production apps.

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
