import type { Clock } from './clock.js';

interface IpEntry {
  failures: number;
  windowStart: number;
  lockedUntil: number | null;
}

/**
 * Per-IP auth failure limiter with lockout, for the auth endpoints
 * (/v1/bootstrap, /v1/status). In-memory by design: single-process
 * registrar, restart clears lockouts (acceptable; keys are strong).
 */
export class AuthRateLimiter {
  private entries = new Map<string, IpEntry>();

  constructor(
    private clock: Clock,
    private windowMs: number,
    private maxFailures: number,
  ) {}

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  /** Seconds remaining in lockout, or null when the IP is free. */
  lockedRetryAfter(ip: string): number | null {
    const e = this.entries.get(ip);
    if (!e || e.lockedUntil === null) return null;
    const ms = e.lockedUntil - this.nowMs();
    if (ms <= 0) {
      this.entries.delete(ip);
      return null;
    }
    return Math.ceil(ms / 1000);
  }

  /** Count one auth failure; trips lockout at maxFailures within the window. */
  recordFailure(ip: string): void {
    const now = this.nowMs();
    const e = this.entries.get(ip) ?? { failures: 0, windowStart: now, lockedUntil: null };
    if (now - e.windowStart > this.windowMs) {
      e.failures = 0;
      e.windowStart = now;
    }
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = now + this.windowMs;
      e.failures = 0;
      e.windowStart = now;
    }
    this.entries.set(ip, e);
  }
}