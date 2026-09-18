import { describe, it, expect } from 'vitest';
import { effectiveState, retryAfterSeconds, type SlotSnapshot } from '../src/slots.js';

const base: SlotSnapshot = {
  state: 'armed',
  deliveryCount: 0,
  deliveredAt: null,
  rearmsAt: null,
};

describe('slot effective state (auto-rearm math)', () => {
  it('armed slot reads armed regardless of timestamps', () => {
    expect(effectiveState(base, new Date())).toBe('armed');
  });

  it('consumed slot inside window reads consumed', () => {
    const snap: SlotSnapshot = {
      state: 'consumed',
      deliveryCount: 1,
      deliveredAt: new Date('2026-01-01T00:00:00Z'),
      rearmsAt: new Date('2026-01-01T01:00:00Z'),
    };
    expect(effectiveState(snap, new Date('2026-01-01T00:30:00Z'))).toBe('consumed');
  });

  it('consumed slot past window reads armed (auto-rearm)', () => {
    const snap: SlotSnapshot = {
      state: 'consumed',
      deliveryCount: 1,
      deliveredAt: new Date('2026-01-01T00:00:00Z'),
      rearmsAt: new Date('2026-01-01T01:00:00Z'),
    };
    expect(effectiveState(snap, new Date('2026-01-01T01:00:00Z'))).toBe('armed');
    expect(effectiveState(snap, new Date('2026-01-01T02:00:00Z'))).toBe('armed');
  });

  it('consumed slot with null rearmsAt inside window reads consumed', () => {
    const snap: SlotSnapshot = {
      state: 'consumed',
      deliveryCount: 1,
      deliveredAt: new Date('2026-01-01T00:00:00Z'),
      rearmsAt: null,
    };
    // Null rearmsAt with consumed state: treat as still inside window.
    expect(effectiveState(snap, new Date('2026-01-01T00:30:00Z'))).toBe('consumed');
  });
});

describe('retryAfterSeconds', () => {
  it('null when armed', () => {
    expect(retryAfterSeconds(base, new Date())).toBeNull();
  });

  it('seconds remaining inside window, rounded up, minimum 1', () => {
    const snap: SlotSnapshot = {
      state: 'consumed',
      deliveryCount: 1,
      deliveredAt: new Date('2026-01-01T00:00:00Z'),
      rearmsAt: new Date('2026-01-01T01:00:00Z'),
    };
    expect(retryAfterSeconds(snap, new Date('2026-01-01T00:59:00Z'))).toBe(60);
    expect(retryAfterSeconds(snap, new Date('2026-01-01T00:59:59.5Z'))).toBe(1);
    expect(retryAfterSeconds(snap, new Date('2026-01-01T00:00:00Z'))).toBe(3600);
  });
});