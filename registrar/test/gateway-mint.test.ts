import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * gateway-mint unit contract (fleet-ops-e5o.3).
 *
 * The console's "mint memory keys" action talks to the VS gateway with a
 * SCOPED key-creator key. These tests pin the client's wire behavior
 * against a mocked fetch — the auth design gate's invariants:
 *
 *   1. Config gate: no creator key => MintConfigError naming BOTH env
 *      vars (the manual-mint fallback path, never a master-key path).
 *   2. Mint order: /user/new (idempotent) -> /team/new (idempotent) ->
 *      /team/member_add (idempotent) -> /key/generate x2.
 *   3. Idempotence: 409 "already exists" on /user/new is swallowed;
 *      "already in team" on member_add is swallowed; both re-mint fine.
 *   4. Route lock: every /key/generate payload carries
 *      allowed_routes=["/v1/memory", "/v1/memory/*"].
 *   5. Scopes: the shared key carries team_id; the private key does NOT.
 *   6. Aliases: deterministic memory-{scope}-{agent} scheme; the env
 *      var names match the plugin's requires_env contract.
 *   7. Failure surface: non-200 /key/generate raises MintCallError with
 *      status + body (never a silent success).
 *   8. The creator key NEVER appears in any error message or body echo
 *      beyond what the gateway itself returned (we never log the key).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  mintMemoryKeys,
  resolveGatewayConfig,
  memoryKeyAlias,
  MEMORY_KEY_ENV_VARS,
  MEMORY_KEY_ALLOWED_ROUTES,
  CREATOR_KEY_ENV,
  GATEWAY_BASE_URL_ENV,
  MintConfigError,
  MintCallError,
} = await import('../src/gateway-mint.js');

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

const calls: Call[] = [];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let route: Array<(c: Call) => Response> = [];

beforeEach(() => {
  calls.length = 0;
  route = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      calls.push(c);
      const handler = route[Math.min(calls.length - 1, route.length - 1)];
      return handler(c);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENV = {
  GATEWAY_KEY_CREATOR_KEY: 'sk-creator-test',
  GATEWAY_KEY_MINT_BASE_URL: 'http://gateway:4000',
};

describe('resolveGatewayConfig', () => {
  it('requires both env vars, names them in the error', () => {
    expect(() => resolveGatewayConfig({})).toThrowError(/GATEWAY_KEY_CREATOR_KEY/);
    expect(() => resolveGatewayConfig({})).toThrowError(/GATEWAY_KEY_MINT_BASE_URL/);
    expect(() => resolveGatewayConfig({})).toThrowError(MintConfigError);
  });

  it('strips trailing slashes from the base URL', () => {
    const cfg = resolveGatewayConfig({
      GATEWAY_KEY_CREATOR_KEY: 'sk-x',
      GATEWAY_KEY_MINT_BASE_URL: 'http://gw:4000///',
    });
    expect(cfg.baseUrl).toBe('http://gw:4000');
  });
});

describe('memoryKeyAlias + env var contract', () => {
  it('aliases are deterministic per agent + scope', () => {
    expect(memoryKeyAlias('wheeljack', 'shared')).toBe('memory-shared-wheeljack');
    expect(memoryKeyAlias('wheeljack', 'private')).toBe('memory-private-wheeljack');
  });

  it('aliases sanitize unsafe characters (gateway key_alias charset)', () => {
    expect(memoryKeyAlias('agent one!', 'shared')).toBe('memory-shared-agent-one-');
  });

  it('env var names match the plugin requires_env contract', () => {
    expect(MEMORY_KEY_ENV_VARS.shared).toBe('GATEWAY_MEMORY_SHARED_KEY');
    expect(MEMORY_KEY_ENV_VARS.private).toBe('GATEWAY_MEMORY_PRIVATE_KEY');
  });

  it('the route lock is exactly the memory API', () => {
    expect([...MEMORY_KEY_ALLOWED_ROUTES]).toEqual(['/v1/memory', '/v1/memory/*']);
  });
});

describe('mintMemoryKeys', () => {
  it('happy path: user -> team -> member -> two keys, route-locked, scoped right', async () => {
    route = [
      () => respond(200, { user_id: 'agent-wheeljack' }),                                  // 1 /user/new
      () => respond(200, []),                                                             // 2 /team/list (absent)
      () => respond(200, { team_id: 'team-wheeljack', team_alias: 'team-wheeljack' }),     // 3 /team/new
      () => respond(200, { team_id: 'team-wheeljack' }),                                   // 4 /team/member_add
      () => respond(200, { key: 'sk-mem-shared-1' }),                                     // 5 /key/generate shared
      () => respond(200, { key: 'sk-mem-private-1' }),                                     // 6 /key/generate private
    ];
    const out = await mintMemoryKeys(ENV, 'wheeljack');

    expect(out.shared.key).toBe('sk-mem-shared-1');
    expect(out.private.key).toBe('sk-mem-private-1');

    const paths = calls.map((c) => c.url.replace('http://gateway:4000', ''));
    expect(paths).toEqual([
      '/user/new', '/team/list', '/team/new', '/team/member_add', '/key/generate', '/key/generate',
    ]);

    // every call is creator-key authed
    for (const c of calls) {
      expect(c.headers['authorization']).toBe('Bearer sk-creator-test');
    }

    // /user/new: the per-agent row the keys will point at
    expect(calls[0].body).toMatchObject({ user_id: 'agent-wheeljack', auto_create_key: false });

    // shared key: team-scoped + route-locked
    expect(calls[4].body).toMatchObject({
      key_alias: 'memory-shared-wheeljack',
      user_id: 'agent-wheeljack',
      team_id: 'team-wheeljack',
      allowed_routes: ['/v1/memory', '/v1/memory/*'],
    });
    // private key: NO team, route-locked
    expect(calls[5].body).toMatchObject({
      key_alias: 'memory-private-wheeljack',
      user_id: 'agent-wheeljack',
      allowed_routes: ['/v1/memory', '/v1/memory/*'],
    });
    expect(calls[5].body).not.toHaveProperty('team_id');
  });

  it('idempotent re-mint: 409 user-exists, team already listed, member already in team all pass', async () => {
    route = [
      () => respond(409, { detail: { error: 'User with id agent-wheeljack already exists' } }),
      () => respond(200, [{ team_id: 'team-wheeljack', team_alias: 'team-wheeljack' }]),
      () => respond(400, { detail: 'User already in team. Member: user_id=agent-wheeljack' }),
      () => respond(200, { key: 'sk-mem-shared-2' }),
      () => respond(200, { key: 'sk-mem-private-2' }),
    ];
    const out = await mintMemoryKeys(ENV, 'wheeljack');
    expect(out.shared.key).toBe('sk-mem-shared-2');
    const paths = calls.map((c) => c.url.replace('http://gateway:4000', ''));
    expect(paths).toEqual(['/user/new', '/team/list', '/team/member_add', '/key/generate', '/key/generate']);
  });

  it('a mint failure surfaces status + body, never a silent success', async () => {
    route = [
      () => respond(200, { user_id: 'agent-wheeljack' }),
      () => respond(200, []),
      () => respond(200, { team_id: 'team-wheeljack' }),
      () => respond(200, {}),
      () => respond(500, { detail: 'boom' }),
    ];
    await expect(mintMemoryKeys(ENV, 'wheeljack')).rejects.toThrowError(MintCallError);
    try {
      await mintMemoryKeys(ENV, 'wheeljack');
    } catch (e) {
      expect(e).toBeInstanceOf(MintCallError);
      const err = e as MintCallError;
      expect(err.status).toBe(500);
      expect(err.body).toContain('boom');
    }
  });

  it('missing creator config refuses BEFORE any network call (never falls back to master)', async () => {
    const env = { ...ENV } as Record<string, string | undefined>;
    delete env[CREATOR_KEY_ENV];
    delete env[GATEWAY_BASE_URL_ENV];
    await expect(mintMemoryKeys(env, 'wheeljack')).rejects.toThrowError(MintConfigError);
    expect(calls.length).toBe(0);
  });

  it('a key/generate response without a key string is a MintCallError', async () => {
    route = [
      () => respond(200, { user_id: 'agent-wheeljack' }),
      () => respond(200, [{ team_id: 'team-wheeljack' }]),
      () => respond(200, {}),
      () => respond(200, { key: '' }),
    ];
    await expect(mintMemoryKeys(ENV, 'wheeljack')).rejects.toThrowError(/no key/);
  });
});