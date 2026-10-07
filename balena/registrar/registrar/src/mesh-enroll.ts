/**
 * A2A mesh enrollment (fleet-ops-j7g.1 shape B).
 *
 * The registrar-side action that mints (or opens) a VS gateway A2A
 * identity key in the SENTINEL SHAPE and merges it into BOTH sides of
 * the mesh — no owner-minted hand steps, no key material crossing to
 * any caller. Sibling of the e5o.3 memory-keys action
 * (gateway-mint.ts) with the same custody invariants:
 *
 *   - The gateway mint credential (scoped key-creator key) lives ONLY
 *     in the registrar service container. No agent env ever holds it.
 *   - The minted key's shape is fixed HERE, in registrar code —
 *     LiteLLM never constrains minted children, so shape control must
 *     be server-side. The caller's payload cannot override it: the API
 *     takes no shape parameters at all.
 *   - Plaintext key material NEVER crosses to the caller: the API
 *     returns {alias, merged} only. Keys ride the existing bundle
 *     delivery plane (0600, device-local) to the target agent.
 *   - A re-mint refuses an existing live key: the enroll never
 *     orphans or silently replaces a live credential. A COMPLETED
 *     enroll re-runs as an idempotent heal (verify + re-merge +
 *     re-register); a PARTIAL one (alias live, bundle empty) refuses
 *     with the exact recovery step.
 *   - Every outcome — success AND failure — writes an audit row.
 *
 * MINT vs OPEN:
 *   - Fresh enroll (alias absent at the gateway): MINT the sentinel.
 *   - Completed enroll (alias live + bundle carries it): OPEN — verify,
 *     re-merge, re-register. The heal path; also the ONLY path for the
 *     f57.14 sentinel vs-primus-a2a, which the owner minted by hand and
 *     whose plaintext only primus's bundle carries — the registrar can
 *     mint but never read key material back from the gateway.
 *   - Partial/foreign (alias live, bundle carries nothing/different):
 *     REFUSE — the plaintext is unrecoverable; the message names the
 *     console revocation step.
 *
 * The enroll also registers the agent's card row on the VS gateway
 * (POST /v1/agents, extra_headers ["Authorization"]) — the README's
 * j7g.1 mesh-rows step, automated: per-caller identity forwarding, no
 * secret stored on the row (source-verified on the pinned tag, the
 * AC14 precedent).
 *
 * Wire facts (gateway 1.100.1, same class as gateway-mint.ts):
 *   - POST /key/generate {key_alias, user_id, allowed_routes, metadata}
 *     -> 200 {key: "sk-…"}; alias unique gateway-wide.
 *   - GET /key/list?key_alias=<exact>&return_full_object=true -> the
 *     row (liveness probe; the mint/open/refuse decision input).
 *   - POST /v1/agents {agent_name, agent_card_params, litellm_params,
 *     extra_headers} -> 200; 409/400 on an existing name = already
 *     registered (idempotent).
 */

import { eq } from 'drizzle-orm';
import type { Executor } from './slots.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { identityBlobs, devices, gatewayCreatorKey } from './db/schema.js';
import { audit } from './audit.js';
import { rotateBundle } from './rotate.js';
import { hashKey } from './db/key-crypto.js';
import type { Clock } from './clock.js';
import {
  resolveGatewayConfig,
  gatewayCall,
  MintConfigError,
  type GatewayConfig,
} from './gateway-mint.js';

/**
 * Per-DEVICE mint rate limit (in-memory, the AuthRateLimiter posture):
 * a successful MINT per agent is allowed once per window (default
 * 1/hour — an enroll is a rare fleet act, not a routine call). OPEN
 * heals and refusals are NOT limited (idempotent re-runs must always
 * work; the guard exists to stop a runaway or hijacked caller from
 * minting a fan of keys). A rate-limited call audits before refusing.
 */
export const MESH_MINT_WINDOW_MS = 3_600_000;

export class MeshMintRateLimiter {
  private lastMintPerAgent = new Map<string, number>();

  constructor(private clock: Clock, private windowMs = MESH_MINT_WINDOW_MS) {}

  /** True when a MINT for this agent is allowed now. */
  mintAllowed(agentName: string): boolean {
    const last = this.lastMintPerAgent.get(agentName);
    if (last === undefined) return true;
    return this.clock.now().getTime() - last >= this.windowMs;
  }

  /** Record a successful mint. */
  recordMint(agentName: string): void {
    this.lastMintPerAgent.set(agentName, this.clock.now().getTime());
  }
}

/** Env keys this module reads (all on the registrar service env). */
export const MESH_CREATOR_KEY_ENV = 'GATEWAY_KEY_CREATOR_KEY';
export const MESH_GATEWAY_BASE_URL_ENV = 'GATEWAY_KEY_MINT_BASE_URL';
/** The composition master key — read ONLY by the one-time bootstrap. */
export const MESH_MASTER_KEY_ENV = 'LITELLM_MASTER_KEY';

/**
 * The SENTINEL SHAPE — hardcoded, server-side, non-negotiable.
 * LiteLLM does not constrain minted children, so the shape lives in
 * THIS code: models [] (no model calls), tpm unset (no throughput),
 * allowed_routes locked to the mesh surface. The API route accepts no
 * shape parameters; a caller cannot widen any of it.
 */
export const MESH_KEY_ALLOWED_ROUTES = ['/a2a', '/a2a/*', '/v1/agents'] as const;
export const MESH_KEY_USER_ID = 'vs-mesh';
export const MESH_KEY_METADATA_PURPOSE = 'vs-a2a-mesh-identity';

/** The f57.14 sentinel alias for primus (the owner-minted OPEN case). */
export const PRIMUS_A2A_ALIAS = 'vs-primus-a2a';

/** Key alias scheme: deterministic per agent. */
export function meshKeyAlias(agentName: string): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `vs-${safe}-a2a`;
}

export class MeshEnrollError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_configured'
      | 'device_not_found'
      | 'no_bundle'
      | 'alias_live'
      | 'gateway_call'
      | 'merge_failed',
    public readonly status: 400 | 404 | 409 | 429 | 500 | 502,
  ) {
    super(message);
    this.name = 'MeshEnrollError';
  }
}

export interface MeshEnrollOutcome {
  alias: string;
  /** 'mint' = fresh sentinel key minted; 'open' = existing key verified + heals applied. */
  action: 'mint' | 'open';
  merged: true;
  bundleVersion: number;
}

/** One bundle file as stored in the identity blob. */
interface BundleFile {
  path: string;
  content: string;
}

/** Look up a key row by exact alias; null when absent. */
async function findKeyRow(
  cfg: GatewayConfig,
  alias: string,
): Promise<Record<string, unknown> | null> {
  const res = await gatewayCall(
    cfg,
    'GET',
    `/key/list?key_alias=${encodeURIComponent(alias)}&return_full_object=true`,
  );
  if (res.status !== 200) {
    throw new MeshEnrollError(
      `gateway /key/list for '${alias}' failed (HTTP ${res.status}: ${(res.raw ?? '').slice(0, 300)})`,
      'gateway_call',
      502,
    );
  }
  const keys = (res.json as { keys?: unknown[] } | null)?.keys;
  if (Array.isArray(keys) && keys.length > 0) {
    const row = keys[0] as Record<string, unknown>;
    if (typeof row.key_alias === 'string' && row.key_alias === alias) return row;
  }
  return null;
}

/** Mint one sentinel-shape A2A identity key; plaintext returned ONCE. */
async function mintMeshKey(
  cfg: GatewayConfig,
  agentName: string,
): Promise<{ alias: string; key: string }> {
  const alias = meshKeyAlias(agentName);
  const payload: Record<string, unknown> = {
    key_alias: alias,
    user_id: MESH_KEY_USER_ID,
    allowed_routes: MESH_KEY_ALLOWED_ROUTES,
    metadata: {
      purpose: MESH_KEY_METADATA_PURPOSE,
      agent: agentName,
      minted_by: 'registrar-mesh-enroll',
    },
    // models: [] and tpm unset — the sentinel shape, hardcoded here
  };
  const res = await gatewayCall(cfg, 'POST', '/key/generate', payload);
  if (res.status !== 200) {
    throw new MeshEnrollError(
      `gateway /key/generate for '${alias}' failed (HTTP ${res.status}: ${(res.raw ?? '').slice(0, 300)})`,
      'gateway_call',
      502,
    );
  }
  const key = res.json?.key;
  if (typeof key !== 'string' || key === '') {
    throw new MeshEnrollError(
      `gateway /key/generate for '${alias}' returned no key`,
      'gateway_call',
      502,
    );
  }
  return { alias, key };
}

/** Ensure the mesh user row exists (idempotent, the gateway-mint pattern). */
async function ensureMeshUser(cfg: GatewayConfig): Promise<void> {
  const res = await gatewayCall(cfg, 'POST', '/user/new', {
    user_id: MESH_KEY_USER_ID,
    user_alias: 'vs a2a mesh identities',
    user_role: 'internal_user',
    auto_create_key: false,
  });
  if (res.status === 200) return;
  if (res.status === 409 && /already exists/i.test(res.raw ?? '')) return;
  throw new MeshEnrollError(
    `gateway /user/new for '${MESH_KEY_USER_ID}' failed (HTTP ${res.status})`,
    'gateway_call',
    502,
  );
}

/** Register the agent's card row on the VS gateway; true when created this call. */
async function registerAgentRow(
  cfg: GatewayConfig,
  agentName: string,
  originUrl: string,
): Promise<boolean> {
  const res = await gatewayCall(cfg, 'POST', '/v1/agents', {
    agent_name: agentName,
    agent_card_params: {
      protocolVersion: '1.0',
      name: agentName,
      description: `VS mesh agent ${agentName} (registrar mesh-enroll)`,
      url: originUrl,
      version: '1.0.0',
      capabilities: { streaming: false },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    },
    litellm_params: {},
    extra_headers: ['Authorization'],
  });
  if (res.status === 200) return true;
  if (res.status === 409 || res.status === 400) {
    // Name already registered / validation shape on re-registration —
    // the row serving is the goal (the AC14 idempotence precedent).
    return false;
  }
  throw new MeshEnrollError(
    `gateway /v1/agents for '${agentName}' failed (HTTP ${res.status}: ${(res.raw ?? '').slice(0, 300)})`,
    'gateway_call',
    502,
  );
}

/** Parse config/a2a.json from a bundle's file list; null when absent/malformed. */
export function readA2aFromBundle(files: BundleFile[]): Record<string, unknown> | null {
  const f = files.find((x) => x.path === 'config/a2a.json');
  if (!f) return null;
  try {
    const parsed = JSON.parse(f.content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed a2a.json — treated as absent by the merge (fresh start)
  }
  return null;
}

/** The a2a.json identity_key value, '' when absent. */
export function bundleIdentityKey(files: BundleFile[]): string {
  const a2a = readA2aFromBundle(files);
  const k = a2a?.identity_key;
  return typeof k === 'string' ? k : '';
}

/** Union-dedupe string lists. */
function mergeNames(existing: unknown, add: string[]): string[] {
  const base = Array.isArray(existing)
    ? existing.filter((p): p is string => typeof p === 'string')
    : [];
  return [...base, ...add].filter((v, i, a) => a.indexOf(v) === i);
}

/** Render the next config/a2a.json content for a bundle merge. */
export function renderA2aJson(
  current: Record<string, unknown> | null,
  updates: {
    identityKey?: string;
    publicUrl?: string;
    addTrustedPeers?: string[];
    addPeerTokens?: Record<string, string>;
  },
): string {
  const obj: Record<string, unknown> = { ...(current ?? {}) };
  if (updates.identityKey !== undefined) obj.identity_key = updates.identityKey;
  if (updates.publicUrl !== undefined) obj.public_url = updates.publicUrl;
  if (updates.addTrustedPeers !== undefined) {
    obj.trusted_peers = mergeNames(obj.trusted_peers, updates.addTrustedPeers);
  }
  if (updates.addPeerTokens !== undefined) {
    const tokens: Record<string, string> = {
      ...((obj.peer_tokens as Record<string, string> | undefined) ?? {}),
      ...updates.addPeerTokens,
    };
    obj.peer_tokens = tokens;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

/** One mesh peer: its agent name, device id, and its OWN identity key. */
export interface MeshPeer {
  agentName: string;
  deviceId: string;
  identityKey: string;
}

/**
 * Resolve the mesh peers of the target: every OTHER device row whose
 * bundle carries an A2A identity (config/a2a.json with identity_key).
 * The peer's identity key is read from its own bundle server-side —
 * the registrar DB is the only place both sides are ever visible.
 */
export async function resolveMeshPeers(
  db: Executor,
  targetAgentName: string,
): Promise<MeshPeer[]> {
  const rows = await db
    .select({
      agentName: devices.agentName,
      deviceId: devices.balenaUuid,
      status: devices.status,
      bundle: identityBlobs.bundle,
    })
    .from(devices)
    .innerJoin(identityBlobs, eq(identityBlobs.deviceId, devices.balenaUuid))
    .where(eq(devices.status, 'active'));
  const peers: MeshPeer[] = [];
  for (const row of rows) {
    if (row.agentName === targetAgentName) continue;
    const files = ((row.bundle as { files?: BundleFile[] }).files ?? []) as BundleFile[];
    const key = bundleIdentityKey(files);
    if (key !== '') peers.push({ agentName: row.agentName, deviceId: row.deviceId, identityKey: key });
  }
  return peers;
}

export interface MeshEnrollOptions {
  keyId: string | null;
  sourceIp: string | null;
  /** The target agent's A2A origin URL (the gateway card row's dial target). */
  originUrl: string;
  /** The mesh edge URL written into the target's public_url. */
  publicUrl: string;
  clock: Clock;
  /** Per-device mint rate limiter (required; route-owned instance). */
  mintLimiter: MeshMintRateLimiter;
}

/**
 * Enroll one agent into the A2A mesh. The caller MUST have
 * authenticated via the mesh-enroll machine key. Every failure path
 * audits before throwing.
 */
export async function enrollAgent(
  db: NodePgDatabase,
  env: Record<string, string | undefined>,
  agentName: string,
  opts: MeshEnrollOptions,
): Promise<MeshEnrollOutcome> {
  const { clock } = opts;
  const fail = async (deviceId: string | null, reason: string) => {
    await audit(db, {
      deviceId,
      outcome: 'denied',
      reason,
      keyId: opts.keyId,
      sourceIp: opts.sourceIp,
      occurredAt: clock.now(),
    });
  };

  // ── Target device + bundle ───────────────────────────────────────────
  const devRows = await db.select().from(devices).where(eq(devices.agentName, agentName));
  if (devRows.length === 0) {
    await fail(null, 'mesh_enroll_device_not_found');
    throw new MeshEnrollError(`no device row for agent '${agentName}'`, 'device_not_found', 404);
  }
  const deviceId = devRows[0].balenaUuid;
  const blobRows = await db.select().from(identityBlobs).where(eq(identityBlobs.deviceId, deviceId));
  if (blobRows.length === 0) {
    await fail(deviceId, 'mesh_enroll_no_bundle');
    throw new MeshEnrollError(
      `device '${agentName}' has no identity bundle yet`,
      'no_bundle',
      404,
    );
  }
  const currentBundle = blobRows[0].bundle as { files: BundleFile[] };

  // ── Gateway config ───────────────────────────────────────────────────
  let cfg: GatewayConfig;
  try {
    cfg = resolveGatewayConfig(env);
  } catch (err) {
    await fail(deviceId, 'mesh_enroll_not_configured');
    if (err instanceof MintConfigError) {
      throw new MeshEnrollError(err.message, 'not_configured', 500);
    }
    throw err;
  }

  const alias = meshKeyAlias(agentName);
  const bundleKey = bundleIdentityKey(currentBundle.files);
  const existingRow = await findKeyRow(cfg, alias);

  // ── MINT / OPEN / REFUSE decision ────────────────────────────────────
  let action: 'mint' | 'open';
  let identityKey: string;
  if (existingRow === null) {
    // Per-device mint rate limit: refuses BEFORE the mint when the same
    // agent minted within the window. Audits the refusal.
    if (!opts.mintLimiter.mintAllowed(agentName)) {
      await fail(deviceId, 'mesh_enroll_mint_rate_limited');
      throw new MeshEnrollError(
        `mint rate limit: agent '${agentName}' minted within the last hour — an enroll is a rare fleet act; if this mint is intentional, wait the window or restart the registrar to clear the in-memory limiter`,
        'alias_live',
        429,
      );
    }
    await ensureMeshUser(cfg);
    const minted = await mintMeshKey(cfg, agentName).catch(async (err) => {
      await fail(deviceId, 'mesh_enroll_mint_failed');
      throw err;
    });
    opts.mintLimiter.recordMint(agentName);
    action = 'mint';
    identityKey = minted.key;
  } else if (bundleKey !== '') {
    // Alias live AND the bundle already carries an identity — completed
    // enroll (or the f57.14 sentinel): OPEN, the idempotent heal path.
    // The registrar never learns the plaintext; the bundle is the truth.
    action = 'open';
    identityKey = bundleKey;
  } else {
    // Alias live but the bundle carries NOTHING: a partial enroll or a
    // foreign hand-mint. The plaintext is unrecoverable — refuse with
    // the exact recovery step; never orphan, never silently replace.
    await fail(deviceId, 'mesh_enroll_alias_live');
    throw new MeshEnrollError(
      `key alias '${alias}' exists live on the gateway but agent '${agentName}'s bundle carries no identity_key — revoke the alias in the gateway console (LiteLLM /ui → Keys) and re-run the enroll to mint fresh`,
      'alias_live',
      409,
    );
  }

  // ── Register the gateway card row (idempotent; safe to re-run) ───────
  await registerAgentRow(cfg, agentName, opts.originUrl).catch(async (err) => {
    await fail(deviceId, 'mesh_enroll_register_failed');
    throw err;
  });

  // ── Merge leg 1: the target's own bundle ─────────────────────────────
  // identity_key + public_url + every peer in trusted_peers AND
  // peer_tokens (the peer's OWN key — inbound caller resolution).
  const peers = await resolveMeshPeers(db, agentName);
  const targetA2a = readA2aFromBundle(currentBundle.files);
  const peerTokenAdds: Record<string, string> = {};
  for (const peer of peers) peerTokenAdds[peer.agentName] = peer.identityKey;
  const targetNext = renderA2aJson(targetA2a, {
    identityKey,
    publicUrl: opts.publicUrl,
    addTrustedPeers: peers.map((p) => p.agentName),
    addPeerTokens: peerTokenAdds,
  });

  // ── Merge leg 2: every existing peer's bundle ────────────────────────
  // Each peer gains the target in trusted_peers + peer_tokens (the
  // target's key — so calls from the target resolve + are trusted).
  const peerNexts = new Map<string, string>();
  for (const peer of peers) {
    const peerBlob = await db
      .select()
      .from(identityBlobs)
      .where(eq(identityBlobs.deviceId, peer.deviceId));
    if (peerBlob.length === 0) continue;
    const peerBundle = peerBlob[0].bundle as { files: BundleFile[] };
    const peerA2a = readA2aFromBundle(peerBundle.files);
    peerNexts.set(
      peer.deviceId,
      renderA2aJson(peerA2a, {
        addTrustedPeers: [agentName],
        addPeerTokens: { [agentName]: identityKey },
      }),
    );
  }

  // ── Apply through the rotate plane (each merge its own transaction) ─
  try {
    const keep = new Set(
      currentBundle.files.map((f) => f.path).filter((p) => p !== 'config/a2a.json'),
    );
    const result = await rotateBundle(
      db,
      clock,
      deviceId,
      {
        kind: 'merge',
        keep,
        updates: new Map([['config/a2a.json', targetNext]]),
        additions: [],
      },
      {
        keyId: opts.keyId,
        sourceIp: opts.sourceIp,
        reason: action === 'mint' ? 'mesh_enrolled_mint' : 'mesh_enrolled_open',
      },
    );
    for (const [peerUuid, peerNext] of peerNexts) {
      const peerBlobRows = await db
        .select()
        .from(identityBlobs)
        .where(eq(identityBlobs.deviceId, peerUuid));
      if (peerBlobRows.length === 0) continue;
      const peerBundle = peerBlobRows[0].bundle as { files: BundleFile[] };
      await rotateBundle(
        db,
        clock,
        peerUuid,
        {
          kind: 'merge',
          keep: new Set(peerBundle.files.map((f) => f.path).filter((p) => p !== 'config/a2a.json')),
          updates: new Map([['config/a2a.json', peerNext]]),
          additions: [],
        },
        {
          keyId: opts.keyId,
          sourceIp: opts.sourceIp,
          reason: `mesh_peer_token_merged:${agentName}`,
        },
      );
    }
    await audit(db, {
      deviceId,
      outcome: 'admin',
      reason: action === 'mint' ? 'mesh_enrolled_mint' : 'mesh_enrolled_open',
      keyId: opts.keyId,
      sourceIp: opts.sourceIp,
      occurredAt: clock.now(),
    });
    return { alias, action, merged: true, bundleVersion: result.version };
  } catch (err) {
    await fail(deviceId, 'mesh_enroll_merge_failed');
    if (err instanceof MeshEnrollError) throw err;
    throw new MeshEnrollError(
      `bundle merge failed for '${agentName}': ${err instanceof Error ? err.message : String(err)}`,
      'merge_failed',
      500,
    );
  }
}

/**
 * Creator-key bootstrap (the j7g.1 design call: registrar-side, zero
 * owner console steps). Runs ONLY when GATEWAY_KEY_CREATOR_KEY is unset
 * on the service env. The registrar's only persistence is its DB, which
 * stores hashes — a bootstrapped plaintext can never be recovered, so
 * the bootstrap is SELF-HEALING PER BOOT instead of one-shot:
 *
 *   - env set                          -> bootstrap never runs (env wins).
 *   - no marker + no gateway alias     -> fresh bootstrap: mint the
 *     scoped key-creator key once from the composition master key,
 *     persist its argon2id hash as the marker. (fresh gateway; the
 *     e2e case; the live master today — the e5o.3 setup was never
 *     hand-run.)
 *   - marker row exists (registrar-managed) -> RE-MINT: delete the old
 *     alias via the master key, mint a fresh one, update the marker.
 *     Restarts are rare; the churn is two gateway calls per boot.
 *   - no marker + alias exists (owner hand-mint) -> REFUSE: destroying
 *     a credential the owner holds in his password manager is the
 *     hardening-owner-lockout class. The message names the manual step.
 *
 * The creator key's route lock EXTENDS the e5o.3 lock with /v1/agents —
 * the enroll registers the agent's card row with the creator key (the
 * master key is used ONLY by this bootstrap, never by the enroll's
 * steady-state calls). The value never crosses to any API caller and
 * is never persisted plaintext anywhere.
 */
export async function bootstrapCreatorKey(
  db: NodePgDatabase,
  env: Record<string, string | undefined>,
): Promise<string> {
  const masterKey = (env[MESH_MASTER_KEY_ENV] ?? '').trim();
  const baseUrl = (env[MESH_GATEWAY_BASE_URL_ENV] ?? '').trim().replace(/\/+$/, '');
  if (masterKey === '' || baseUrl === '') {
    throw new MeshEnrollError(
      `mesh enroll is not configured: set ${MESH_CREATOR_KEY_ENV} (the scoped key-creator key) on the registrar service, or set ${MESH_MASTER_KEY_ENV} to let the registrar bootstrap it — see docs/gateway-ops.md`,
      'not_configured',
      500,
    );
  }
  const cfg: GatewayConfig = { baseUrl, creatorKey: masterKey };
  const marker = await db.select().from(gatewayCreatorKey).limit(1);
  const aliasRow = await findKeyRow(cfg, 'key-creator').catch(() => null);

  if (marker.length === 0 && aliasRow !== null) {
    // The owner hand-ran the e5o.3 setup: his credential, his custody.
    throw new MeshEnrollError(
      `a 'key-creator' alias exists at the gateway but ${MESH_CREATOR_KEY_ENV} is unset and the registrar never bootstrapped it — set the env var to your hand-minted key's value (the e5o.3 README one-time setup), or delete the alias in the console to let the registrar manage it`,
      'not_configured',
      500,
    );
  }

  if (marker.length > 0 && aliasRow !== null) {
    // Registrar-managed: delete the old alias so the re-mint lands.
    // Best-effort: a failed delete surfaces at the generate below.
    const token = typeof aliasRow.token === 'string' ? aliasRow.token : null;
    if (token !== null) {
      await gatewayCall(cfg, 'POST', '/key/delete', { keys: [token] }).catch(() => null);
    }
  }

  const userRes = await gatewayCall(cfg, 'POST', '/user/new', {
    user_id: 'key-creator',
    user_alias: 'registrar key creator',
    user_role: 'proxy_admin',
    auto_create_key: false,
  });
  if (userRes.status !== 200 && !(userRes.status === 409 && /already exists/i.test(userRes.raw ?? ''))) {
    throw new MeshEnrollError(
      `bootstrap /user/new failed (HTTP ${userRes.status}: ${(userRes.raw ?? '').slice(0, 300)})`,
      'gateway_call',
      502,
    );
  }
  const mintRes = await gatewayCall(cfg, 'POST', '/key/generate', {
    key_alias: 'key-creator',
    user_id: 'key-creator',
    // The e5o.3 mint surface + the enroll's own surface (the liveness
    // probe reads /key/list; the card-row registration rides
    // /v1/agents) — the union both mint actions share on a
    // bootstrapped gateway.
    allowed_routes: [
      '/user/new',
      '/team/new',
      '/team/list',
      '/team/member_add',
      '/key/generate',
      '/key/list',
      '/v1/agents',
    ],
  });
  if (mintRes.status !== 200) {
    throw new MeshEnrollError(
      `bootstrap /key/generate failed (HTTP ${mintRes.status}: ${(mintRes.raw ?? '').slice(0, 300)})`,
      'gateway_call',
      502,
    );
  }
  const key = mintRes.json?.key;
  if (typeof key !== 'string' || key === '') {
    throw new MeshEnrollError('bootstrap /key/generate returned no key', 'gateway_call', 502);
  }
  const keyHash = await hashKey(key);
  if (marker.length > 0) {
    await db.update(gatewayCreatorKey).set({ keyHash }).where(eq(gatewayCreatorKey.alias, 'key-creator'));
  } else {
    await db.insert(gatewayCreatorKey).values({ keyHash, alias: 'key-creator' });
  }
  return key;
}