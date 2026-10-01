import { access, readFile } from 'node:fs/promises';

/**
 * Clock gate: devices have no RTC, so wait for NTP convergence before
 * any TLS call. Probe seam is injectable for tests and hosts where
 * the default probe's signals are unavailable.
 */
export interface ClockProbe {
  /**
   * Resolves true when the system clock is NTP-synchronized (or
   * plausibly set — see HostClockProbe).
   */
  isSynchronized(): Promise<boolean>;
}

export interface HostClockProbeOptions {
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Build-epoch file candidates (contents: ms since UNIX epoch). */
  epochPaths?: string[];
  /** systemd-timesyncd flag-file candidates. */
  timesyncdFlagPaths?: string[];
}

const DEFAULT_EPOCH_PATHS = ['build-epoch', '/app/build-epoch'];
const DEFAULT_TIMESYNCD_FLAG_PATHS = ['/run/systemd/timesync/synchronized'];

/**
 * Default probe (fleet-ops-1py.4): daemon-agnostic and in-container.
 *
 * balenaOS 8 hosts run chronyd, NOT systemd-timesyncd, so the old
 * flag-only probe could never observe sync: every container start
 * (supervisor recreates included) paid the full 600s timeout on an
 * already-synced host (evidenced 600004ms warn on the 2026-09-30
 * recreate; host NTP-synced since Sep 24). The registrant container
 * also has no /run bind mount, so no host-side flag can reach it.
 *
 * Signals, first match wins:
 *
 * 1. systemd-timesyncd's synchronized flag — kept opportunistically
 *    for hosts/containers that do expose it (fast, exact).
 * 2. Wall-clock plausibility: every registrant image bakes a
 *    `build-epoch` file (ms since epoch) at image build time
 *    (see the Dockerfiles). A device with no RTC cold-boots with a
 *    pre-build wall clock (1970, or last-shutdown skew after a long
 *    power-off); once NTP converges, the wall clock sits at/after the
 *    build date. `now() >= build epoch` therefore distinguishes
 *    not-yet-synced from synced WITHOUT asking any daemon — chronyd,
 *    timesyncd, and any future NTP daemon all satisfy it — and needs
 *    no host bind mounts: containers read their own clock.
 *
 * The kernel adjtimex STA_UNSYNC bit was considered and rejected as a
 * primary signal: it is syscall-only (/proc/timex does not exist —
 * live-verified on the fleet's 6.12 rpt-rpi kernel) and unreachable
 * from the pure-Node container runtime.
 *
 * Fail-safe: no readable epoch file and no flag → false. The gate then
 * keeps polling and finally fails open exactly as before — a stalled
 * gate can never brick the device.
 */
export class HostClockProbe implements ClockProbe {
  private readonly now: () => number;
  private readonly epochPaths: readonly string[];
  private readonly flagPaths: readonly string[];

  constructor(opts: HostClockProbeOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.epochPaths = opts.epochPaths ?? DEFAULT_EPOCH_PATHS;
    this.flagPaths = opts.timesyncdFlagPaths ?? DEFAULT_TIMESYNCD_FLAG_PATHS;
  }

  async isSynchronized(): Promise<boolean> {
    return (await this.timesyncdFlag()) || (await this.wallClockPlausible());
  }

  /** Signal 1: systemd-timesyncd's synchronized flag, when exposed. */
  private async timesyncdFlag(): Promise<boolean> {
    for (const p of this.flagPaths) {
      try {
        await access(p);
        return true;
      } catch {
        // absent → next candidate
      }
    }
    return false;
  }

  /** Signal 2: wall clock at/after the image build time ⇒ converged. */
  private async wallClockPlausible(): Promise<boolean> {
    for (const p of this.epochPaths) {
      try {
        const raw = await readFile(p, 'utf8');
        const epochMs = Number(raw.trim());
        if (Number.isFinite(epochMs) && epochMs > 0 && this.now() >= epochMs) {
          return true;
        }
      } catch {
        // unreadable → next candidate
      }
    }
    return false;
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