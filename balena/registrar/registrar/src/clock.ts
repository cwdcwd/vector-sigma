export interface Clock {
  now(): Date;
}

/** System clock — the default everywhere outside tests. */
export const systemClock: Clock = {
  now: () => new Date(),
};