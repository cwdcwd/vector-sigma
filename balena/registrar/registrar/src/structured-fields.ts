/**
 * Structured bundle editor fields (fleet-ops-f57.11).
 *
 * Owner ruling 2026-09-20: the bundle editor gains a structured section
 * whose fields render to CANONICAL FILES via fixed templates. This module
 * is the single source of truth for the field set and the rendering —
 * the admin console (form), the editor tests, and the deploy E2E all
 * derive from it, so the wire contract and the UI cannot drift.
 *
 * Field -> canonical file map (owner-ruled, do not re-derive):
 *   agent_name        -> config/agent.env   (AGENT_NAME= header line)
 *   model_route       -> config/agent.env   (MODEL_ROUTE=...)
 *   gateway_api_key   -> config/agent.env   (GATEWAY_API_KEY=..., secret)
 *   extra_env         -> config/agent.env   (free-form KEY=VALUE lines)
 *   soul_contents     -> SOUL.md            (verbatim)
 *   a2a_identity_key  -> config/a2a.json   (identity_key property, secret)
 *   a2a_trusted_peers -> config/a2a.json   (trusted_peers list)
 *   slack_bot_token   -> config/secrets.env (SLACK_BOT_TOKEN=..., secret)
 *   github_app_pem    -> config/github-app.pem (verbatim PEM, secret)
 *
 * Merge semantics ("blank = keep existing", AC 4): several fields render
 * into ONE file, so blank-keeps-existing must hold at FIELD level, not
 * just file level. Env-style files merge line-wise per KEY (a set field
 * replaces its line in place; a blank field leaves the existing line;
 * new keys append). a2a.json merges as an object. Verbatim files
 * (SOUL.md, github-app.pem) replace whole when set and keep existing
 * when blank. Without this, saving one agent.env field would silently
 * drop the other delivered lines — e.g. renaming the agent would destroy
 * the delivered gateway key.
 */

/** Canonical bundle file paths the structured fields render into. */
export const CANONICAL_PATHS = {
  agentEnv: 'config/agent.env',
  soul: 'SOUL.md',
  a2a: 'config/a2a.json',
  secretsEnv: 'config/secrets.env',
  githubAppPem: 'config/github-app.pem',
} as const;

/** Field names as they appear on the form and in the save payload. */
export const FIELD_NAMES = [
  'agent_name',
  'model_route',
  'gateway_api_key',
  'extra_env',
  'soul_contents',
  'a2a_identity_key',
  'a2a_trusted_peers',
  'slack_bot_token',
  'github_app_pem',
] as const;
export type StructuredFieldName = (typeof FIELD_NAMES)[number];

/** Fields whose values are secrets: write-only, blank = keep existing. */
export const SECRET_FIELDS: ReadonlySet<StructuredFieldName> = new Set([
  'gateway_api_key',
  'a2a_identity_key',
  'slack_bot_token',
  'github_app_pem',
]);

/** The structured form input: one entry per field, all optional. */
export interface StructuredFields {
  agent_name?: string;
  model_route?: string;
  gateway_api_key?: string;
  extra_env?: string;
  soul_contents?: string;
  a2a_identity_key?: string;
  a2a_trusted_peers?: string;
  slack_bot_token?: string;
  github_app_pem?: string;
}

/** A rendered canonical file ready for merge into the bundle. */
export interface RenderedFile {
  path: string;
  mode: '0600';
  content: string;
}

/** Non-empty lines of a raw multi-line input, whitespace-trimmed. */
function trimmedLines(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse one KEY=VALUE line. Returns null for blank/comment lines;
 * throws on malformed non-comment lines (the console surfaces the
 * error to the operator rather than silently dropping their input).
 */
export function parseEnvLine(line: string): { key: string; value: string } {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { key: '', value: '' };
  const eq = trimmed.indexOf('=');
  if (eq <= 0) throw new InvalidExtraEnvError(line);
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new InvalidExtraEnvError(line);
  // dotenv semantics: whitespace around the separator is not part of the
  // value. Every renderer call site passes outer-trimmed lines already;
  // this trim only removes the `KEY = value` padding an operator types.
  return { key, value: trimmed.slice(eq + 1).trim() };
}

/** Malformed KEY=VALUE line in extra_env — save is refused with this. */
export class InvalidExtraEnvError extends Error {
  constructor(public readonly line: string) {
    super(
      `extra_env line is not KEY=VALUE (got: ${line.slice(0, 80)}) — fix the line or start it with # to comment it out`,
    );
    this.name = 'InvalidExtraEnvError';
  }
}

/**
 * Non-secret pre-fill for the structured form (f57.11). AC4 makes only the
 * SECRET fields write-only; the operator must see the current non-secret
 * identity (soul, model route, peers, extra env) to edit it. Values are
 * derived server-side from the CURRENT bundle contents; secrets are never
 * included — their inputs render blank with a write-only hint.
 */
/** Env keys with secret-looking names are NEVER pre-filled (defense in depth). */
const SECRETISH_KEY_RE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|CRED|CREDENTIAL)(_|$)/i;

export function buildFormPreFill(
  current: ReadonlyMap<string, string>,
  deviceAgentName: string,
): StructuredFields {
  const preFill: StructuredFields = {};
  // config/agent.env: managed KEY=VALUE lines (secrets excluded).
  const agentEnv = current.get(CANONICAL_PATHS.agentEnv);
  if (agentEnv !== undefined) {
    const extraLines: string[] = [];
    for (const line of trimmedLines(agentEnv)) {
      if (line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key === 'AGENT_NAME') continue;
      if (key === 'MODEL_ROUTE') {
        preFill.model_route = line.slice(eq + 1).trim();
        continue;
      }
      // GATEWAY_API_KEY is managed+secret; any other secret-looking key
      // (raw uploads carry arbitrary env) is masked out of the pre-fill
      // too — the console never renders it, editor or not.
      if (SECRETISH_KEY_RE.test(key)) continue;
      extraLines.push(line);
    }
    preFill.extra_env = extraLines.join('\n');
  }
  // Device row is authoritative for the display name; fall back to the
  // bundle's AGENT_NAME line when the row is empty.
  preFill.agent_name =
    deviceAgentName !== ''
      ? deviceAgentName
      : (current.get(CANONICAL_PATHS.agentEnv)?.match(/^AGENT_NAME=(.*)$/m)?.[1] ?? '');
  // SOUL.md: verbatim non-secret content.
  preFill.soul_contents = current.get(CANONICAL_PATHS.soul) ?? '';
  // config/a2a.json: trusted peers one per line; identity key is secret.
  const a2a = current.get(CANONICAL_PATHS.a2a);
  if (a2a !== undefined) {
    try {
      const obj = JSON.parse(a2a) as Record<string, unknown>;
      const peers = obj.trusted_peers;
      if (Array.isArray(peers)) {
        preFill.a2a_trusted_peers = peers
          .filter((p): p is string => typeof p === 'string')
          .join('\n');
      }
    } catch {
      // Raw-uploaded a2a.json that is not an object: no peers pre-fill;
      // the renderer's fresh-start merge governs a structured save.
    }
  }
  return preFill;
}

/**
 * Env-file merge: existing lines keep their order; a set key replaces its
 * line IN PLACE; keys not present append at the end (after the existing
 * lines, so a structured save never reorders an uploaded file). Comment
 * lines in extra_env append verbatim (no key to merge on).
 */
type EnvSection = { key: string; value: string } | { raw: string };

function mergeEnvFile(
  existingContent: string | undefined,
  sections: EnvSection[],
): string | null {
  if (sections.length === 0) return null; // nothing set → no update for this path
  const lines = trimmedLines(existingContent);
  const out = [...lines];
  for (const s of sections) {
    if ('raw' in s) {
      out.push(s.raw);
      continue;
    }
    const idx = out.findIndex((l) => l.startsWith(`${s.key}=`));
    if (idx === -1) out.push(`${s.key}=${s.value}`);
    else out[idx] = `${s.key}=${s.value}`;
  }
  return `${out.join('\n')}\n`;
}

/**
 * Render the structured fields into canonical file updates, merging with
 * the CURRENT bundle's file contents (server-side only — existing content
 * never reaches the browser; only rendered results are stored).
 *
 * Returns only the files with at least one set field; untouched paths are
 * absent so the rotate merge keeps the existing files exactly as-is.
 * @param existingContents path -> current content of that bundle file.
 */
export function renderCanonicalFiles(
  fields: StructuredFields,
  existingContents?: ReadonlyMap<string, string>,
): RenderedFile[] {
  const existing = existingContents ?? new Map<string, string>();
  const out: RenderedFile[] = [];

  // ---- config/agent.env: AGENT_NAME header + MODEL_ROUTE + GATEWAY_API_KEY + extra_env
  const agentEnvSections: EnvSection[] = [];
  const agentName = fields.agent_name?.trim() ?? '';
  if (agentName !== '') agentEnvSections.push({ key: 'AGENT_NAME', value: agentName });
  const modelRoute = fields.model_route?.trim() ?? '';
  if (modelRoute !== '') agentEnvSections.push({ key: 'MODEL_ROUTE', value: modelRoute });
  const gatewayKey = fields.gateway_api_key?.trim() ?? '';
  if (gatewayKey !== '') agentEnvSections.push({ key: 'GATEWAY_API_KEY', value: gatewayKey });
  for (const line of trimmedLines(fields.extra_env)) {
    if (line.startsWith('#')) {
      agentEnvSections.push({ raw: line });
      continue;
    }
    agentEnvSections.push(parseEnvLine(line));
  }
  const agentEnv = mergeEnvFile(existing.get(CANONICAL_PATHS.agentEnv), agentEnvSections);
  if (agentEnv !== null) {
    out.push({ path: CANONICAL_PATHS.agentEnv, mode: '0600', content: agentEnv });
  }

  // ---- SOUL.md: verbatim; set replaces whole file, blank keeps existing.
  const soul = fields.soul_contents ?? '';
  if (soul.trim() !== '') {
    out.push({ path: CANONICAL_PATHS.soul, mode: '0600', content: soul });
  }

  // ---- config/a2a.json: object-merge (set keys override, blank keys keep).
  const identityKey = fields.a2a_identity_key?.trim() ?? '';
  const peersRaw = fields.a2a_trusted_peers?.trim() ?? '';
  if (identityKey !== '' || peersRaw !== '') {
    let obj: Record<string, unknown> = {};
    const prev = existing.get(CANONICAL_PATHS.a2a);
    if (prev !== undefined) {
      try {
        const parsed = JSON.parse(prev);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj = { ...(parsed as Record<string, unknown>) };
        }
      } catch {
        // Existing a2a.json is not an object (raw upload of arbitrary
        // JSON/garbage): a structured edit starts from a fresh object.
        obj = {};
      }
    }
    if (identityKey !== '') obj.identity_key = identityKey;
    if (peersRaw !== '') {
      obj.trusted_peers = peersRaw
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    }
    out.push({
      path: CANONICAL_PATHS.a2a,
      mode: '0600',
      content: JSON.stringify(obj, null, 2) + '\n',
    });
  }

  // ---- config/secrets.env: SLACK_BOT_TOKEN line-merge.
  const slack = fields.slack_bot_token?.trim() ?? '';
  if (slack !== '') {
    const merged = mergeEnvFile(existing.get(CANONICAL_PATHS.secretsEnv), [
      { key: 'SLACK_BOT_TOKEN', value: slack },
    ]);
    out.push({ path: CANONICAL_PATHS.secretsEnv, mode: '0600', content: merged as string });
  }

  // ---- config/github-app.pem: verbatim PEM; set replaces whole, blank keeps.
  const pem = fields.github_app_pem ?? '';
  if (pem.trim() !== '') {
    out.push({ path: CANONICAL_PATHS.githubAppPem, mode: '0600', content: pem });
  }

  return out;
}