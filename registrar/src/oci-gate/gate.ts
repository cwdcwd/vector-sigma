/**
 * Content gate orchestration (fleet-ops-1py.14 slice 4).
 *
 * Top-level entry point: given a map of required-platform -> OCI
 * layout tar bytes, runs the full local pipeline per platform
 * (load layout -> validate index/manifest descriptors against real
 * bytes -> walk every layer including whiteout-deleted content ->
 * scan raw layer bytes for secrets/topology literals) and, if every
 * platform passes, assembles the final local OCI index referencing
 * only the validated child-manifest digests.
 *
 * This module performs ZERO network/registry calls — it operates
 * entirely on caller-supplied in-memory tar buffers. There is no
 * import here (or anywhere in registrar/src/oci-gate/) of an HTTP
 * client, a registry SDK, or any `fetch`/`http`/`https` usage; the
 * fail-closed test matrix (oci-content-gate.test.ts) asserts this
 * statically (grep over module source) AND behaviorally (a global
 * fetch/https sentinel that must stay uncalled through every gate
 * run, pass or reject).
 */
import { loadOciLayout, loadManifest, loadConfig, validateDescriptorAgainstBlob, type LoadedOciLayout } from './oci-layout.js';
import { walkAllLayers } from './layer-walk.js';
import { assertNoSecretsOrTopologyLiterals } from './secret-scan.js';
import { assertConfigHasNoSecretsOrTopologyLiterals } from './config-scan.js';
import { assembleLocalOciIndex } from './index-assembly.js';
import { ContentGateError } from './errors.js';
import {
  REQUIRED_PLATFORMS,
  platformKey,
  classifyIndexDescriptor,
  type OciDescriptor,
  type OciIndex,
  type RequiredPlatform,
} from './types.js';

export { ContentGateError } from './errors.js';
export type { ContentGateErrorCode } from './errors.js';
export { REQUIRED_PLATFORMS } from './types.js';
export type { OciDescriptor, OciIndex, OciManifest, OciPlatform } from './types.js';


export interface PlatformLayoutInput {
  platform: RequiredPlatform;
  /** Raw bytes of the `docker buildx build --output type=oci` tar export for this platform. */
  tarBytes: Buffer;
}

export interface ScannedPlatformResult {
  platform: RequiredPlatform;
  manifestDescriptor: OciDescriptor;
  layerCount: number;
  entryCount: number;
}

/**
 * Validates one platform's OCI layout end to end: descriptor/blob
 * integrity, full layer walk including whiteout-deleted paths, and
 * secret/topology scan over every raw layer byte stream. Throws
 * fail-closed on the first violation found anywhere in the pipeline.
 *
 * The layout's `index.json` must contain EXACTLY ONE manifest entry
 * (single-platform layout, as `docker buildx build --output type=oci`
 * produces for a single `--platform` target) and that manifest's
 * declared platform (if present) must match the expected platform.
 */
/**
 * Validates one platform's OCI layout end to end: descriptor/blob
 * integrity, full layer walk including whiteout-deleted paths, and
 * secret/topology scan over every raw layer byte stream. Throws
 * fail-closed on the first violation found anywhere in the pipeline.
 *
 * The layout's `index.json` manifests array may contain EITHER a
 * single bare image manifest (as `docker buildx build --output
 * type=oci` produces for a single `--platform` target with provenance/
 * SBOM attestations disabled) OR an image manifest PLUS one attestation
 * manifest for the same platform (as the project's build action
 * actually emits with `--provenance`/`--sbom` enabled — see
 * classifyIndexDescriptor in types.js for the full owner-ruled
 * attestation policy this fixes PR #61 review finding #1). Descriptors
 * are resolved by media type / the `vnd.docker.reference.type:
 * attestation-manifest` annotation, never by positional index[0] —
 * that positional assumption was the root cause of the owner's live CI
 * failure (run 38181603571: a manifest-list digest rejected as
 * "missing config/layers" because it was actually the index itself
 * being mistaken for a flat manifest, or an attestation manifest
 * occupying the position the gate assumed was the image manifest).
 *
 * Exactly ONE image manifest is required per platform layout; zero or
 * more attestation manifests are tolerated (structurally validated —
 * digest/size against real bytes — but never scanned as image
 * content, never required to carry config/layers, per the documented
 * policy). More than one image-classified manifest, or an image
 * manifest whose declared platform mismatches the expected one, is
 * rejected fail-closed.
 */
export function scanPlatformLayout(input: PlatformLayoutInput): ScannedPlatformResult {
  const layout: LoadedOciLayout = loadOciLayout(input.tarBytes);

  if (layout.index.manifests.length === 0) {
    throw new ContentGateError(
      'malformed_layout',
      `OCI layout for ${input.platform} has an empty index.json manifests array`,
    );
  }

  const imageManifestDescs = layout.index.manifests.filter((m) => classifyIndexDescriptor(m) === 'image');
  const attestationDescs = layout.index.manifests.filter((m) => classifyIndexDescriptor(m) === 'attestation');

  if (imageManifestDescs.length === 0) {
    throw new ContentGateError(
      'malformed_layout',
      `OCI layout for ${input.platform} has no image manifest (only attestation manifest(s) found) — index must contain exactly one runnable image manifest`,
    );
  }
  if (imageManifestDescs.length > 1) {
    throw new ContentGateError(
      'malformed_layout',
      `single-platform OCI layout for ${input.platform} must have exactly one image manifest entry, found ${imageManifestDescs.length}`,
    );
  }
  const manifestDesc = imageManifestDescs[0]!;
  const declaredKey = platformKey(manifestDesc.platform);
  if (declaredKey && declaredKey !== input.platform) {
    throw new ContentGateError(
      'malformed_layout',
      `layout for ${input.platform} declares a mismatched platform: ${declaredKey}`,
    );
  }

  // Attestation manifests: structurally validated (digest/size against
  // the real blob — fail-closed on a tampered/corrupt/missing blob)
  // but never scanned as image content and never required to carry
  // config/layers (buildx attestation manifests have the empty-config +
  // in-toto-layers shape documented on classifyIndexDescriptor).
  for (const attestationDesc of attestationDescs) {
    validateDescriptorAgainstBlob(attestationDesc, layout.blobs, `attestation manifest ${attestationDesc.digest}`);
  }

  const manifest = loadManifest(layout, manifestDesc);
  const allEntries = walkAllLayers(layout, manifest.layers);
  assertNoSecretsOrTopologyLiterals(allEntries);

  // PR #61 review finding #3: validate the image CONFIG blob against
  // its descriptor (same digest/size rigor already applied to the
  // manifest and every layer blob — a missing or tampered config blob
  // must reject, never silently pass) and scan the config JSON content
  // (Env/Labels/Cmd/Entrypoint/history[].created_by) for the same
  // credential/topology patterns layer content is scanned for.
  const config = loadConfig(layout, manifest.config);
  assertConfigHasNoSecretsOrTopologyLiterals(config, manifest.config.digest);

  return {
    platform: input.platform,
    manifestDescriptor: { ...manifestDesc, platform: manifestDesc.platform ?? { os: 'linux', architecture: input.platform.split('/')[1]! } },
    layerCount: manifest.layers.length,
    entryCount: allEntries.length,
  };
}

/**
 * Full gate: scans every supplied platform layout, then assembles the
 * local OCI index from the scanned-and-passed digests — rejecting
 * missing/duplicate/extra platforms or any descriptor not produced by
 * THIS gate run's own scan pass.
 */
export function runContentGate(inputs: PlatformLayoutInput[]): { index: OciIndex; results: ScannedPlatformResult[] } {
  const results = inputs.map((input) => scanPlatformLayout(input));

  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.platform)) {
      throw new ContentGateError('duplicate_platform', `duplicate platform input supplied to the gate: ${r.platform}`);
    }
    seen.add(r.platform);
  }
  const extra = [...seen].filter((p) => !(REQUIRED_PLATFORMS as readonly string[]).includes(p));
  if (extra.length > 0) {
    throw new ContentGateError('extra_platform', `unknown/extra platform supplied to the gate: ${extra.join(', ')}`);
  }
  for (const required of REQUIRED_PLATFORMS) {
    if (!seen.has(required)) {
      throw new ContentGateError('missing_platform', `required platform was not supplied to the gate: ${required}`);
    }
  }

  const scannedAllowSet = new Set(results.map((r) => r.manifestDescriptor.digest));
  const index = assembleLocalOciIndex({
    candidates: results.map((r) => r.manifestDescriptor),
    scannedAllowSet,
  });

  return { index, results };
}
