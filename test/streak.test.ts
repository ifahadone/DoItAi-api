import { describe, it, expect } from 'vitest';
import { computeStreak } from '@/modules/habits/streak.js';

describe('computeStreak', () => {
  it('returns zero for no completions', () => {
    expect(computeStreak([], 0, '2026-06-04')).toEqual({ current: 0, longest: 0 });
  });

  it('counts consecutive days (no grace)', () => {
    const dates = ['2026-06-02', '2026-06-03', '2026-06-04'];
    expect(computeStreak(dates, 0, '2026-06-04')).toEqual({ current: 3, longest: 3 });
  });

  it('breaks on a gap when graceDays is 0', () => {
    // missed 06-03
    const dates = ['2026-06-01', '2026-06-02', '2026-06-04'];
    expect(computeStreak(dates, 0, '2026-06-04')).toEqual({ current: 1, longest: 2 });
  });

  it('a single miss does not break the chain with graceDays 1', () => {
    const dates = ['2026-06-01', '2026-06-02', '2026-06-04']; // 06-03 missed
    expect(computeStreak(dates, 1, '2026-06-04')).toEqual({ current: 3, longest: 3 });
  });

  it('current lapses to 0 when the last completion is older than grace', () => {
    const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
    // today is 06-10, gap of 7 days > grace
    expect(computeStreak(dates, 1, '2026-06-10')).toEqual({ current: 0, longest: 3 });
  });

  it('is idempotent over duplicate dates', () => {
    const dates = ['2026-06-03', '2026-06-03', '2026-06-04', '2026-06-04'];
    expect(computeStreak(dates, 0, '2026-06-04')).toEqual({ current: 2, longest: 2 });
  });

  it('longest reflects the best run, not the current one', () => {
    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-06-04'];
    const r = computeStreak(dates, 0, '2026-06-04');
    expect(r.longest).toBe(4);
    expect(r.current).toBe(1);
  });
});
