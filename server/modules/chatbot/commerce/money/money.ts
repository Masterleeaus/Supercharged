/**
 * Integer minor-unit money helpers for the commerce money domain.
 * Ported from PHP MoneyMath.php, DiscountAllocator.php and the rounding in TaxCalculator.php.
 *
 * Rules (CONVENTIONS.md section 3): amounts are safe integers in minor units (cents). Percentages are basis
 * points (1000 = 10.00 percent). Intermediate products use BigInt, so a rate times an amount is exact and
 * is only converted back to a number after the safe-integer check. Rounding is half up on non-negative values.
 */

export const BASIS_POINTS = 10_000;
export const MAX_RATE_BPS = 100_000;

export type MoneyErrorCode = "validation" | "not_found" | "conflict" | "state" | "disabled" | "forbidden";

/** Error thrown by the money domain. The code maps to an HTTP status in the route layer, not here. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

/** Throws unless value is a non-negative safe integer. */
export function assertMinor(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError("validation", `${field} must be a non-negative whole number of minor units.`);
  }
  return value;
}

/** Throws unless value is a positive safe integer. */
export function assertPositiveMinor(value: unknown, field: string): number {
  const amount = assertMinor(value, field);
  if (amount === 0) {
    throw new MoneyError("validation", `${field} must be greater than zero.`);
  }
  return amount;
}

/** Throws unless value is an integer basis-point rate from 0 to MAX_RATE_BPS. */
export function assertRateBps(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_RATE_BPS) {
    throw new MoneyError("validation", `${field} must be a whole number of basis points from 0 to ${MAX_RATE_BPS}.`);
  }
  return value;
}

/** Upper-cases and checks an ISO 4217 code. */
export function normaliseCurrency(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new MoneyError("validation", "Currency must be a three-letter ISO 4217 code.");
  }
  return code;
}

/** Converts an exact BigInt result to a number, failing when it leaves the safe-integer range. */
export function bigToSafeMinor(value: bigint, field = "Amount"): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new MoneyError("validation", `${field} is too large.`);
  }
  return asNumber;
}

/** Half-up integer division of non-negative numbers. Exact: the arithmetic runs in BigInt. */
export function roundedDivide(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new MoneyError("validation", "Numerator must be a non-negative whole number.");
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new MoneyError("validation", "Denominator must be a positive whole number.");
  }
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return bigToSafeMinor((n + d / 2n) / d, "Result");
}

/** Multiplies two non-negative integers exactly and checks the result is a safe integer. */
export function multiplyMinor(a: number, b: number): number {
  return bigToSafeMinor(BigInt(assertMinor(a, "Factor")) * BigInt(assertMinor(b, "Factor")));
}

/**
 * amount * bps / 10000, half up. Rates above 100 percent are clamped to 100 percent, as the PHP discount path does.
 * A 10 percent discount on 999 cents is 99.9 cents, which rounds to 100 cents.
 */
export function percentageOf(amountMinor: number, bps: number): number {
  const amount = assertMinor(amountMinor, "Amount");
  const rate = Math.min(assertRateBps(bps, "Rate"), BASIS_POINTS);
  if (amount === 0 || rate === 0) {
    return 0;
  }
  return bigToSafeMinor((BigInt(amount) * BigInt(rate) + 5_000n) / 10_000n, "Discount");
}

/** Clamps value into [0, max]. */
export function clampMinor(value: number, max: number): number {
  return Math.min(Math.max(value, 0), Math.max(max, 0));
}

export interface AllocationRow {
  readonly key: string;
  readonly amount: number;
}

/**
 * Splits a requested discount across eligible rows. Each row gets its proportional share, rounded down, then the
 * remaining cents go one at a time to rows that still have room. The total always equals the clamped request.
 * Port of DiscountAllocator.php.
 */
export function allocateDiscount(requestedMinor: number, eligible: readonly AllocationRow[]): Map<string, number> {
  const rows: AllocationRow[] = [];
  for (const row of eligible) {
    const amount = Math.max(0, Math.trunc(row.amount));
    if (row.key !== "" && amount > 0) {
      rows.push({ key: row.key, amount });
    }
  }

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const discount = clampMinor(requestedMinor, total);
  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.key, 0);
  }
  if (discount === 0 || total === 0) {
    return result;
  }

  let allocated = 0;
  for (const row of rows) {
    const share = Math.min(bigToSafeMinor((BigInt(discount) * BigInt(row.amount)) / BigInt(total)), row.amount);
    result.set(row.key, share);
    allocated += share;
  }

  let remainder = discount - allocated;
  while (remainder > 0) {
    let progressed = false;
    for (const row of rows) {
      if (remainder === 0) {
        break;
      }
      const current = result.get(row.key) ?? 0;
      if (current >= row.amount) {
        continue;
      }
      result.set(row.key, current + 1);
      remainder -= 1;
      progressed = true;
    }
    if (!progressed) {
      break;
    }
  }

  return result;
}
