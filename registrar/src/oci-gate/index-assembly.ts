/**
 * Index assembly (fleet-ops-1py.14 slice 4).
 *
 * Given exactly one scanned+passed child manifest descriptor per
 * required platform (linux/amd64, linux/arm64), assembles a local OCI
 * index referencing ONLY those two validated digests. This function
 * does zero I/O and zero network calls — it is pure assembly over
 * already-validated descriptors the caller obtained from
 * `scanPlatformManifest` (or an equivalent gate pass).
 *
 * Rejects fail-closed:
 *  - missing_platform: a required platform has no candidate.
 *  - duplicate_platform: more than one candidate declares the same
 *    required platform.
 *  - extra_platform: a candidate declares a platform outside the
 *    required set.
 *  - unknown_child_digest: a candidate's digest is not in the
 *    caller-supplied allow-set of scanned-and-passed digests (guards
 *    against a descriptor sneaking in from outside the scan pass).
 *  - malformed_descriptor: shape failures (missing digest/size/
 *    mediaType/platform, malformed digest string).
 */
import { ContentGateError } from './errors.js';
import { REQUIRED_PLATFORMS, platformKey, type OciDescriptor, type OciIndex } from './types.js';

function validateCandidateShape(desc: OciDescriptor, index: number): void {
  if (!desc || typeof desc !== 'object') {
    throw new ContentGateError('malformed_descriptor', `index candidate[${index}] is not an object`);
  }
  if (typeof desc.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(desc.digest)) {
    throw new ContentGateError('malformed_descriptor', `index candidate[${index}] has a malformed digest`);
  }
  if (typeof desc.mediaType !== 'string' || desc.mediaType === '') {
    throw new ContentGateError('malformed_descriptor', `index candidate[${index}] has a malformed mediaType`);
  }
  if (!Number.isInteger(desc.size) || desc.size < 0) {
    throw new ContentGateError('malformed_descriptor', `index candidate[${index}] has a malformed size`);
  }
  if (!desc.platform || typeof desc.platform.architecture !== 'string' || typeof desc.platform.os !== 'string') {
    throw new ContentGateError('malformed_descriptor', `index candidate[${index}] is missing a platform`);
  }
}

export interface AssembleIndexOptions {
  /** Candidate child-manifest descriptors, exactly one intended per required platform. */
  candidates: OciDescriptor[];
  /** Digests that passed the scan gate — any candidate digest outside this set is rejected. */
  scannedAllowSet: ReadonlySet<string>;
}

/**
 * Assembles the final local OCI index from scanned+passed candidates.
 * Throws on any violation; returns the index ONLY when exactly the
 * required platform set is present, one-for-one, with no unknown
 * digests.
 */
export function assembleLocalOciIndex(opts: AssembleIndexOptions): OciIndex {
  const { candidates, scannedAllowSet } = opts;

  candidates.forEach((c, i) => validateCandidateShape(c, i));

  const seenPlatforms = new Map<string, OciDescriptor>();
  for (const candidate of candidates) {
    const key = platformKey(candidate.platform);
    if (!key) {
      throw new ContentGateError('malformed_descriptor', `candidate ${candidate.digest} has no resolvable platform key`);
    }
    if (!(REQUIRED_PLATFORMS as readonly string[]).includes(key)) {
      throw new ContentGateError('extra_platform', `candidate ${candidate.digest} declares an unexpected/unknown platform: ${key}`);
    }
    if (seenPlatforms.has(key)) {
      throw new ContentGateError('duplicate_platform', `more than one candidate declares platform ${key}`);
    }
    if (!scannedAllowSet.has(candidate.digest)) {
      throw new ContentGateError('unknown_child_digest', `candidate digest ${candidate.digest} is not in the scanned-and-passed allow-set`);
    }
    seenPlatforms.set(key, candidate);
  }

  for (const required of REQUIRED_PLATFORMS) {
    if (!seenPlatforms.has(required)) {
      throw new ContentGateError('missing_platform', `required platform is missing from the candidate set: ${required}`);
    }
  }

  const manifests = REQUIRED_PLATFORMS.map((p) => seenPlatforms.get(p)!);

  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests,
  };
}
