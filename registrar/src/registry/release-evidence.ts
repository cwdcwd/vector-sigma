/**
 * Release-evidence ledger (fleet-ops-r3v).
 *
 * Collates the per-component promotion records the exact-byte promote job
 * writes (promoted-<component>.json, verified byte-for-byte by
 * scripts/verify-published.sh) into ONE release-evidence.json for
 * the run: the artifact the rollback runbook cites. The ledger must answer,
 * from a single file, "what exact image bytes were promoted for this run"
 * — index digest, per-arch child digests, per component — so a rollback can
 * re-pin or re-render without re-resolving any mutable tag.
 *
 * Fail-closed: every input record is shape-checked before it lands in the
 * ledger; one bad record fails the whole ledger build. Output is
 * deterministic (components sorted, no ambient timestamps) so two builds
 * from the same inputs produce byte-identical ledgers — the digest of the
 * ledger itself is meaningful.
 */
import { createHash } from 'node:crypto';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export type EvidenceError =
  | 'malformed_record'
  | 'repository_mismatch'
  | 'registry_mismatch'
  | 'bad_digest'
  | 'platform_missing'
  | 'no_components'
  | 'bad_input';

export class ReleaseEvidenceError extends Error {
  constructor(readonly code: EvidenceError, message: string) {
    super(message);
    this.name = 'ReleaseEvidenceError';
  }
}

export interface EvidencePlatform {
  platform: 'linux/amd64' | 'linux/arm64';
  digest: string;
}

export interface EvidenceComponent {
  repository: string;
  indexTag: string;
  indexDigest: string;
  perPlatform: EvidencePlatform[];
}

export interface ReleaseEvidenceInput {
  /** Full 40-char commit the run built and promoted. */
  commit: string;
  /** Git ref name that triggered the run (e.g. a tag name). */
  refName: string;
  /** GitHub Actions run id this release belongs to. */
  runId: string;
  actor?: string;
  /** ISO-8601 stamp; only when supplied, so output stays deterministic. */
  generatedAt?: string;
  registry?: string;
}

/** `vs.release-evidence/1` — schema bump requires a runbook note. */
export interface ReleaseEvidence {
  schema: 'vs.release-evidence/1';
  registry: string;
  commit: string;
  refName: string;
  runId: string;
  actor?: string;
  generatedAt?: string;
  components: Record<string, EvidenceComponent>;
  /** sha256 over the sorted `<component>@<indexDigest>` lines — audit handle. */
  contentDigest: string;
  rollback: {
    /** How to roll back an image promotion: re-pin + re-render. */
    procedure: string;
    /** Which mutable ref is the only tag the fleet may resolve. */
    authoritativeTag: string;
  };
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * Validates one promotion record and reduces it to its evidence shape.
 * `component` comes from the CALLER (the artifact/file name), not the
 * record body, and must equal the record's own repository tail.
 */
export function parsePromotionRecord(component: string, raw: unknown): EvidenceComponent {
  if (typeof component !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(component)) {
    throw new ReleaseEvidenceError('bad_input', `component name ${JSON.stringify(component)} is not a valid component id`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReleaseEvidenceError('malformed_record', `${component}: promotion record is not a JSON object`);
  }
  const rec = raw as Record<string, unknown>;
  const repository = rec.repository;
  if (typeof repository !== 'string' || !repository.endsWith(`/${component}`)) {
    throw new ReleaseEvidenceError(
      'repository_mismatch',
      `${component}: record repository ${JSON.stringify(repository)} does not end in the component id`,
    );
  }
  if (rec.registry !== 'ghcr.io') {
    throw new ReleaseEvidenceError('registry_mismatch', `${component}: record registry is not ghcr.io`);
  }
  const index = rec.index;
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new ReleaseEvidenceError('malformed_record', `${component}: record has no index object`);
  }
  const indexTag = (index as Record<string, unknown>).tag;
  const indexDigest = (index as Record<string, unknown>).digest;
  if (typeof indexTag !== 'string' || indexTag.length === 0) {
    throw new ReleaseEvidenceError('malformed_record', `${component}: index.tag missing`);
  }
  if (!isSha256Digest(indexDigest)) {
    throw new ReleaseEvidenceError('bad_digest', `${component}: index.digest is not a sha256:... digest`);
  }
  const platforms = rec.perPlatform;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new ReleaseEvidenceError('malformed_record', `${component}: perPlatform missing or empty`);
  }
  const perPlatform = new Map<'linux/amd64' | 'linux/arm64', string>();
  for (const p of platforms) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new ReleaseEvidenceError('malformed_record', `${component}: perPlatform entry is not an object`);
    }
    const entry = p as Record<string, unknown>;
    if (entry.platform !== 'linux/amd64' && entry.platform !== 'linux/arm64') continue;
    if (!isSha256Digest(entry.digest)) {
      throw new ReleaseEvidenceError('bad_digest', `${component}: ${entry.platform} child digest is not a sha256:... digest`);
    }
    perPlatform.set(entry.platform, entry.digest);
  }
  for (const required of ['linux/amd64', 'linux/arm64'] as const) {
    if (!perPlatform.has(required)) {
      throw new ReleaseEvidenceError('platform_missing', `${component}: no verified ${required} child digest`);
    }
  }
  return {
    repository,
    indexTag,
    indexDigest,
    perPlatform: [...perPlatform.entries()].map(([platform, digest]) => ({ platform, digest })),
  };
}

/**
 * Collates validated records into the release-evidence ledger for one run.
 * Throws when `records` is empty — a release with zero promoted components
 * has no evidence to certify.
 */
export function buildReleaseEvidence(
  input: ReleaseEvidenceInput,
  records: ReadonlyMap<string, EvidenceComponent>,
): ReleaseEvidence {
  if (!records || records.size === 0) {
    throw new ReleaseEvidenceError('no_components', 'refusing to build a release-evidence ledger from zero promotion records');
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new ReleaseEvidenceError('bad_input', `commit ${JSON.stringify(input.commit)} is not a full 40-char sha`);
  }
  if (typeof input.refName !== 'string' || input.refName.length === 0 || typeof input.runId !== 'string' || input.runId.length === 0) {
    throw new ReleaseEvidenceError('bad_input', 'refName and runId are required');
  }
  const registry = input.registry ?? 'ghcr.io';
  const components: Record<string, EvidenceComponent> = {};
  for (const component of [...records.keys()].sort()) {
    components[component] = records.get(component) as EvidenceComponent;
  }
  const collationDigest = indexDigestOfComponents(components);
  return {
    schema: 'vs.release-evidence/1',
    registry,
    commit: input.commit,
    refName: input.refName,
    runId: input.runId,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    components,
    contentDigest: collationDigest,
    rollback: {
      procedure:
        'Re-render the release compose from THESE digests (render-release-compose.mjs --records-dir) or deploy the prior balena release from the fleet-private registry; never resolve a mutable tag to roll back.',
      authoritativeTag: input.commit,
    },
  };
}

/** Deterministic digest over the sorted component list (audit handle). */
export function releaseEvidenceDigest(evidence: ReleaseEvidence): string {
  return `sha256:${createHash('sha256').update(stableStringify(evidence)).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  // JSON.stringify already emits keys in insertion order; buildReleaseEvidence
  // controls insertion order (sorted components, fixed field order), so the
  // canonical form is the plain stringify.
  return JSON.stringify(value);
}

function indexDigestOfComponents(components: Record<string, EvidenceComponent>): string {
  const lines = Object.entries(components).map(([c, r]) => `${c}@${r.indexDigest}`).join('\n');
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`;
}