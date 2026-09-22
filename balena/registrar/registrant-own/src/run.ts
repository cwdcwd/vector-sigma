import type { ClockProbe } from './clock-gate.js';
import { ClockGateTimeout, waitForClock } from './clock-gate.js';
import type { RegistrantConfig } from './config.js';
import { RegistrarClient, RegistrarHttpError } from './client.js';
import { IdentityStore } from './identity-store.js';
import type { IdentityBundle, StatusSuccess } from '@vector-sigma/shared';

/** Boot outcome for the entrypoint / tests. */
export type BootResult =
  | { kind: 'preexisting'; bundleVersion: number }
  | { kind: 'bootstrapped'; bundleVersion: number }
  /**
   * Permanent bootstrap refusal (f57.11): the registrar answered with a
   * terminal condition the device cannot retry its way out of — the
   * identity is wrong (401), the console state is wrong (403 pending/
   * revoked), or the device row is gone (404). The registrant stays
   * RESIDENT: run() enters the grace poll (see below) instead of exiting.
   */
  | { kind: 'blocked'; bundleVersion: null; reason: string; httpStatus: number };

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
  /**
   * Test seam: resolves 'stop' to end the permanent-error grace poll
   * (f57.11). Production passes nothing — a blocked device stays
   * resident until the console state is fixed.
   */
  stopGrace?: Promise<'stop'> | null;
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

  // 3. Bootstrap with bounded 425 retry per Retry-After; permanent errors
  // (f57.11) enter the grace poll instead of crashing the supervisor.
  let bundle: IdentityBundle;
  try {
    bundle = await bootstrapWithRetry(client, opts);
  } catch (err) {
    if (err instanceof PermanentRegistrarError) {
      // Stay resident: one loud ACTION REQUIRED line, then poll /v1/status
      // every PERMANENT_POLL_MS until the console state is fixed. The
      // device never crash-loops on a console-side misconfiguration.
      log('error', err.actionRequiredLine);
      if (!opts.oneShot) {
        bundle = await pollUntilUnblocked(config, client, opts, err);
      } else {
        return { kind: 'blocked', bundleVersion: null, reason: err.message, httpStatus: err.status };
      }
    } else {
      throw err;
    }
  }

  // 4/5/6. Atomic apply: refused bundles never partially applied.
  await store.applyBundle(bundle);

  log('info', 'identity bootstrapped', { bundle_version: bundle.bundle_version });
  if (!opts.oneShot) {
    await watchForRotation(config, store, client, opts, bundle.bundle_version);
  }
  return { kind: 'bootstrapped', bundleVersion: bundle.bundle_version };
}

/** HTTP statuses that mean the CONSOLE must fix something, not the device. */
const PERMANENT_STATUSES = new Set([401, 403, 404]);

/**
 * Console-fix guidance per permanent status (f57.11). The message names the
 * exact console action; it is printed ONCE as the loud ACTION REQUIRED
 * line, then referenced by the periodic poll lines.
 */
function consoleFixFor(status: number): string {
  switch (status) {
    case 401:
      return 'check REGISTRAR_KEY in the device platform variables — the registrar rejected it (regenerate the device key in the admin console, then update the device variable)';
    case 403:
      return 'activate the device in the admin console (/admin/devices → device page → Activate) — the device row is pending or revoked';
    case 404:
      return 'the device row is missing on the registrar — re-create it in the admin console (/admin/new-device) with this device UUID';
    default:
      return 'the registrar returned a terminal error — inspect the admin console and the registrar audit log';
  }
}

/** Permanent (console-fix) bootstrap refusal. */
export class PermanentRegistrarError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`registrar returned terminal status ${status}`);
    this.name = 'PermanentRegistrarError';
    this.actionRequiredLine = `ACTION REQUIRED: ${consoleFixFor(status)} (HTTP ${status})`;
  }
  /** The one loud line the operator sees in device logs. */
  readonly actionRequiredLine: string;
  /** Status classification helper for tests. */
  static isPermanent(status: number): boolean {
    return PERMANENT_STATUSES.has(status);
  }
}

/**
 * Resident grace poll (f57.11): every gracePollIntervalMs the registrant
 * re-checks /v1/status. When the console state is fixed the status call
 * succeeds AND device_status reads active, a bootstrap retry delivers the
 * bundle and the normal boot path resumes. Poll failures (network, 429)
 * never crash the resident — the poll keeps its own backoff. The sleep
 * ALWAYS runs between status checks — with the config-driven interval,
 * tests and the compose E2E shorten it; the loop can never spin.
 */
async function pollUntilUnblocked(
  config: RegistrantConfig,
  client: RegistrarClient,
  opts: RunOptions,
  cause: PermanentRegistrarError,
): Promise<IdentityBundle> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = config.gracePollIntervalMs;
  /** Sleep one interval, or end early when the test stop resolves. */
  const stopOrSleep = async (): Promise<boolean> => {
    if (opts.stopGrace) {
      const r = await Promise.race([
        sleep(pollMs).then(() => 'sleep' as const),
        opts.stopGrace,
      ]);
      return r === 'stop';
    }
    await sleep(pollMs);
    return false;
  };
  for (;;) {
    // Re-check: poll /v1/status; a 200 with device_status active means
    // the console fix has landed — bootstrap again immediately.
    let ready = false;
    try {
      const status = await client.status();
      ready = status.device_status === 'active';
      if (!ready) {
        log('warn', 'still blocked: device not active yet', { device_status: status.device_status });
      }
    } catch {
      // Status poll itself failing: log, never crash the resident.
      log('warn', 'status poll failed; will retry next interval');
    }
    if (ready) {
      log('info', 'console state fixed; re-attempting bootstrap');
      try {
        const bundle = await bootstrapWithRetry(client, opts);
        return bundle;
      } catch (err) {
        if (err instanceof PermanentRegistrarError) {
          // The console fix was partial (e.g. activated but key still
          // wrong): print the fresh ACTION REQUIRED line and keep
          // polling — still no crash loop.
          log('error', err.actionRequiredLine);
        } else {
          // Transient failure during self-heal bootstrap (network, 425
          // exhausted): existing fatal contract — the supervisor restart
          // is the retry mechanism, same as a cold boot.
          throw err;
        }
      }
    }
    if (await stopOrSleep()) {
      // Test stop: surface the blocked state to the caller.
      throw new GracePollStoppedError(cause);
    }
  }
}

/** Test-stop escape from the grace poll (f57.11 tests). */
export class GracePollStoppedError extends Error {
  constructor(public readonly cause: PermanentRegistrarError) {
    super(`grace poll stopped while blocked (HTTP ${cause.status})`);
    this.name = 'GracePollStoppedError';
  }
}

/**
 * 425 → honor Retry-After (bounded, 5 attempts); 401/403/404 →
 * PermanentRegistrarError (console-side fix required — f57.11); other
 * errors (network, 5xx, 429) rethrow and stay fatal exactly as before:
 * the supervisor restart contract governs those, unchanged.
 */
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
      if (err instanceof RegistrarHttpError && PermanentRegistrarError.isPermanent(err.status)) {
        throw new PermanentRegistrarError(err.status, err.body);
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