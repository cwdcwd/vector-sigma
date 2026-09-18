import { access } from 'node:fs/promises';

/**
 * Clock gate: devices have no RTC, so wait for NTP convergence before
 * any TLS call. Probe seam is injectable for tests and hosts where
 * timedatectl is unavailable.
 */
export interface ClockProbe {
  /** Resolves true when system clock is NTP-synchronized. */
  isSynchronized(): Promise<boolean>;
}

/** Default probe: systemd-timesyncd synchronized flag. */
export class SystemdTimesyncdProbe implements ClockProbe {
  async isSynchronized(): Promise<boolean> {
    try {
      // Presence of this file == timesyncd reports NTP sync.
      await access('/run/systemd/timesync/synchronized');
      return true;
    } catch {
      return false;
    }
  }
}

export class StaticProbe implements ClockProbe {
  constructor(private readonly synchronized: boolean) {}
  async isSynchronized(): Promise<boolean> {
    return this.synchronized;
  }
}

export interface ClockGateOptions {
  probe: ClockProbe;
  /** Total budget for convergence before proceeding best-effort. */
  timeoutMs: number;
  /** Delay between probe attempts. */
  pollIntervalMs?: number;
  /** Test seam: called each time the gate waits. */
  onWait?: (elapsedMs: number) => void;
  /** Test seam for deterministic elapsed-time math. */
  sleep?: (ms: number) => Promise<void>;
}

export class ClockGateTimeout extends Error {
  constructor(public readonly elapsedMs: number) {
    super(`clock gate: NTP not synchronized after ${elapsedMs}ms, proceeding best-effort`);
    this.name = 'ClockGateTimeout';
  }
}

/**
 * Block until the probe reports NTP convergence or the budget expires
 * (then throw ClockGateTimeout — caller decides whether to proceed
 * best-effort; production boot path proceeds so a stalled gate can
 * never brick the device).
 */
export async function waitForClock(opts: ClockGateOptions): Promise<void> {
  const poll = opts.pollIntervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (;;) {
    if (await opts.probe.isSynchronized()) return;
    const elapsed = Date.now() - start;
    if (elapsed >= opts.timeoutMs) throw new ClockGateTimeout(elapsed);
    opts.onWait?.(elapsed);
    await sleep(Math.min(poll, opts.timeoutMs - elapsed));
  }
}