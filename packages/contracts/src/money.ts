/**
 * The money type (SPEC-008 §2.6, R-14, D3): integer micro-dollars everywhere, formatting once,
 * at the edge. There is deliberately no float anywhere in the arithmetic.
 */

export const MICRO_PER_USD = 1_000_000;

/** Exact integer sum — the scene-estimate pattern floats accumulate error on. */
export function sumMicroUsd(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error(`non-integer micro-dollar amount: ${v}`);
    total += v;
  }
  return total;
}

/**
 * The single formatting point (R-14). Rounds exactly once, here: to cents for amounts at or
 * above a cent, to the leading significant figure below it so sub-cent prices don't read $0.00.
 */
export function formatMicroUsd(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  if (abs === 0) return "$0.00";
  if (abs >= 10_000) {
    // ≥ 1¢ → dollars with two decimals, rounded half-up at the cent.
    const cents = Math.round(abs / 10_000);
    const dollars = Math.floor(cents / 100);
    const rem = cents % 100;
    return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
  }
  // Sub-cent → four decimal places, trimmed of trailing zeros past two.
  const tenThousandths = Math.round(abs / 100);
  const text = (tenThousandths / 10_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00");
  return `${sign}$${text}`;
}
