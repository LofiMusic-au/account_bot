// All money is handled as integer cents (AUD) to avoid floating-point drift.

/** "1234.5" | 1234.5 -> 123450 */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a money value: ${value}`);
  return Math.round(n * 100);
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-AU");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** GST contained in a GST-inclusive amount (1/11), rounded to the cent. */
export function gstInclusive(cents: number): number {
  return roundHalfAwayFromZero(cents / 11);
}

export function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Split `total` cents across `weights` in proportion, so the parts always sum
 * to exactly `total` (largest-remainder method). Used for order-level
 * discounts (D4) and for spreading a payment across lines and shipping.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW === 0) {
    // Nothing to weight by: put it all on the first part.
    return weights.map((_, i) => (i === 0 ? total : 0));
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * w) / sumW);
  const floors = raw.map(Math.floor);
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder--;
  }
  return floors.map((f) => f * sign);
}
