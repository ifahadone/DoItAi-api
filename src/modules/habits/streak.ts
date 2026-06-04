/**
 * Habit streak math (ApiSpec §5.2, §7.4 — "server is authoritative for streak math"). Pure +
 * deterministic so it's unit-tested and reused by `POST /habits/{id}/log`.
 */
export interface StreakResult {
  current: number;
  longest: number;
}

/** Whole days since the Unix epoch for a `YYYY-MM-DD` date (UTC midnight). */
function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * Current + longest streak from completion dates with a grace allowance.
 *
 * A "run" of completions extends while consecutive dates are at most `graceDays + 1` days apart, so
 * up to `graceDays` missed days don't break the chain. `current` is the latest run's length when its
 * last completion is within grace of `today` (else 0 — the streak lapsed). `longest` is the longest
 * run ever. Idempotent over duplicate dates.
 */
export function computeStreak(completions: string[], graceDays: number, today: string): StreakResult {
  const unique = [...new Set(completions)].sort();
  if (unique.length === 0) return { current: 0, longest: 0 };

  const maxGap = Math.max(0, graceDays) + 1;

  let longest = 1;
  let runLength = 1;
  for (let i = 1; i < unique.length; i++) {
    const gap = dayNumber(unique[i]!) - dayNumber(unique[i - 1]!);
    runLength = gap <= maxGap ? runLength + 1 : 1;
    if (runLength > longest) longest = runLength;
  }

  const lastGap = dayNumber(today) - dayNumber(unique[unique.length - 1]!);
  let current = 0;
  if (lastGap >= 0 && lastGap <= maxGap) {
    current = 1;
    for (let i = unique.length - 1; i > 0; i--) {
      const gap = dayNumber(unique[i]!) - dayNumber(unique[i - 1]!);
      if (gap <= maxGap) current += 1;
      else break;
    }
  }

  return { current, longest };
}
