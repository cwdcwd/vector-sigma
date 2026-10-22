/** The per-IP auth lockout (src/rate-limit.ts) that fronts /v1/bootstrap, /v1/status and the console login. */
import { describe, expect, it } from 'vitest';
import { AuthRateLimiter } from '../src/rate-limit.js';
import { FakeClock } from './helpers.js';

const WINDOW = 60_000;
const MAX = 3;
const make = () => {
  const clock = new FakeClock();
  return { clock, rl: new AuthRateLimiter(clock, WINDOW, MAX) };
};

describe('AuthRateLimiter', () => {
  it('locks an IP out at the failure limit, for that IP only', () => {
    const { rl } = make();
    for (let i = 0; i < MAX - 1; i++) rl.recordFailure('10.0.0.1');
    expect(rl.lockedRetryAfter('10.0.0.1')).toBeNull();
    rl.recordFailure('10.0.0.1');
    expect(rl.lockedRetryAfter('10.0.0.1')).toBeGreaterThan(0);
    expect(rl.lockedRetryAfter('10.0.0.2')).toBeNull();
  });

  it('the lockout expires, and the retry-after counts down to it', () => {
    const { clock, rl } = make();
    for (let i = 0; i < MAX; i++) rl.recordFailure('ip');
    const first = rl.lockedRetryAfter('ip')!;
    clock.advance(1_000);
    expect(rl.lockedRetryAfter('ip')).toBe(first - 1);
    clock.advance(first * 1_000);
    expect(rl.lockedRetryAfter('ip')).toBeNull();
    // after expiry the IP starts clean: one failure does not re-lock it
    rl.recordFailure('ip');
    expect(rl.lockedRetryAfter('ip')).toBeNull();
  });

  it('failures spread wider than the window never accumulate to a lockout', () => {
    const { clock, rl } = make();
    for (let i = 0; i < MAX * 3; i++) {
      rl.recordFailure('ip');
      clock.advance(WINDOW / (MAX - 1) + 1);
    }
    expect(rl.lockedRetryAfter('ip')).toBeNull();
  });
});
