/** Shared OCI shape types for the local content gate (slice 4). */

export interface OciPlatform {
  architecture: string;
  os: string;
  variant?: string;
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: OciPlatform;
  annotations?: Record<string, string>;
}

/**
 * Classifies one index-level manifest descriptor as either the runnable
 * IMAGE manifest for a platform, or a buildkit/BuildKit ATTESTATION
 * manifest (provenance/SBOM) riding alongside it in the same index
 * (fleet-ops-1py.14 slice 4 fix for PR #61 review finding #1 — see
 * https://docs.docker.com/build/metadata/attestations/attestation-storage/).
 * Buildx with `--provenance`/`--sbom` enabled (the project's build
 * action default) emits an OCI INDEX per platform containing BOTH the
 * image manifest and one attestation manifest, the latter tagged with
 * the `vnd.docker.reference.type: attestation-manifest` annotation and
 * declaring platform `unknown/unknown`. A gate that blindly takes
 * index.manifests[0] as "the" manifest and expects config/layers on it
 * breaks the instant provenance is enabled — this is the exact live
 * failure the owner reproduced in CI run 38181603571.
 *
 * OWNER-RULED ATTESTATION POLICY (explicit, documented per the review's
 * requirement to pick one and document it): attestation manifests are
 * NOT scanned for secrets/topology by this gate — they carry in-toto/
 * SPDX/SBOM JSON describing the build, not runnable image content, and
 * are out of this gate's declared scope (credential/topology scanning
 * of SHIPPED IMAGE BYTES). They ARE still structurally validated
 * (digest/size against the real blob, fail-closed on tamper/corruption/
 * a missing blob) so a corrupt or dangling attestation reference still
 * rejects the layout — the gate just never treats their CONTENT as
 * scannable layer/config material.
 */
export function classifyIndexDescriptor(d: OciDescriptor): 'image' | 'attestation' {
  if (d.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') return 'attestation';
  return 'image';
}

export interface OciIndex {
  schemaVersion: number;
  mediaType?: string;
  manifests: OciDescriptor[];
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
}

export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];

export function platformKey(p: OciPlatform | undefined): string | undefined {
  if (!p) return undefined;
  return `${p.os}/${p.architecture}`;
}
