/**
 * Registrant refusal and recovery branches not reached by the main run/grace suites: corrupt
 * local state, malformed guard files, 425 wait fallbacks, a non-timeout clock failure, a
 * partial console fix during the grace loop, and a failed status poll in the rotation watcher.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IdentityBundle } from '@vector-sigma/shared';
import { RegistrarClient } from '../src/client.js';
import { StaticProbe, type ClockProbe } from '../src/clock-gate.js';
import { IdentityStore } from '../src/identity-store.js';
import { bootstrapWithRetry, PermanentRegistrarError, reportA2aIdentity, run } from '../src/run.js';

process.env.REGISTRANT_TEST_QUIET = '1';
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'vs-branches-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const bundle = (v: number): IdentityBundle => ({
  schema_version: 1,
  bundle_version: v,
  generated_at: '2026-01-01T00:00:00Z',
  files: [{ path: 'config/agent.env', mode: '0600', content: `V=${v}\n` }],
});

const config = (dataDir: string) => ({
  balenaDeviceUuid: UUID,
  registrarUrl: 'https://reg.example',
  registrarKey: 'k-1234567890abcdef',
  dataDir,
  clockGateTimeoutMs: 60_000,
  watchIntervalMs: 20,
  gracePollIntervalMs: 20,
  logLevel: 'silent',
});

const reply = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const statusBody = (device_status: string, bundle_version: number | null = null) => ({
  balena_uuid: UUID,
  device_status,
  bundle_version,
  slot: { state: 'armed', delivery_count: 0, delivered_at: null },
});

describe('local identity state', () => {
  it.each([
    ['not JSON', '{nope'],
    ['JSON of the wrong shape', JSON.stringify({ schema_version: 2, files: [] })],
  ])('a %s bundle.json reads as no identity, so the device bootstraps again', async (_label, raw) => {
    const dir = await tempDir();
    const store = new IdentityStore(dir);
    await store.applyBundle(bundle(1));
    const bundlePath = (store as unknown as { bundlePath(): string }).bundlePath();
    await writeFile(bundlePath, raw);
    expect(await store.readBundle()).toBeNull();
    // ...and run() then fetches a fresh identity instead of trusting the broken file.
    let bootstraps = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/v1/bootstrap')) {
        bootstraps += 1;
        return reply(200, { bundle: bundle(2), bundle_version: 2, delivered_at: '2026-01-01T00:00:00Z' });
      }
      return reply(404, {});
    }) as unknown as typeof fetch;
    const result = await run(config(dir), { clockProbe: new StaticProbe(true), fetchImpl, oneShot: true });
    expect(result).toEqual({ kind: 'bootstrapped', bundleVersion: 2 });
    expect(bootstraps).toBe(1);
    expect((await store.readBundle())?.bundle_version).toBe(2);
  });
});

describe('console-fix guidance', () => {
  it('a terminal status outside 401/403/404 still names where to look', () => {
    const e = new PermanentRegistrarError(410, null);
    expect(e.actionRequiredLine).toMatch(/^ACTION REQUIRED: .*admin console.*audit log.*\(HTTP 410\)$/);
  });
});

describe('reportA2aIdentity: malformed guard files', () => {
  it('a pubkey.json whose ed25519 is not a string is treated as no key (no call)', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'a2a-guard'), { recursive: true });
    await writeFile(path.join(dir, 'a2a-guard', 'pubkey.json'), JSON.stringify({ ed25519: 42 }));
    const fetchImpl = vi.fn();
    const client = new RegistrarClient('https://reg.example', UUID, 'k', fetchImpl as unknown as typeof fetch);
    expect(await reportA2aIdentity(config(dir), client, 1)).toBe('absent');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a status.json that is not an object is reported as no guard status, never forwarded', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'a2a-guard'), { recursive: true });
    await writeFile(path.join(dir, 'a2a-guard', 'pubkey.json'), JSON.stringify({ ed25519: 'A'.repeat(43) }));
    await writeFile(path.join(dir, 'a2a-guard', 'status.json'), JSON.stringify(['running']));
    let sent: Record<string, unknown> | undefined;
    const client = new RegistrarClient('https://reg.example', UUID, 'k', (async (_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return reply(200, { status: 'active', fingerprint: 'f' });
    }) as unknown as typeof fetch);
    expect(await reportA2aIdentity(config(dir), client, 3)).toBe('reported');
    expect(sent).toMatchObject({ guard_status: null, bundle_version: 3 });
  });
});

describe('bootstrapWithRetry: 425 wait fallbacks', () => {
  it.each([
    ['the body retry_after_seconds when there is no Retry-After header', { retry_after_seconds: 7 }, 7000],
    ['1 s when the registrar gives no wait at all', {}, 1000],
  ])('waits %s', async (_label, body425, expectedMs) => {
    let calls = 0;
    const client = new RegistrarClient('https://reg.example', UUID, 'k', (async () =>
      ++calls === 1 ? reply(425, { error: 'too_early', ...body425 }) : reply(200, { bundle: bundle(1), bundle_version: 1, delivered_at: 'x' })) as unknown as typeof fetch);
    const sleep = vi.fn(async () => undefined);
    expect((await bootstrapWithRetry(client, { sleep })).bundle_version).toBe(1);
    expect(sleep).toHaveBeenCalledWith(expectedMs);
  });
});

describe('run(): failures that must not be swallowed or crash the resident', () => {
  it('a clock probe that throws (not a timeout) aborts boot instead of proceeding', async () => {
    const dir = await tempDir();
    const probe: ClockProbe = { isSynchronized: async () => Promise.reject(new Error('probe exploded')) };
    await expect(run(config(dir), { clockProbe: probe, fetchImpl: vi.fn() as unknown as typeof fetch, oneShot: true })).rejects.toThrow(
      'probe exploded',
    );
  });

  it('a partial console fix (active, but the key is still refused) keeps the grace loop polling', async () => {
    const dir = await tempDir();
    let bootstraps = 0;
    let stop: (v: 'stop') => void = () => {};
    const stopGrace = new Promise<'stop'>((res) => (stop = res));
    const fetchImpl = (async (url: string) => {
      if (url.includes('/v1/status')) return reply(200, statusBody('active'));
      bootstraps += 1;
      if (bootstraps >= 3) stop('stop'); // cold refusal + two refused self-heal attempts
      return reply(401, { error: 'unauthorized' });
    }) as unknown as typeof fetch;
    await expect(run(config(dir), { clockProbe: new StaticProbe(true), fetchImpl, sleep: async () => undefined, stopGrace })).rejects.toThrow();
    expect(bootstraps).toBeGreaterThanOrEqual(3);
  });

  it('a failed status poll in the rotation watcher is logged and the watcher keeps going', async () => {
    const dir = await tempDir();
    await new IdentityStore(dir).applyBundle(bundle(1));
    let polls = 0;
    let stop: (v: 'stop') => void = () => {};
    const stopWatch = new Promise<'stop'>((res) => (stop = res));
    const fetchImpl = (async (url: string) => {
      if (url.includes('/v1/status')) {
        polls += 1;
        if (polls >= 2) stop('stop');
        return polls === 1 ? reply(500, { error: 'internal_error' }) : reply(200, statusBody('active', 1));
      }
      return reply(404, {});
    }) as unknown as typeof fetch;
    const result = await run(config(dir), { clockProbe: new StaticProbe(true), fetchImpl, sleep: async () => undefined, stopWatch });
    expect(result).toEqual({ kind: 'preexisting', bundleVersion: 1 });
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});
