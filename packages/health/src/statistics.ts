import type { Distribution } from './types.js';

const EMPTY: Distribution = { min: 0, max: 0, mean: 0, median: 0, p90: 0, total: 0 };

/**
 * Rounds to four decimals.
 *
 * Floating point is deterministic for identical inputs, so rounding is not needed for
 * reproducibility — it is here so a mean reads as `2.7391` rather than `2.739130434782609`, which
 * makes report diffs legible.
 */
export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A distribution over a list of counts.
 *
 * `median` and `p90` use the **nearest-rank** method on the sorted values: no interpolation, so
 * every reported figure is a value that actually occurs. An empty input gives all zeroes rather
 * than `NaN`, because a report about an empty repository should still be readable.
 */
export function distributionOf(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return EMPTY;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean: round(total / sorted.length),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    total,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));

  return sorted[rank] ?? 0;
}

/** A ratio, or 0 when nothing was measured — never `NaN` and never a division by zero. */
export function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : round(part / whole);
}
