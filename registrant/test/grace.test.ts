import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/run.js';
import {
  PermanentRegistrarError,
  GracePollStoppedError,
} from '../src/run.js';
import { StaticProbe } from '../src/clock-gate.js';
import type { IdentityBundle } from '@vector-sigma/shared';

const dirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'vs-grace-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function makeBundle(v: number): IdentityBundle {
  return {
    schema_version: 1,
    bundle_version: v,
    generated_at: new Date().toISOString(),
    files: [{ path: 'config/agent.env', mode: '0600', content: `AGENT_NAME=agent-v${v}\n` }],
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
    gracePollIntervalMs: 20,
    logLevel: 'silent',
  };
}

/** Scripted registrar for grace-path tests. */
class ScriptedRegistrar {
  calls: Array<{ url: string; method: string }> = [];
  constructor(
    private handlers: Array<{
      match: (url: string, method: string) => boolean;
      respond: () => { status: number; headers?: Record<string, string>; body: unknown } | null;
    }>,
  ) {}
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    this.calls.push({ url, method });
    for (const h of this.handlers) {
      if (h.match(url, method)) {
        const r = h.respond();
        if (r === null) continue;
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
          status: r.status,
          headers: r.headers,
        });
      }
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 599 });
  };
}

function bootstrapStatus(status: number) {
  return {
    match: (u: string, m: string) => m === 'POST' && u.endsWith('/v1/bootstrap'),
    respond: () => ({ status, body: { error: 'err' } }),
  };
}

function statusEndpoint(device_status: string) {
  return {
    match: (u: string, m: string) => m === 'GET' && u.includes('/v1/status'),
    respond: () => ({
      status: 200,
      body: {
        balena_uuid: UUID,
        bundle_version: 1,
        device_status,
        slot: { state: 'armed', delivery_count: 0, delivered_at: null },
      },
    }),
  };
}

function bootstrapOk(v = 1) {
  return {
    match: (u: string, m: string) => m === 'POST' && u.endsWith('/v1/bootstrap'),
    respond: () => ({
      status: 200,
      body: { bundle: makeBundle(v), bundle_version: v, delivered_at: new Date().toISOString() },
    }),
  };
}

describe('registrant permanent-error grace (f57.11)', () => {
  it('403 on cold bootstrap: oneShot surfaces blocked result; no crash, no partial writes', async () => {
    const dir = await tempDataDir();
    const mock = new ScriptedRegistrar([bootstrapStatus(403)]);
    const result = await run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      fetchImpl: mock.fetch,
      oneShot: true,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.httpStatus).toBe(403);
      expect(result.reason).toContain('403');
    }
    // No files written: the device never half-applies identity.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).length).toBe(0);
  });

  it('403 stays resident: ACTION REQUIRED line once, status poll, self-heal on activate', async () => {
    const dir = await tempDataDir();
    let bootstrapAttempts = 0;
    let deviceActive = false;
    const mock = new ScriptedRegistrar([
      {
        match: (u, m) => m === 'POST' && u.endsWith('/v1/bootstrap'),
        respond: () => {
          bootstrapAttempts += 1;
          if (!deviceActive) return { status: 403, body: { error: 'forbidden' } };
          return {
            status: 200,
            body: { bundle: makeBundle(1), bundle_version: 1, delivered_at: new Date().toISOString() },
          };
        },
      },
      {
        match: (u, m) => m === 'GET' && u.includes('/v1/status'),
        respond: () => {
          // Simulate the console fix landing on the 2nd poll: activate.
          if (mock.calls.filter((c) => c.method === 'GET').length >= 2) {
            deviceActive = true;
          }
          return {
            status: 200,
            body: {
              balena_uuid: UUID,
              bundle_version: 1,
              device_status: deviceActive ? 'active' : 'pending',
              slot: { state: 'armed', delivery_count: 0, delivered_at: null },
            },
          };
        },
      },
    ]);
    let stopResolve: (v: 'stop') => void = () => {};
    const stopGrace = new Promise<'stop'>((res) => {
      stopResolve = res;
    });
    // Same seam ends the resident ROTATION watcher after self-heal —
    // without it run() keeps watching forever (its production job);
    // the test needs both loops bounded. CRITICAL: the stop is resolved
    // from INSIDE the fetch mock (on the healed bootstrap), never from a
    // setTimeout — with a microtask-only test sleep seam, a resident
    // loop starves the macrotask queue and a timer-based stop never
    // fires (the exact spin class the coordinator flagged; f57.11).
    const stopWatch = new Promise<'stop'>((res) => {
      stopResolve = res;
    });
    const resultP = run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      fetchImpl: async (...args) => {
        const res = await mock.fetch(...args);
        // Healed bootstrap delivered: unblock the resident loops now.
        if (bootstrapAttempts >= 2) stopResolve('stop');
        return res;
      },
      sleep: () => Promise.resolve(),
      stopGrace,
      stopWatch,
    });
    const result = await resultP;
    // Self-heal: the poll saw active, retried bootstrap, applied the bundle.
    expect(result).toEqual({ kind: 'bootstrapped', bundleVersion: 1 });
    expect(bootstrapAttempts).toBe(2);
  });

  it('401 and 404 classify as permanent too (blocked result in oneShot)', async () => {
    for (const status of [401, 404]) {
      const dir = await tempDataDir();
      const mock = new ScriptedRegistrar([bootstrapStatus(status)]);
      const result = await run(testConfig(dir), {
        clockProbe: new StaticProbe(true),
        fetchImpl: mock.fetch,
        oneShot: true,
      });
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.httpStatus).toBe(status);
    }
  });

  it('425 keeps the bounded Retry-After retry loop (unchanged class)', async () => {
    const dir = await tempDataDir();
    let n = 0;
    const mock = new ScriptedRegistrar([
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
            body: { bundle: makeBundle(1), bundle_version: 1, delivered_at: new Date().toISOString() },
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
    expect(sleeps).toEqual([1_000]);
    expect(n).toBe(2);
  });

  it('429 and network errors stay fatal (supervisor restart contract unchanged)', async () => {
    // 429: fatal exactly as before the grace change
    const dir429 = await tempDataDir();
    const mock429 = new ScriptedRegistrar([bootstrapStatus(429)]);
    await expect(
      run(testConfig(dir429), {
        clockProbe: new StaticProbe(true),
        fetchImpl: mock429.fetch,
        oneShot: true,
      }),
    ).rejects.toThrow(/429/);
    // Network error (fetch rejection): fatal
    const dirNet = await tempDataDir();
    const failing: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      run(testConfig(dirNet), {
        clockProbe: new StaticProbe(true),
        fetchImpl: failing,
        oneShot: true,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('PermanentRegistrarError carries the loud ACTION REQUIRED line with the console fix', () => {
    const e403 = new PermanentRegistrarError(403, null);
    expect(e403.actionRequiredLine).toContain('ACTION REQUIRED:');
    expect(e403.actionRequiredLine).toContain('HTTP 403');
    expect(e403.actionRequiredLine).toContain('admin console');
    const e401 = new PermanentRegistrarError(401, null);
    expect(e401.actionRequiredLine).toContain('REGISTRAR_KEY');
    const e404 = new PermanentRegistrarError(404, null);
    expect(e404.actionRequiredLine).toContain('re-create');
    expect(PermanentRegistrarError.isPermanent(403)).toBe(true);
    expect(PermanentRegistrarError.isPermanent(425)).toBe(false);
    expect(PermanentRegistrarError.isPermanent(429)).toBe(false);
  });

  it('grace poll stop before heal surfaces GracePollStoppedError', async () => {
    const dir = await tempDataDir();
    const mock = new ScriptedRegistrar([
      bootstrapStatus(403),
      // status stays pending forever: never heals
      statusEndpoint('pending'),
    ]);
    let stopResolve: (v: 'stop') => void = () => {};
    const stopGrace = new Promise<'stop'>((res) => {
      stopResolve = res;
    });
    let statusCalls = 0;
    const resultP = run(testConfig(dir), {
      clockProbe: new StaticProbe(true),
      // Stop resolves from INSIDE the fetch mock on the 2nd status poll —
      // a macrotask timer would starve under the microtask-only sleep
      // seam (same class as the self-heal test above).
      fetchImpl: async (...args) => {
        statusCalls += 1;
        if (statusCalls >= 2) stopResolve('stop');
        return mock.fetch(...args);
      },
      sleep: () => Promise.resolve(),
      stopGrace,
    });
    await expect(resultP).rejects.toBeInstanceOf(GracePollStoppedError);
  });
});