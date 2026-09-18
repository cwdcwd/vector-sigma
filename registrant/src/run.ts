import type { ClockProbe } from './clock-gate.js';
import { ClockGateTimeout, waitForClock } from './clock-gate.js';
import type { RegistrantConfig } from './config.js';
import { RegistrarClient, RegistrarHttpError } from './client.js';
import { IdentityStore } from './identity-store.js';
import type { IdentityBundle, StatusSuccess } from '@vector-sigma/shared';

/** Boot outcome for the entrypoint / tests. */
export type BootResult =
  | { kind: 'preexisting'; bundleVersion: number }
  | { kind: 'bootstrapped'; bundleVersion: number };

export interface RunOptions {
  clockProbe: ClockProbe;
  fetchImpl: typeof fetch;
  /** Skip the resident rotation watcher (tests / one-shot mode). */
  oneShot?: boolean;
  /** Test seam: called after a rotation is applied. */
  onRotation?: (b: IdentityBundle) => Promise<void> | void;
  /** Test seam for deterministic watch timing. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam: resolves 'stop' to end the resident watcher cleanly
   * (production passes nothing — the watcher runs forever).
   */
  stopWatch?: Promise<'stop'> | null;
}

const log = (level: string, msg: string, data?: unknown) =>
  process.env.REGISTRANT_TEST_QUIET
    ? undefined
    : console.log(`[registrant:${level}] ${msg}`, data ?? '');

/**
 * Boot path per spec §Registrant:
 * 1. clock gate → 2. identity check (skip fetch if bundle present) →
 * 3. bootstrap (bounded 425 retry) → 4/5/6. atomic apply + marker →
 * 7. resident rotation watcher.
 */
export async function run(
  config: RegistrantConfig,
  opts: RunOptions,
): Promise<BootResult> {
  const store = new IdentityStore(config.dataDir);
  const client = new RegistrarClient(
    config.registrarUrl,
    config.balenaDeviceUuid,
    config.registrarKey,
    opts.fetchImpl,
  );

  // 1. Clock gate — best-effort on timeout; TLS is the natural guard.
  try {
    await waitForClock({
      probe: opts.clockProbe,
      timeoutMs: config.clockGateTimeoutMs,
      sleep: opts.sleep,
    });
  } catch (err) {
    if (err instanceof ClockGateTimeout) {
      log('warn', err.message);
    } else throw err;
  }

  // 2. Identity check: provisioned devices never re-fetch at boot.
  const existing = await store.readBundle();
  if (existing !== null) {
    if (!(await store.isReady())) {
      // Snapshot present but marker lost: re-apply from the snapshot.
      await store.applyBundle(existing);
    }
    log('info', 'identity present, skipping fetch', { bundle_version: existing.bundle_version });
    if (!opts.oneShot) {
      await watchForRotation(config, store, client, opts, existing.bundle_version);
    }
    return { kind: 'preexisting', bundleVersion: existing.bundle_version };
  }

  // 3. Bootstrap with bounded 425 retry per Retry-After.
  const bundle = await bootstrapWithRetry(client, opts);

  // 4/5/6. Atomic apply: refused bundles never partially applied.
  await store.applyBundle(bundle);

  log('info', 'identity bootstrapped', { bundle_version: bundle.bundle_version });
  if (!opts.oneShot) {
    await watchForRotation(config, store, client, opts, bundle.bundle_version);
  }
  return { kind: 'bootstrapped', bundleVersion: bundle.bundle_version };
}

/** 425 → honor Retry-After (bounded, 5 attempts); other errors fatal. */
export async function bootstrapWithRetry(
  client: RegistrarClient,
  opts: Pick<RunOptions, 'sleep'>,
): Promise<IdentityBundle> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = 5;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await client.bootstrap();
    } catch (err) {
      if (err instanceof RegistrarHttpError && err.status === 425 && attempt < maxAttempts) {
        const waitS = Math.max(1, Number(err.retryAfter ?? err.body?.retry_after_seconds ?? 1));
        log('info', 'slot not armed yet; retrying', { attempt, wait_seconds: waitS });
        await sleep(waitS * 1000);
        continue;
      }
      throw err;
    }
    return res.bundle;
  }
}

/**
 * 7. Resident rotation watcher: poll /v1/status; remote bundle_version
 * above local ⇒ owner rotated ⇒ re-fetch (rotate re-arms the slot) and
 * rewrite bundle+files+marker. Restart alone never refetches (boot
 * identity check dominates); the poll is the rotation mechanism.
 */
export async function watchForRotation(
  config: RegistrantConfig,
  store: IdentityStore,
  client: RegistrarClient,
  opts: RunOptions,
  localVersionIn: number,
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let localVersion = localVersionIn;

  /** Sleep one interval, or end early when the test stop resolves. */
  const stopOrSleep = async (): Promise<boolean> => {
    if (opts.stopWatch) {
      const r = await Promise.race([
        sleep(config.watchIntervalMs).then(() => 'sleep' as const),
        opts.stopWatch,
      ]);
      return r === 'stop';
    }
    await sleep(config.watchIntervalMs);
    return false;
  };

  for (;;) {
    let status: StatusSuccess;
    try {
      status = await client.status();
    } catch {
      // Transient poll failure: log, never crash the resident.
      log('warn', 'status poll failed; will retry next interval');
      if (await stopOrSleep()) return;
      continue;
    }
    const remote = status.bundle_version;
    if (remote !== null && remote > localVersion) {
      log('info', 'rotation detected', { local: localVersion, remote });
      const fresh = await bootstrapWithRetry(client, opts);
      await store.applyBundle(fresh);
      await opts.onRotation?.(fresh);
      localVersion = fresh.bundle_version;
      continue; // stay resident: keep watching for further rotations
    }
    if (await stopOrSleep()) return;
  }
}