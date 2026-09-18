import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdentityStore } from '../src/identity-store.js';
import { waitForClock, ClockGateTimeout, StaticProbe } from '../src/clock-gate.js';
import { loadConfig } from '../src/config.js';
import type { IdentityBundle } from '@vector-sigma/shared';

process.env.REGISTRANT_TEST_QUIET = '1';

const dirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'vs-test-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

export function makeBundle(
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

export async function fileMode(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777;
}

export async function dirIsEmpty(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0;
}

/**
 * True when /dev/shm sits on a different filesystem than os.tmpdir() — the
 * fleet-Pi topology (root-fs /tmp vs tmpfs /dev/shm) that reproduces the
 * volume-vs-container EXDEV locally, without docker. The test below is
 * skipped on hosts whose mount topology cannot reproduce it.
 */
function shmOnSeparateDevice(): boolean {
  try {
    return statSync('/dev/shm').dev !== statSync(tmpdir()).dev;
  } catch {
    return false;
  }
}

describe('clock gate', () => {
  it('AC1: blocks until NTP reports synchronized', async () => {
    const waits: number[] = [];
    let calls = 0;
    const probe = {
      async isSynchronized() {
        calls += 1;
        return calls >= 3;
      },
    };
    await waitForClock({
      probe,
      timeoutMs: 60_000,
      pollIntervalMs: 10,
      sleep: () => Promise.resolve(),
      onWait: (e) => waits.push(e),
    });
    expect(calls).toBe(3);
    expect(waits.length).toBe(2);
  });

  it('AC1: ClockGateTimeout when NTP never converges (boot proceeds best-effort)', async () => {
    await expect(
      waitForClock({
        probe: new StaticProbe(false),
        timeoutMs: 50,
        pollIntervalMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
    ).rejects.toThrow(ClockGateTimeout);
  });
});

describe('config', () => {
  it('requires uuid/url/key, strips trailing slash, defaults the rest', () => {
    const c = loadConfig({
      BALENA_DEVICE_UUID: '123e4567-e89b-12d3-a456-426614174000',
      REGISTRAR_URL: 'https://registrar.example.com/',
      REGISTRAR_KEY: 'k-1234567890abcdef',
    });
    expect(c.registrarUrl).toBe('https://registrar.example.com');
    expect(c.dataDir).toBe('/data/agent');
    expect(c.watchIntervalMs).toBe(300_000);
    expect(c.clockGateTimeoutMs).toBe(600_000);
  });

  it('rejects invalid env with a field list', () => {
    expect(() => loadConfig({})).toThrow(/invalid registrant configuration/);
  });
});

describe('identity store', () => {
  it('AC3: happy path writes all files 0600 + snapshot + ready marker', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    const b = makeBundle(1, [
      { path: '.env', content: 'A=b\n' },
      { path: 'sub/dir/token', content: 'tok' },
    ]);
    await store.applyBundle(b);
    for (const f of b.files) {
      const p = path.join(dir, f.path);
      expect(await readFile(p, 'utf8')).toBe(f.content);
      expect(await fileMode(p)).toBe(0o600);
    }
    expect((await store.readBundle())?.bundle_version).toBe(1);
    expect(await store.isReady()).toBe(true);
    expect((await store.readMarker())?.startsWith('bundle_version=1')).toBe(true);
  });

  it('AC4: refused bundle (bad mode) never partially applied', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    const bad = {
      schema_version: 1,
      bundle_version: 1,
      generated_at: new Date().toISOString(),
      files: [
        { path: 'a.txt', content: 'aa', mode: '0600' },
        { path: 'b.txt', content: 'bb', mode: '0644' },
      ],
    };
    await expect(store.applyBundle(bad as never)).rejects.toThrow(/bundle rejected/);
    expect(await dirIsEmpty(dir)).toBe(true);
    expect(await store.isReady()).toBe(false);
  });

  it('AC4: unsafe path (../) refused, nothing applied', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    const evil = makeBundle(1, [{ path: '../escape.txt', content: 'nope' }]);
    await expect(store.applyBundle(evil)).rejects.toThrow(/bundle rejected|unsafe path/);
    expect(await dirIsEmpty(dir)).toBe(true);
  });

  // Regression for the run-3 E2E blocker (devpi05, d9b2b28): staging via
  // mkdtemp(os.tmpdir()) renames onto a volume-backed dataDir — rename(2)
  // cannot cross filesystems, so the FIRST applied file dies EXDEV and the
  // device can never bootstrap. Reproduced here by putting the data dir on
  // tmpfs (/dev/shm) while staging goes to the root-fs tmpdir.
  it.skipIf(!shmOnSeparateDevice())(
    'applyBundle works when dataDir is on a different device than os.tmpdir() (EXDEV regression)',
    async () => {
      const dir = await mkdtemp(path.join('/dev/shm', 'vs-xdevice-'));
      dirs.push(dir);
      const store = new IdentityStore(dir);
      const b = makeBundle(1, [{ path: '.env', content: 'A=b\n' }]);
      await store.applyBundle(b);
      expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=b\n');
      expect(await fileMode(path.join(dir, '.env'))).toBe(0o600);
      expect(await store.isReady()).toBe(true);
      expect((await readdir(dir)).sort()).toEqual([
        '.env',
        'identity-bundle.json',
        'ready.marker',
      ]);
    },
  );

  it('readBundle: absent → null; invalid JSON → null; valid → bundle', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    expect(await store.readBundle()).toBeNull();
    await store.applyBundle(makeBundle(3));
    expect((await store.readBundle())?.bundle_version).toBe(3);
  });
});