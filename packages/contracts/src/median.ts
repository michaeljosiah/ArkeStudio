/**
 * The middle value, or the mean of the middle two; NaN for nothing. The measured times use it over
 * a mean because the first run after a load spends minutes bringing weights in, and that one run
 * would otherwise skew the figure for the next several.
 */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
