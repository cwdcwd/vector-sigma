# `platforms/agentcore` — Amazon Bedrock AgentCore Runtime adapter (design)

**Status: design only.** This directory records the deployment boundary and
security design for a future AgentCore adapter. It does not contain deployable
CDK, workflow, or AWS account configuration. The separate implementation
bead owns the TypeScript CDK adapter; this document deliberately makes no
account-specific claims and authorizes no deployment.

This follows the repo's own adapter contract: `platforms/README.md` sketches
the expected AgentCore cut — an ECR mirror of the promoted digests, arm64
images, an entrypoint shim behind an env switch, identity delivery through
AWS, and a deploy definition under this directory. This document works out
that sketch's boundary, protocol choice, IAM separation, and open questions;
it deliberately stops short of implementation and deployment claims.

## Adapter boundary

Vector Sigma separates platform-neutral images and services from the platform
that runs them. This adapter targets only the Hermes agent runtime image used
by a device agent or Primus, after its entrypoint, HTTP protocol, health, and
identity-delivery compatibility has been implemented and tested. AgentCore
Runtime hosts the agent container. The adapter is responsible for defining
its runtime, endpoint, protocol/authentication configuration, networking,
execution role, and how a verified image artifact is supplied to AWS.

The release path must preserve the existing image provenance contract:
consume the CI-scanned, promoted image bytes, pinned by immutable digest;
never build an unreviewed local image or use a floating tag for a release.
If the existing GHCR artifact must be copied to ECR, that copy must be
verified by digest so the image reviewed and scanned is the image deployed.
The exact cross-registry mechanism is a design decision for the CDK
implementation, not a capability asserted here.

AgentCore Runtime is not a Docker Compose or Balena application host. The
registrar control plane and supporting stateful services remain on the
existing compose-shaped platform (Compose or Balena, according to deployment).
In particular, the adapter does not migrate or replace:

- the registrar, its PostgreSQL database, or its migrations;
- the LiteLLM gateway and model-provider configuration;
- the Dolt queue and Scotty dashboard;
- the registrant bootstrap service or its device-volume/bundle lifecycle;
- the tailscale serve edge and its fleet-specific DNS/network wiring;
- the Balena registrar or device applications, release processes, or fleets.

No Balena files or deployment behavior change as part of this adapter. Any
future transition of a device from Balena to AgentCore, changes to the
registrar's identity protocol, or changes to fleet traffic require separately
scoped implementation and owner authorization.

| Component | Placement in this design | Notes |
|---|---|---|
| Hermes agent / Primus runtime | AgentCore Runtime candidate | Requires an explicitly implemented and tested AgentCore protocol adapter; not assumed compatible as-is. |
| Registrar + PostgreSQL | Existing Compose/Balena stack | Remains the authority for device records and delivered bundles. |
| Registrant | Existing Compose/Balena stack | No AWS credential or AWS account access is introduced into this service by this design. |
| LiteLLM, Dolt, Scotty, tailscale edges | Existing Compose/Balena stack | No migration or replacement is in scope. |

## AgentCore Runtime contract to design against

AWS currently documents multiple protocol contracts, with different ports and
paths; the adapter must choose and configure one protocol explicitly. Do not
mix protocol contracts or infer a port from the chosen agent framework.

| AWS Runtime protocol | Container listener | Contract entry point | Container requirements |
|---|---:|---|---|
| HTTP | `0.0.0.0:8080` | `POST /invocations`; `GET /ping`; optional `/ws` | Linux ARM64 container; request/response JSON or SSE as supported by the application. |
| MCP | `0.0.0.0:8000` | `/mcp` | Streamable HTTP transport; AWS recommends stateless operation by default and defines session-header behavior. |
| A2A | `0.0.0.0:9000` | Root path `/`; Agent Card at `/.well-known/agent-card.json` | Stateless, streamable HTTP / JSON-RPC contract. |

These are AWS's documented contracts, not a claim that the current Vector
Sigma agent image implements any of them. The current image's A2A wiring and
Balena serve configuration are not by themselves proof of AgentCore
compatibility. The adapter implementation must select the intended contract,
ensure the container listens on the required interface and port, implement
health and invocation semantics, and test those against AWS's current
contract before proposing a deployment. The HTTP contract also documents
ARM64 as a container requirement. The selected runtime compute/platform
version and any later changes in AWS requirements must be verified at
implementation time.

AgentCore Runtime is a managed runtime boundary: AWS documents versioned
runtime configurations and endpoints, session isolation, and invocation via
AgentCore APIs. Runtime versions/endpoint rollout, session lifetime and
persistence semantics, supported Regions, networking, and operational limits
must be selected deliberately; ephemeral runtime session state must not
replace Vector Sigma's registrar database or any required durable state.

## Identity and secret delivery

Do not give the registrant a Secrets Manager credential and do not bake
credentials into an image, CDK context, build argument, user data, or logs.
The design separates three identity planes:

Note: `platforms/README.md` floats an example of identity delivery through AWS
(a Secrets Manager read by the registrant) replacing the balena device
bootstrap key. This design deliberately diverges from that example: the
runtime's outbound credentials run through AgentCore Identity instead, the
registrant stays registrar-configured, and no service outside the deployment
principal and the runtime execution role holds any AWS account access.
Moving any bootstrap identity to Secrets Manager would need a separate,
owner-approved design change.

1. **Deployment/control plane:** an authorized deployment principal creates
   or updates only the named AgentCore runtime, endpoint and supporting
   resources, and passes only the named runtime execution role. This is an
   operator/CI identity, never the agent's runtime identity.
2. **Inbound invocation:** callers receive only the invoke permission needed
   for the selected runtime/endpoint. Configure AgentCore's inbound
   authentication and resource policies to restrict trusted callers; do not
   grant broad runtime invocation or user-delegation permissions by default.
3. **Agent outbound credentials:** register OAuth client credentials or API
   keys with AgentCore Identity, using its documented Secrets Manager-backed
   credential-provider flow where appropriate. The secret is stored/referenced
   in Secrets Manager and managed by AgentCore Identity; the runtime requests
   the appropriate identity token/credential through the supported Identity
   integration. Application code receives only the credential material
   required for its outbound call, not AWS Secrets Manager access. Use the
   runtime workload identity and scope any access to the specific provider and
   secret. This is separate from the existing registrar-delivered bundle and
   does not replace device bootstrap identity.

This is a design direction, not a statement that Vector Sigma's current
registrant, Hermes hooks, or image already implement AgentCore Identity. The
implementation must identify which existing bundle values map to an outbound
credential provider, how rotation/revocation works, and whether any service
actually needs direct Secrets Manager access. Grant no direct access unless a
separately reviewed requirement proves it necessary.

## Least-privilege IAM design matrix

The policy below is a role separation and scope plan, not a ready-to-apply IAM
policy. Exact action names and resource-level support must be checked against
the current AWS IAM reference and the chosen runtime configuration at
implementation time. Where AWS requires `Resource: "*"`, constrain the action
with documented conditions and the narrowest practical policy boundary.

| Principal / role | Minimum intended permissions | Resource boundary / exclusions |
|---|---|---|
| Deployment principal (human or CI) | AgentCore control-plane create/update/describe operations for the named runtime and endpoint; `iam:PassRole` for the single runtime execution role; only the image-publication permissions needed for the chosen ECR copy/build path; narrowly scoped role-policy management only if the CDK deployment owns those resources. | Restrict control-plane resources to the named runtime/endpoint where AWS supports resource scoping. Constrain `iam:PassRole` to the runtime role and `iam:PassedToService` to the AgentCore service principal when supported. No broad administrator or `*` pass-role grant. Separate IAM provisioning from routine deploy if possible. |
| Runtime execution role (assumed by AgentCore Runtime) | AWS-documented runtime logging/metrics/tracing permissions required by the selected observability features; `bedrock:InvokeModel` / streaming only if the agent calls Bedrock; documented AgentCore Identity workload-token action(s) only if outbound identity is used. | Trust only the documented AgentCore Runtime service principal. Scope log resources to the runtime log group/streams, model permissions to the selected model resources, and Identity permissions to the runtime workload identity/provider. No registrar database, queue, GitHub, gateway, or arbitrary Secrets Manager access by default. |
| Image pull / ECR access | ECR image read permissions required by the configured runtime image source. AWS's example includes `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer`; verify whether `ecr:GetAuthorizationToken` is needed for the selected account/registry arrangement. | Scope repository reads to the one AgentCore image repository where supported. Token action may require `Resource: "*"`; do not confuse it with image write permissions. |
| Runtime caller | `bedrock-agentcore:InvokeAgentRuntime` for the designated runtime/endpoint; add `bedrock-agentcore:InvokeAgentRuntimeForUser` only if user-id delegation is explicitly designed and authorized. | Scope to the target runtime/endpoint ARN and use runtime resource-based policy/authentication to restrict principals. No create/update, pass-role, or execution-role permissions. |
| Identity/secret administration | Create/update the selected AgentCore Identity credential provider and its referenced secret through an owner-approved provisioning path. Runtime token access only as documented for the selected Identity feature. | Separate credential administration from runtime deployment where feasible. Limit secret identifiers to the provider's exact secret; no secret values in repo, CI output, or handoff. AgentCore's service-linked role is service-managed; do not substitute a broad manual secret-reader policy. |

AWS documents an AgentCore Runtime execution role and gives example ECR,
CloudWatch Logs, X-Ray, CloudWatch metrics, Bedrock model, and workload-token
permissions. Those examples are starting points, not permission grants for
this project: remove optional integrations that the chosen design does not
use, tighten wildcard resources where AWS supports it, and verify the final
policy with IAM policy simulation and the selected feature's AWS guide before
any account deployment. If AgentCore Identity's service-linked role is
created automatically for the applicable runtime, the deployment principal
may still need the narrowly conditioned `iam:CreateServiceLinkedRole` action;
verify account state and AWS's current service-linked-role guidance rather
than embedding that permission unconditionally.

## Services and responsibility boundary

```text
Existing Compose / Balena control plane
  registrar + PostgreSQL + registrant + LiteLLM + Dolt/Scotty + network edge
              | existing enrollment / configuration ownership
              | (no direct AWS account action by registrant in this design)
              v
AgentCore Runtime (candidate for Hermes agent / Primus execution)
  versioned runtime + endpoint + explicit HTTP, MCP, or A2A contract
              | AgentCore Identity for outbound OAuth/API credentials, if used
              v
External tools and APIs
```

This diagram shows intended service placement, not a deployed or tested data
path. AgentCore Runtime hosts the agent container and provides its runtime
boundary; it does not host or implicitly migrate the compose services above.
The adapter must document the network route between the existing control
plane and runtime (public or VPC configuration), inbound authorization,
outbound destinations, session identity, and failure behavior before
implementation is considered ready.

## Unresolved questions and account-dependent checks

These items are intentionally open; none has been verified against a Vector
Sigma AWS account or live deployment:

- Which protocol is the target: HTTP, MCP, or A2A? What component provides
  the required listener, paths, health handler, and invocation semantics?
- Is the Hermes image compatible with the chosen AgentCore runtime contract,
  image requirements, startup/health timing, and selected runtime platform
  version? What adapter/shim changes are needed, and can they preserve the
  same reviewed image digest?
- What exact ECR repository, cross-registry publication mechanism, digest
  verification, and pull-role arrangement will be used?
- Which Region(s), runtime compute type/platform version, endpoint strategy,
  session lifetime/state model, scaling limits, quotas, and cost controls are
  supported and approved for the account?
- Does the runtime need public or VPC networking? Which exact registrar,
  gateway, and tool destinations must be reachable, and what ingress/egress
  controls and DNS/TLS trust are required?
- Which existing identity values (if any) should move to AgentCore Identity?
  Which use OAuth versus API keys? Who provisions, rotates, revokes, and
  audits the Secrets Manager-backed providers?
- What exact inbound authentication and caller identities are authorized?
  Is user-id delegation required? Default answer: no, until approved.
- Which observability features are required, and what exact log, metric, and
  trace permissions/resources result?
- Are AgentCore Runtime and Identity available in the intended account/Region,
  and what organization SCPs, permission boundaries, KMS policies, service
  quotas, and resource policies apply?
- What is the tested rollback and removal procedure for runtime versions,
  endpoints, ECR artifacts, execution roles, Identity providers, and secrets?
- How will a future device migration be staged without altering the existing
  Balena path or sending production/fleet traffic before separate approval?

Resolve these with the owner and the target AWS account's current configuration
before producing an executable CDK deployment or making live calls.

## AWS primary references

AWS documentation is mutable. These links were checked for this design pass;
re-check them when implementing the adapter.

- [AgentCore Runtime service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html) — protocol comparison, ports, mount paths, message formats, authentication.
- [HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html) — HTTP listener/port, ARM64 container, `/invocations`, `/ping`, optional WebSocket.
- [MCP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html) — Streamable HTTP, `/mcp`, port 8000, session behavior.
- [A2A Runtime guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html) — A2A port 9000, root path, stateless streamable HTTP, Agent Card, proxy/session behavior.
- [Runtime architecture and sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html) — runtime versions, endpoints, session and compute behavior.
- [IAM permissions for AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html) — control-plane and execution-role examples.
- [Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html) — resource scoping and invocation restrictions.
- [Inbound and outbound authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html) — runtime auth, Identity integration, and service-linked role notes.
- [Add an OAuth client with Secrets Manager](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-add-oauth-client-included.html) — provider credential secret reference and Identity-managed retrieval.
- [Add an API key with Secrets Manager](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-add-api-key.html) — API-key provider credential secret reference.
- [AgentCore Identity service-linked role](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/service-linked-roles.html) — service-managed identity permissions and lifecycle.
