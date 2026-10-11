// All money is handled as integer cents (AUD). Platform amounts arrive as
// decimal strings and are parsed digit by digit, never through a binary float.

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * "1234.5" -> 123450, "-0.07" -> -7. Numbers are accepted only for
 * convenience in tests and are converted through their decimal string form.
 * More than two decimal places is an error unless the extra digits are zero,
 * so a sub-cent amount can never be silently rounded away.
 */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const s = typeof value === "number" ? numberToDecimal(value) : value.trim();
  const m = DECIMAL.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Not a money value: ${value}`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] === "" ? "0" : m[2]!;
  const frac = m[3] ?? "";
  if (frac.length > 2 && /[^0]/.test(frac.slice(2))) {
    throw new Error(`Money value has fractions of a cent: ${value}`);
  }
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error(`Money value out of range: ${value}`);
  return sign * cents || 0;
}

function numberToDecimal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not a money value: ${n}`);
  // toFixed(6) then validate: a JS number like 0.1+0.2 becomes "0.300000",
  // which is fine; 1.005 stays "1.005000" and is rejected as sub-cent.
  return n.toFixed(6);
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-AU");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Integer division rounded half away from zero. Both arguments are integers. */
export function divRound(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) {
    throw new Error(`divRound needs integers: ${numerator}/${denominator}`);
  }
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (2 * r >= d ? q + 1 : q) || 0;
}

/** GST contained in a GST-inclusive amount (1/11), rounded to the cent. */
export function gstInclusive(cents: number): number {
  return divRound(cents, 11);
}

/**
 * A percentage such as 25 or 12.5 as integer basis points (2500, 1250).
 * Rates with more than two decimal places are rejected.
 */
export function percentToBasisPoints(value: string | number): number {
  return toCents(value);
}

/** `cents` * `bp` / 10000, rounded half away from zero. */
export function applyBasisPoints(cents: number, bp: number): number {
  return divRound(cents * bp, 10_000);
}

/**
 * Split `total` cents across `weights` in proportion, so the parts always sum
 * to exactly `total` (largest-remainder method). Used for order-level
 * discounts (D4) and for spreading a payment across lines and shipping.
 * Integer arithmetic only: weights must be integers (cents).
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
  const parts = weights.map((w, i) => {
    const num = abs * w;
    const floor = Math.floor(num / sumW);
    return { i, floor, rem: num - floor * sumW };
  });
  let remainder = abs - parts.reduce((a, p) => a + p.floor, 0);
  const order = [...parts].sort((a, b) => b.rem - a.rem || a.i - b.i);
  const out = parts.map((p) => p.floor);
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    remainder--;
  }
  return out.map((f) => f * sign || 0);
}
