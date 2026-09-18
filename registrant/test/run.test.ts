import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdentityStore } from '../src/identity-store.js';
import { StaticProbe } from '../src/clock-gate.js';
import { run } from '../src/run.js';
import type { IdentityBundle } from '@vector-sigma/shared';

const dirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'vs-run-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function makeBundle(
  v: number,
  files?: Array<{ path: string; content: string }>,
): IdentityBundle {
  return {
    schema_version: 1,
    bundle_version: v,
    generated_at: new Date().toISOString(),
    files: (files ?? [{ path: '.env', content: `API_KEY=secret-v${v}\n` }]).map((f) => ({
      path: f.path,
      mode: '0600' as const,
      content: f.content,
    })),
  };
}

const UUID = '123e4567-e89b-12d3-a456-426614174000';

function testConfig(dataDir: string) {
  return {
    balenaDeviceUuid: UUID,
    registrarUrl: 'https://reg.example',
    registrarKey: 'k-1234567890abcdef',
    dataDir,
    clockGateTimeoutMs: 60_000,
    watchIntervalMs: 20,
    logLevel: 'silent',
  };
}

/** Mocked registrar: scripted responses matched by url+method, in order. */
class MockRegistrar {
  calls: Array<{ url: string; method: string; auth: string | null }> = [];
  constructor(
    private scripts: Array<{
      match: (url: string, method: string) => boolean;
      respond: () => { status: number; headers?: Record<string, string>; body: unknown };
    }>,
  ) {}
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const auth = (init?.headers as Record<string, string>)?.['authorization'] ?? null;
    this.calls.push({ url, method, auth });
    for (const s of this.scripts) {
      if (s.match(url, method)) {
        const r = s.respond();
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
          status: r.status,
          headers: r.headers,
        });
      }
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 599 });
  };
}

describe('run() against mocked registrar', () => {
  it('AC2: pre-provisioned device writes marker without any fetch', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    await store.applyBundle(makeBundle(2));
    await rm(store.markerPath());
    const mock = new MockRegistrar([]);
    const result = await run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      fetchImpl: mock.fetch,
      oneShot: true,
    });
    expect(result).toEqual({ kind: 'preexisting', bundleVersion: 2 });
    expect(mock.calls.length).toBe(0);
    expect(await store.isReady()).toBe(true);
  });

  it('AC3: cold device bootstraps, writes 0600 + marker', async () => {
    const dir = await tempDataDir();
    const mock = new MockRegistrar([
      {
        match: (u, m) => m === 'POST' && u.endsWith('/v1/bootstrap'),
        respond: () => ({
          status: 200,
          body: {
            bundle: makeBundle(1, [{ path: 'agent.env', content: 'TOKEN=t1\n' }]),
            bundle_version: 1,
            delivered_at: new Date().toISOString(),
          },
        }),
      },
    ]);
    const result = await run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      fetchImpl: mock.fetch,
      oneShot: true,
    });
    expect(result).toEqual({ kind: 'bootstrapped', bundleVersion: 1 });
    const env = path.join(dir, 'agent.env');
    expect(await readFile(env, 'utf8')).toBe('TOKEN=t1\n');
    const { stat } = await import('node:fs/promises');
    expect((await stat(env)).mode & 0o777).toBe(0o600);
    expect(await new IdentityStore(dir).isReady()).toBe(true);
  });

  it('AC4: refused wire bundle never partially applied', async () => {
    const dir = await tempDataDir();
    const mock = new MockRegistrar([
      {
        match: (u, m) => m === 'POST' && u.endsWith('/v1/bootstrap'),
        respond: () => ({
          status: 200,
          body: {
            bundle: {
              schema_version: 1,
              bundle_version: 1,
              generated_at: new Date().toISOString(),
              files: [
                { path: 'ok.txt', content: 'ok', mode: '0600' },
                { path: 'bad.txt', content: 'x', mode: '0644' },
              ],
            },
            bundle_version: 1,
            delivered_at: new Date().toISOString(),
          },
        }),
      },
    ]);
    await expect(
      run(testConfig(dir), {
        clockProbe: new StaticProbe(true),
        fetchImpl: mock.fetch,
        oneShot: true,
      }),
    ).rejects.toThrow(/bundle rejected/);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).length).toBe(0);
  });

  it('425: honors Retry-After, then succeeds', async () => {
    const dir = await tempDataDir();
    let n = 0;
    const mock = new MockRegistrar([
      {
        match: (u, m) => m === 'POST' && u.endsWith('/v1/bootstrap'),
        respond: () => {
          n += 1;
          if (n === 1) {
            return {
              status: 425,
              headers: { 'retry-after': '1' },
              body: { error: 'too_early', retry_after_seconds: 1 },
            };
          }
          return {
            status: 200,
            body: {
              bundle: makeBundle(1),
              bundle_version: 1,
              delivered_at: new Date().toISOString(),
            },
          };
        },
      },
    ]);
    const sleeps: number[] = [];
    const result = await run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      fetchImpl: mock.fetch,
      oneShot: true,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ kind: 'bootstrapped', bundleVersion: 1 });
    expect(n).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('425 exhausted after 5 attempts → fatal, no partial writes', async () => {
    const dir = await tempDataDir();
    const mock = new MockRegistrar([
      {
        match: (u, m) => m === 'POST' && u.endsWith('/v1/bootstrap'),
        respond: () => ({
          status: 425,
          headers: { 'retry-after': '1' },
          body: { error: 'too_early', retry_after_seconds: 1 },
        }),
      },
    ]);
    await expect(
      run(testConfig(dir), {
        clockProbe: new StaticProbe(true),
        fetchImpl: mock.fetch,
        oneShot: true,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/425/);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).length).toBe(0);
  });

  it('AC5: rotation — local v1, remote v2 → refetch lands v2', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    await store.applyBundle(makeBundle(1));
    let bootstraps = 0;
    let stopResolve: ((v: 'stop') => void) | null = null;
    const stopWatch = new Promise<'stop'>((res) => {
      stopResolve = res;
    });
    const mock = new MockRegistrar([
      {
        match: (u, m) => m === 'POST' && u.endsWith('/v1/bootstrap'),
        respond: () => {
          bootstraps += 1;
          return {
            status: 200,
            body: {
              bundle: makeBundle(2, [{ path: '.env', content: 'API_KEY=secret-v2\n' }]),
              bundle_version: 2,
              delivered_at: new Date().toISOString(),
            },
          };
        },
      },
      {
        match: (u, m) => m === 'GET' && u.includes('/v1/status'),
        respond: () => ({
          status: 200,
          body: {
            balena_uuid: UUID,
            bundle_version: 2,
            device_status: 'active',
            slot: { state: 'armed', delivery_count: 1, delivered_at: null },
          },
        }),
      },
    ]);
    let rotated = false;
    const result = await run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      fetchImpl: mock.fetch,
      sleep: () => Promise.resolve(),
      onRotation: () => {
        rotated = true;
        stopResolve?.('stop');
      },
      stopWatch,
    });
    expect(result).toEqual({ kind: 'preexisting', bundleVersion: 1 });
    expect(rotated).toBe(true);
    expect(bootstraps).toBe(1);
    expect((await store.readBundle())?.bundle_version).toBe(2);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('API_KEY=secret-v2\n');
  });
});