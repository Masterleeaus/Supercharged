/**
 * Money helpers. Every amount is an integer in minor units (cents). Floating point is never used for
 * amounts. Proration and percentages use BigInt so intermediate products cannot lose precision.
 */
import { OrderError } from "./order-errors.ts";

export type MinorUnits = number;

const BASIS_POINTS = 10_000;

export function assertMinorUnits(value: unknown, field: string): MinorUnits {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new OrderError(`${field} must be an integer amount in minor units`);
  }
  return value;
}

export function assertNonNegativeMinor(value: unknown, field: string): MinorUnits {
  const amount = assertMinorUnits(value, field);
  if (amount < 0) {
    throw new OrderError(`${field} must not be negative`);
  }
  return amount;
}

export function assertPositiveQuantity(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new OrderError(`${field} must be a positive integer`);
  }
  return value;
}

export function addMinor(...values: MinorUnits[]): MinorUnits {
  let total = 0;
  for (const value of values) {
    total = assertMinorUnits(total + assertMinorUnits(value, "amount"), "total");
  }
  return total;
}

export function subtractMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  return assertMinorUnits(a - b, "difference");
}

export function clampMinor(value: MinorUnits, min: MinorUnits, max: MinorUnits): MinorUnits {
  return Math.min(Math.max(value, min), Math.max(max, min));
}

/** round(amount * numerator / denominator), halves rounded up. All inputs are non-negative integers. */
export function prorateHalfUp(amount: MinorUnits, numerator: number, denominator: number): MinorUnits {
  if (denominator <= 0 || amount < 0 || numerator < 0) {
    throw new OrderError("prorate requires a non-negative amount and a positive denominator");
  }
  const a = BigInt(amount);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const result = (2n * a * n + d) / (2n * d);
  return assertMinorUnits(Number(result), "prorated amount");
}

/** Percentage in basis points (10000 = 100%), capped at 100%, rounded half up. */
export function percentageOf(amount: MinorUnits, basisPoints: number): MinorUnits {
  if (amount <= 0 || basisPoints <= 0) {
    return 0;
  }
  return prorateHalfUp(amount, Math.min(basisPoints, BASIS_POINTS), BASIS_POINTS);
}

export const BASIS_POINTS_PER_WHOLE = BASIS_POINTS;
