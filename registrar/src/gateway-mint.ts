/**
 * Gateway memory-key minting (fleet-ops-e5o.3).
 *
 * The admin console's "mint memory keys" action calls the VS gateway
 * (LiteLLM 1.100.1) over its key-management API to create the two
 * route-restricted per-agent memory keys, then writes them into that
 * device's bundle via the existing rotate/extra_env delivery plane.
 *
 * Auth design gate (settled by source review of the pinned gateway tag,
 * recorded on the lane's thread): /key/generate requires a PROXY_ADMIN
 * caller, and `allowed_routes` on a key is a HARD allowlist enforced for
 * every role — including admins. The registrar therefore uses a SCOPED
 * key-creator key: a virtual key bound to a proxy_admin-role user, whose
 * own allowed_routes limit it to exactly the mint surface. It is never
 * the master key. If the scoped creator key is not configured, the
 * action refuses with the fallback path (manual owner mint) — the
 * pre-authorized fallback from the e5o.2 ruling; it never falls through
 * to master-key use.
 *
 * Wire facts (verified against v1.100.1 sources):
 *   - POST /key/generate {key_alias, user_id, team_id?, allowed_routes,
 *     duration?} -> 200 {key: "sk-…"}; alias must be unique gateway-wide.
 *   - GET /key/list?key_alias=<exact>&return_full_object=true -> the
 *     minted row (presence check for idempotence UX).
 *   - A key's user_id must reference an existing user row at auth time
 *     ("User doesn't exist in db… Create user via /user/new"), so the
 *     mint ensures a user row exists per agent first (idempotent:
 *     /user/new fails on duplicate -> treated as present).
 *   - allowed_routes matching is exact-or-prefix ("/v1/memory" alone
 *     covers "/v1/memory/<key>"); the mint sends both the bare route and
 *     the wildcard form for belt-and-braces across matching paths.
 */

/** Env keys this module reads; both live in the registrar service env. */
export const CREATOR_KEY_ENV = 'GATEWAY_KEY_CREATOR_KEY';
export const GATEWAY_BASE_URL_ENV = 'GATEWAY_KEY_MINT_BASE_URL';

/** The memory-API route lock stamped on every minted key. */
export const MEMORY_KEY_ALLOWED_ROUTES = ['/v1/memory', '/v1/memory/*'] as const;

/** Key alias scheme: deterministic per device + scope. */
export function memoryKeyAlias(agentName: string, scope: 'shared' | 'private'): string {
  // key_alias charset is validated gateway-side (a-zA-Z0-9_-/.@); the
  // separator keeps device names from colliding across scopes.
  const safe = agentName.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `memory-${scope}-${safe}`;
}

/** Env var names the minted keys are delivered under (bundle extra_env). */
export const MEMORY_KEY_ENV_VARS = {
  shared: 'GATEWAY_MEMORY_SHARED_KEY',
  private: 'GATEWAY_MEMORY_PRIVATE_KEY',
} as const;

export class MintConfigError extends Error {}
export class MintCallError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body: string | null,
  ) {
    super(message);
  }
}

export interface MintResult {
  scope: 'shared' | 'private';
  alias: string;
  /** The minted key value — shown once in the console, never stored. */
  key: string;
}

interface GatewayConfig {
  baseUrl: string;
  creatorKey: string;
}

export type { GatewayConfig };

/** Resolve gateway + creator-key config; throws MintConfigError when unset. */
export function resolveGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const baseUrl = (env[GATEWAY_BASE_URL_ENV] ?? '').trim();
  const creatorKey = (env[CREATOR_KEY_ENV] ?? '').trim();
  if (baseUrl === '' || creatorKey === '') {
    throw new MintConfigError(
      `memory-key mint is not configured: set ${CREATOR_KEY_ENV} and ${GATEWAY_BASE_URL_ENV} on the registrar service (the scoped key-creator key — never the master key; see docs/gateway-ops.md)`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), creatorKey };
}

export async function gatewayCall(
  cfg: GatewayConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> | null; raw: string }> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.creatorKey}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json, raw };
}

/**
 * Ensure a user row exists for the agent (idempotent). The minted keys
 * point user_id at this row; auth resolves the caller's role from it.
 */
async function ensureUser(cfg: GatewayConfig, agentName: string): Promise<void> {
  const userId = `agent-${agentName}`;
  const res = await gatewayCall(cfg, 'POST', '/user/new', {
    user_id: userId,
    user_alias: agentName,
    user_role: 'internal_user',
    auto_create_key: false,
  });
  // 200 = created; 409 {"error": "User with id … already exists"} = present.
  if (res.status === 200) return;
  if (res.status === 409) {
    const d = res.json?.detail;
    const errText =
      typeof d === 'object' && d !== null && typeof (d as Record<string, unknown>).error === 'string'
        ? String((d as Record<string, unknown>).error)
        : typeof d === 'string'
          ? d
          : res.raw ?? '';
    if (/already exists/i.test(errText)) return; // already present — idempotent
  }
  throw new MintCallError(`gateway /user/new for '${userId}' failed`, res.status, res.raw);
}

/**
 * Mint one route-restricted memory key for the agent.
 * The shared key joins the agent's team row (team-scoped visibility);
 * the private key carries no team (visible only to its own user).
 */
async function mintKey(
  cfg: GatewayConfig,
  agentName: string,
  scope: 'shared' | 'private',
  teamId: string | null,
): Promise<MintResult> {
  const alias = memoryKeyAlias(agentName, scope);
  const payload: Record<string, unknown> = {
    key_alias: alias,
    user_id: `agent-${agentName}`,
    allowed_routes: MEMORY_KEY_ALLOWED_ROUTES,
    metadata: { purpose: 'agent-memory', scope, agent: agentName },
  };
  if (scope === 'shared' && teamId !== null) {
    payload.team_id = teamId;
  }
  const res = await gatewayCall(cfg, 'POST', '/key/generate', payload);
  if (res.status !== 200) {
    throw new MintCallError(
      `gateway /key/generate for '${alias}' failed`,
      res.status,
      res.raw,
    );
  }
  const key = res.json?.key;
  if (typeof key !== 'string' || key === '') {
    throw new MintCallError(`gateway /key/generate for '${alias}' returned no key`, res.status, res.raw);
  }
  return { scope, alias, key };
}

/** Look up the agent team by id; null when absent (private keys need none). */
async function findTeamId(cfg: GatewayConfig, teamAlias: string): Promise<string | null> {
  // /team/list v1 returns a bare ARRAY of team rows; filter client-side.
  const res = await gatewayCall(cfg, 'GET', `/team/list`);
  if (res.status === 200 && Array.isArray(res.json)) {
    const hit = (res.json as Array<Record<string, unknown>>).find(
      (tm) => tm.team_id === teamAlias,
    );
    if (hit && typeof hit.team_id === 'string') return hit.team_id;
  }
  return null;
}

/** Ensure the shared team row exists and returns its id (idempotent). */
async function ensureTeam(cfg: GatewayConfig, agentName: string): Promise<string> {
  const teamAlias = `team-${agentName}`;
  const existing = await findTeamId(cfg, teamAlias);
  if (existing !== null) return existing;
  const res = await gatewayCall(cfg, 'POST', '/team/new', {
    team_id: teamAlias,
    team_alias: teamAlias,
  });
  if (res.status === 200 && res.json && typeof res.json.team_id === 'string') {
    return res.json.team_id;
  }
  // A concurrent create (or a stale team/list cache) may have raced us:
  // duplicate wording OR a fresh row both mean "exists" — idempotent.
  if (/already exists/i.test(res.raw ?? '')) {
    const raced = await findTeamId(cfg, teamAlias);
    if (raced !== null) return raced;
  }
  throw new MintCallError(`gateway /team/new for '${teamAlias}' failed`, res.status, res.raw);
}

/** Ensure the agent user is a member of their team (idempotent). */
async function ensureTeamMember(cfg: GatewayConfig, agentName: string, teamId: string): Promise<void> {
  const res = await gatewayCall(cfg, 'POST', '/team/member_add', {
    team_id: teamId,
    member: { user_id: `agent-${agentName}`, role: 'user' },
  });
  // 200 = added. Duplicate wording arrives as ProxyException detail
  // ("User already in team…") — match on the whole body, shape-agnostic.
  if (res.status === 200) return;
  if (/already (?:in|a member of) team|User already in team/i.test(res.raw ?? '')) return;
  throw new MintCallError(`gateway /team/member_add for 'agent-${agentName}' failed`, res.status, res.raw);
}

/**
 * Mint the full per-agent memory key set: shared (team-scoped) +
 * private. Returns the key values for one-time display. Never throws
 * MintConfigError silently — callers surface it as the fallback path.
 */
export async function mintMemoryKeys(
  env: Record<string, string | undefined>,
  agentName: string,
): Promise<{ shared: MintResult; private: MintResult }> {
  const cfg = resolveGatewayConfig(env);
  await ensureUser(cfg, agentName);
  const teamId = await ensureTeam(cfg, agentName);
  await ensureTeamMember(cfg, agentName, teamId);
  const shared = await mintKey(cfg, agentName, 'shared', teamId);
  const priv = await mintKey(cfg, agentName, 'private', null);
  return { shared, private: priv };
}

// ───────────────────────────────────────────────────────────────────────────
// Model-key provisioning (fleet-ops-1py.46)
//
// The console's third per-device key action: provision the agent's MODEL
// key — the virtual key a device authenticates LLM completions with,
// delivered as the GATEWAY_API_KEY line of config/agent.env (the same
// canonical the structured editor's gateway_api_key field writes). With
// memory keys (e5o.3) and the mesh identity (j7g.1) this completes
// onboarding: no hand-minted gateway credential is needed to bring a
// device online.
//
// Auth design reuses the e5o.3 scoped creator key verbatim — the
// j7g.1 route lock already covers the entire surface this action
// touches: /key/list (liveness probe), /user/new (user row),
// /key/generate (mint). No master key anywhere.
//
// Decision table (mirrors enrollAgent's MINT/OPEN/REFUSE):
//   MINT   — alias absent: ensure the agent's user row, mint the key.
//   OPEN   — alias live AND the bundle already carries a non-empty
//            GATEWAY_API_KEY: the bundle is the truth; nothing is
//            re-minted, nothing is mutated (the registrar never learns
//            the plaintext).
//   REFUSE — alias live and the bundle carries NOTHING: the plaintext
//            is unrecoverable; refuse with the exact recovery step
//            (revoke the alias in the LiteLLM console, re-run the mint)
//            — never orphan, never silently replace (the j7g.1 ruling).
//
// Route lock: completions-only, bare + `/*` belt-and-braces pairs (the
// memory mint's matching precedent). A model key serves the agent's
// model calls and nothing else — no key management, no mesh, no memory.
// ───────────────────────────────────────────────────────────────────────────

/** The completions route lock stamped on every minted model key. */
export const MODEL_KEY_ALLOWED_ROUTES = [
  '/v1/chat/completions',
  '/v1/chat/completions/*',
  '/v1/completions',
  '/v1/completions/*',
  '/v1/responses',
  '/v1/responses/*',
  '/v1/embeddings',
  '/v1/embeddings/*',
  '/v1/models',
  '/v1/models/*',
] as const;

/** Key alias scheme: deterministic per device. */
export function modelKeyAlias(agentName: string): string {
  // Same charset/sanitization contract as memoryKeyAlias: key_alias is
  // validated gateway-side (a-zA-Z0-9_-/.@).
  const safe = agentName.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `model-${safe}`;
}

/** Env var the minted key is delivered under — the device's main gateway key. */
export const MODEL_KEY_ENV_VAR = 'GATEWAY_API_KEY';

export interface ModelKeyProvisionResult {
  alias: string;
  /** 'mint' = fresh key minted (value set); 'open' = bundle already carries it (value null). */
  action: 'mint' | 'open';
  /** The minted key value — shown once in the console, never stored. Null on 'open'. */
  key: string | null;
}

/**
 * Alias live at the gateway while the device bundle carries no
 * GATEWAY_API_KEY — the plaintext is unrecoverable; the caller renders
 * the message, which names the console-revocation recovery step.
 */
export class ModelKeyAliasLiveError extends Error {
  constructor(
    public readonly alias: string,
    public readonly agentName: string,
  ) {
    super(
      `model key alias '${alias}' exists live on the gateway but device '${agentName}'s bundle carries no ${MODEL_KEY_ENV_VAR} — revoke the alias in the gateway console (LiteLLM /ui → Keys) and re-run the mint to provision fresh`,
    );
    this.name = 'ModelKeyAliasLiveError';
  }
}

/** Exact-alias /key/list probe; true when the alias exists (j7g.1 probe shape). */
async function findModelKeyRow(cfg: GatewayConfig, alias: string): Promise<boolean> {
  const res = await gatewayCall(
    cfg,
    'GET',
    `/key/list?key_alias=${encodeURIComponent(alias)}&return_full_object=true`,
  );
  if (res.status !== 200) {
    throw new MintCallError(
      `gateway /key/list for '${alias}' failed (HTTP ${res.status}: ${(res.raw ?? '').slice(0, 300)})`,
      res.status,
      res.raw,
    );
  }
  const keys = (res.json as { keys?: unknown[] } | null)?.keys;
  if (!Array.isArray(keys)) return false;
  return keys.some((k) => (k as Record<string, unknown>).key_alias === alias);
}

/** Mint one route-locked model key; plaintext returned ONCE. */
async function mintModelKey(cfg: GatewayConfig, agentName: string, alias: string): Promise<string> {
  const res = await gatewayCall(cfg, 'POST', '/key/generate', {
    key_alias: alias,
    user_id: `agent-${agentName}`,
    allowed_routes: [...MODEL_KEY_ALLOWED_ROUTES],
    metadata: { purpose: 'agent-model', agent: agentName },
    // team unset: the model key is the agent's PRIVATE serving credential —
    // the memory key's shared/private split does not apply.
  });
  if (res.status !== 200) {
    throw new MintCallError(`gateway /key/generate for '${alias}' failed`, res.status, res.raw);
  }
  const key = res.json?.key;
  if (typeof key !== 'string' || key === '') {
    throw new MintCallError(`gateway /key/generate for '${alias}' returned no key`, res.status, res.raw);
  }
  return key;
}

/**
 * Provision the per-device model key (MINT or OPEN). bundleCarriesKey is
 * the caller's bundle-truth probe — a non-empty GATEWAY_API_KEY line in
 * the CURRENT config/agent.env. Throws ModelKeyAliasLiveError on the
 * REFUSE arm; MintConfigError surfaces the manual fallback. Never
 * re-mints over a live alias.
 */
export async function provisionModelKey(
  env: Record<string, string | undefined>,
  agentName: string,
  bundleCarriesKey: boolean,
): Promise<ModelKeyProvisionResult> {
  const cfg = resolveGatewayConfig(env);
  const alias = modelKeyAlias(agentName);
  const aliasLive = await findModelKeyRow(cfg, alias);
  if (!aliasLive) {
    await ensureUser(cfg, agentName);
    const key = await mintModelKey(cfg, agentName, alias);
    return { alias, action: 'mint', key };
  }
  if (bundleCarriesKey) return { alias, action: 'open', key: null };
  throw new ModelKeyAliasLiveError(alias, agentName);
}