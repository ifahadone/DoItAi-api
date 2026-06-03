/**
 * Injectable clock. No business-logic code calls `new Date()` / `Date.now()`
 * directly — they take a `Clock` so sync/conflict tests are deterministic
 * (ApiSpec §17 "a deterministic clock is injected everywhere time matters").
 */

export interface Clock {
  /** Current instant as a Date. */
  now(): Date;
  /** Current instant as epoch milliseconds. */
  nowMs(): number;
  /** Current instant as an RFC3339 UTC string (the wire format, ApiSpec §3). */
  nowIso(): string;
}

/** Production clock backed by the system wall clock. */
export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/**
 * Deterministic clock for tests. Starts at `start` and only advances when you
 * call `advance(ms)` (or `set(...)`), so conflict ordering is reproducible.
 */
export class FixedClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }
  nowMs(): number {
    return this.current;
  }
  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  /** Move the clock forward by `ms` milliseconds. */
  advance(ms: number): this {
    this.current += ms;
    return this;
  }

  /** Jump the clock to an absolute instant. */
  set(at: Date | string | number): this {
    this.current = new Date(at).getTime();
    return this;
  }
}
