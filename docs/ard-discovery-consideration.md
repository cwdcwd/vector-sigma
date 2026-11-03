# ARD discovery support — consideration only

**Status:** Proposal for review; no implementation authorized by this document.

## Summary

Consider adding Agentic Resource Discovery (ARD) as an interoperability layer for discovering approved Vector Sigma resources. ARD should complement the registrar, not replace it.

ARD describes how resources are published and discovered across catalogs and discovery services. It can describe resources that use existing protocols such as A2A, MCP, Skills, or HTTP APIs; invocation remains with the resource's native protocol. ARD is therefore a discovery envelope, not an identity, provisioning, or execution service. See the [ARD interoperability guide](https://agenticresourcediscovery.org/interoperability/) and [client guide](https://agenticresourcediscovery.org/how_to_build_a_client/).

## Why this may fit Vector Sigma

Vector Sigma already has A2A agents and a registrar that maintains device identity, bundles, mesh enrollment, and recovery. An ARD representation could let compatible clients discover a deliberately curated subset of those resources without replacing the existing mesh or requiring clients to know every agent endpoint in advance. The registrar remains the system of record for device identity and configuration; the ARD surface would publish discovery metadata only.

The initial shape worth evaluating is a generated, read-only `ard.json` manifest for approved resources, potentially served at `/.well-known/ard.json` on a suitable public or internal hostname. Entries could point to public-facing A2A cards or other explicitly approved resources. Discovery metadata must not include mesh secrets, private tailnet addresses, registrar credentials, or bundle contents.

## Proposed boundaries

- **Keep the registrar.** It is the identity and device-control plane, including bootstrap/recovery, bundle delivery, mesh enrollment, and credential lifecycle. ARD does not provide these functions.
- **Do not expose the registrar database as a public catalog.** Build a narrow export from an explicit allowlist or publication state, with safe public metadata only.
- **Treat ARD as discovery, not trust.** A manifest entry or search score does not establish that a publisher or resource is safe. Any consumer must apply its own trust policy and verify applicable identity/signature evidence before connecting.
- **Keep public and tailnet-only resources distinct.** Do not publish an endpoint merely because it exists in the mesh. Decide whether the first catalog is internal-only or intentionally public before implementing or deploying it.
- **Avoid federation and dynamic semantic search in the first step.** A static manifest is the smallest useful interoperability experiment. A discovery service with `/search`, indexing, referrals, or upstream federation adds policy, operations, and abuse surfaces and should be separately justified.

## Possible staged evaluation

1. **Confirm the use case and audience.** Identify which external or internal clients need discovery, what resources they should find, and whether discovery must work off-tailnet.
2. **Prototype a manifest outside the production path.** Hand-build a small example from approved A2A agent cards; check identifier conventions, resource types, endpoint reachability, representative queries, and that no private data is present.
3. **Review security and ownership.** Define who may publish or withdraw an entry, which hostname serves it, how metadata is signed or otherwise verified, how stale/deprecated resources are removed, and whether an internal-only service is preferable.
4. **Only after review, scope an implementation PR.** If the experiment proves useful, generate the manifest from an explicit publication source and add contract tests for filtering, serialization, and secret/private-endpoint exclusion. Keep publication fail-closed when the allowlist or trust evidence is absent.
5. **Consider a `/search` service or federation only with a concrete client requirement.** Define authentication, query/rate limits, result curation, referral policy, observability, and failure behavior before taking that on.

## Review questions

1. Is the target audience internal, public, or both? Should any resource be discoverable outside the tailnet?
2. Which concrete clients or workflows need ARD, and what can they not do with the current A2A mesh/card setup?
3. Which resource types are in scope initially: A2A agents only, or also MCP servers, skills, and APIs?
4. Should the registrar generate a static manifest, or should discovery live in a separate service to keep publication concerns out of the identity/control plane?
5. What publisher identity, signing, and verification requirements are mandatory before publishing?
6. What are the expected maintenance and rollback costs relative to the interoperability benefit?

## Recommendation

Evaluate a read-only, static ARD manifest as an optional interoperability experiment. Retain the registrar as the authoritative identity/control plane. Do not add public discovery, dynamic search, federation, or replace registrar responsibilities until the audience, trust policy, and operational owner are agreed.

## References

- [ARD interoperability](https://agenticresourcediscovery.org/interoperability/)
- [ARD publishing guide](https://agenticresourcediscovery.org/how_to_publish/)
- [ARD client guide](https://agenticresourcediscovery.org/how_to_build_a_client/)
- [Vector Sigma Balena architecture](balena-architecture.md)
- [Vector Sigma registrar runbook](../platforms/balena/registrar/README.md)
- [Vector Sigma signed A2A identity design](a2a-signed-identity.md)
