import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdentityStore } from '../src/identity-store.js';
import { waitForClock, ClockGateTimeout, StaticProbe, HostClockProbe } from '../src/clock-gate.js';
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
  files?: Array<{ path: string; content: string; encoding?: 'base64' }>,
): IdentityBundle {
  return {
    schema_version: 1,
    bundle_version: v,
    generated_at: new Date().toISOString(),
    files: (files ?? [{ path: '.env', content: `API_KEY=secret-v${v}\n` }]).map((f) => ({
      // 1py.5: spread whole — picked keys here would strip `encoding`
      // from binary test payloads before the store ever sees them.
      ...f,
      mode: '0600' as const,
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

  // fleet-ops-1py.4 regression: the AC the lane exists for. The old
  // SystemdTimesyncdProbe could never observe sync on balenaOS 8
  // (chronyd host, no timesyncd flag, no /run bind mount), so EVERY
  // container start paid the full 600s. HostClockProbe must converge
  // on the first poll when the wall clock is at/after the baked build
  // epoch — the state of every NTP-synced host.
  it('AC1py.4: converges on the first poll on a synced host — no 600s timeout', async () => {
    const dir = await tempDataDir();
    const epochPath = path.join(dir, 'build-epoch');
    await writeFile(epochPath, `${Date.now()}\n`);
    const waits: number[] = [];
    await waitForClock({
      probe: new HostClockProbe({
        epochPaths: [epochPath],
        timesyncdFlagPaths: [], // hermetic: force the epoch signal
      }),
      timeoutMs: 600_000,
      onWait: (e) => waits.push(e),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(waits).toEqual([]); // zero waits: instant convergence
  });
});

describe('clock gate probe (HostClockProbe, fleet-ops-1py.4)', () => {
  it('wall clock at/after the baked build epoch reads synchronized (chronyd host: no flag needed)', async () => {
    const dir = await tempDataDir();
    const epochPath = path.join(dir, 'build-epoch');
    await writeFile(epochPath, '1759300000000\n');
    const probe = new HostClockProbe({
      epochPaths: [epochPath],
      timesyncdFlagPaths: [], // hermetic: force the epoch signal
      now: () => 1759300000001,
    });
    expect(await probe.isSynchronized()).toBe(true);
  });

  it('pre-epoch wall clock (no-RTC cold boot: 1970 or shutdown skew) stays unsynchronized', async () => {
    const dir = await tempDataDir();
    const epochPath = path.join(dir, 'build-epoch');
    await writeFile(epochPath, '1759300000000\n');
    const probe = new HostClockProbe({
      epochPaths: [epochPath],
      timesyncdFlagPaths: [], // hermetic: force the epoch signal
      now: () => 86_400_000,
    });
    expect(await probe.isSynchronized()).toBe(false);
  });

  it('systemd-timesyncd flag, when exposed, still reports synchronized', async () => {
    const dir = await tempDataDir();
    const flag = path.join(dir, 'synchronized');
    await writeFile(flag, '');
    const probe = new HostClockProbe({
      timesyncdFlagPaths: [flag],
      epochPaths: [],
      now: () => 86_400_000,
    });
    expect(await probe.isSynchronized()).toBe(true);
  });

  it('no flag and no readable epoch file => false (fail-safe: keep waiting, gate fails open)', async () => {
    const dir = await tempDataDir();
    const probe = new HostClockProbe({
      timesyncdFlagPaths: [path.join(dir, 'no-flag')],
      epochPaths: [path.join(dir, 'no-epoch')],
      now: () => Date.now(),
    });
    expect(await probe.isSynchronized()).toBe(false);
  });

  it('garbage epoch file is ignored, not trusted (fail-safe on parse)', async () => {
    const dir = await tempDataDir();
    const epochPath = path.join(dir, 'build-epoch');
    await writeFile(epochPath, 'not-a-number\n');
    const probe = new HostClockProbe({
      epochPaths: [epochPath],
      timesyncdFlagPaths: [], // hermetic: force the epoch signal
      now: () => Date.now(),
    });
    expect(await probe.isSynchronized()).toBe(false);
  });
});

describe('config', () => {
  it('requires uuid/url/key, strips trailing slash, defaults the rest', () => {
    const c = loadConfig({
      BALENA_DEVICE_UUID: '123e4567-e89b-12d3-a456-426614174000',
      REGISTRAR_URL: 'https://registrar.example.com/',
      REGISTRAR_KEY: 'k-1234567890abcdef',
      // f57.13: https test URLs ride with a provisioned CA — the contract
      // every real https deployment satisfies (the shim's NODE_EXTRA_CA_CERTS).
      NODE_EXTRA_CA_CERTS: '/tmp/test-vs-ca.pem',
    });
    expect(c.registrarUrl).toBe('https://registrar.example.com');
    expect(c.dataDir).toBe('/data/agent');
    expect(c.watchIntervalMs).toBe(300_000);
    expect(c.clockGateTimeoutMs).toBe(600_000);
    // f57.11: grace poll default matches the owner-ruled 5-minute status poll
    expect(c.gracePollIntervalMs).toBe(300_000);
  });

  it('GRACE_POLL_INTERVAL_MS overrides the default (E2E shortens it)', () => {
    const c = loadConfig({
      BALENA_DEVICE_UUID: '123e4567-e89b-12d3-a456-426614174000',
      REGISTRAR_URL: 'https://registrar.example.com',
      REGISTRAR_KEY: 'k-1234567890abcdef',
      NODE_EXTRA_CA_CERTS: '/tmp/test-vs-ca.pem', // f57.13 https contract
      GRACE_POLL_INTERVAL_MS: '2000',
    });
    expect(c.gracePollIntervalMs).toBe(2000);
  });

  it('rejects invalid env with a field list', () => {
    expect(() => loadConfig({})).toThrow(/invalid registrant configuration/);
  });

  // balena injects BALENA_DEVICE_UUID UNDASHED (32 hex chars — the live
  // fleet shows b1e516d9cf23c6bd0b474edae9ec41e6). zod's .uuid() rejects
  // that form, so config load would crash-loop a real device at boot.
  // Regression: the platform value is normalized to canonical dashed
  // form before it reaches the registrar API contract.
  it('normalizes the undashed balena platform UUID to dashed form', () => {
    const c = loadConfig({
      BALENA_DEVICE_UUID: 'b1e516d9cf23c6bd0b474edae9ec41e6',
      REGISTRAR_URL: 'https://registrar.example.com',
      REGISTRAR_KEY: 'k-1234567890abcdef',
      NODE_EXTRA_CA_CERTS: '/tmp/test-vs-ca.pem', // f57.13 https contract
    });
    expect(c.balenaDeviceUuid).toBe(
      'b1e516d9-cf23-c6bd-0b47-4edae9ec41e6',
    );
  });

  it('still accepts the dashed form unchanged', () => {
    const c = loadConfig({
      BALENA_DEVICE_UUID: '123e4567-e89b-12d3-a456-426614174000',
      REGISTRAR_URL: 'https://registrar.example.com',
      REGISTRAR_KEY: 'k-1234567890abcdef',
      NODE_EXTRA_CA_CERTS: '/tmp/test-vs-ca.pem', // f57.13 https contract
    });
    expect(c.balenaDeviceUuid).toBe('123e4567-e89b-12d3-a456-426614174000');
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

  // ---- fleet-ops-1py.5: base64 (binary) bundle files ---------------------

  it('1py.5: base64-encoded file decodes to exact BYTES on disk', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    // Binary PNG-shaped payload incl. NUL, high bytes, and the PNG magic —
    // every byte class a UTF-8 text write would mangle.
    const logoBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28]),
    ]);
    const b = makeBundle(1, [
      { path: 'assets/logo.png', content: logoBytes.toString('base64'), encoding: 'base64' },
    ]);
    await store.applyBundle(b as never);
    const onDisk = await readFile(path.join(dir, 'assets/logo.png'));
    expect(Buffer.isBuffer(onDisk)).toBe(true);
    expect(onDisk.equals(logoBytes)).toBe(true);
    expect(await fileMode(path.join(dir, 'assets/logo.png'))).toBe(0o600);
  });

  it('1py.5: mixed bundle — text files unchanged, binary files decoded', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    const logoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const b = makeBundle(1, [
      { path: 'config/agent.env', content: 'AGENT_NAME=mixed\n' },
      { path: 'assets/logo.png', content: logoBytes.toString('base64'), encoding: 'base64' },
    ]);
    await store.applyBundle(b as never);
    expect(await readFile(path.join(dir, 'config/agent.env'), 'utf8')).toBe('AGENT_NAME=mixed\n');
    expect((await readFile(path.join(dir, 'assets/logo.png'))).equals(logoBytes)).toBe(true);
  });

  it('1py.5: oversize base64 file (>256KB decoded) rejected whole-bundle', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    const big = Buffer.alloc(256 * 1024 + 1, 0x41);
    const b = makeBundle(1, [
      { path: 'config/agent.env', content: 'A=b\n' },
      { path: 'assets/huge.bin', content: big.toString('base64'), encoding: 'base64' },
    ]);
    await expect(store.applyBundle(b as never)).rejects.toThrow(/bundle rejected|256KB|over the/i);
    expect(await store.isReady()).toBe(false);
  });

  it('1py.5: non-base64 (invalid) encoding value rejected by the shared schema', async () => {
    const dir = await tempDataDir();
    const store = new IdentityStore(dir);
    const b = makeBundle(1, [{ path: 'a.txt', content: 'aa' }]);
    (b.files[0] as Record<string, unknown>)['encoding'] = 'hex';
    await expect(store.applyBundle(b as never)).rejects.toThrow(/bundle rejected/i);
  });
});