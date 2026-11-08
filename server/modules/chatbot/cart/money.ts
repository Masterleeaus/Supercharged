/**
 * Integer minor-unit arithmetic. Every amount is a safe integer count of cents.
 * Results that would leave the safe-integer range throw instead of rounding silently.
 */
import { CartError, MAX_LINE_QUANTITY, MIN_LINE_QUANTITY } from "./cart-types.ts";

export interface MoneyLine {
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface CartTotals {
  readonly itemCount: number;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
}

/** Throws unless value is a non-negative safe integer. */
export function assertMinorAmount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CartError("validation", `${field} must be a non-negative whole number of minor units.`);
  }
  return value as number;
}

/** Validates a line quantity. Quantity below 1 is rejected. Removing a line is a separate operation. */
export function normaliseQuantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < MIN_LINE_QUANTITY || (value as number) > MAX_LINE_QUANTITY) {
    throw new CartError(
      "validation",
      `Quantity must be a whole number from ${MIN_LINE_QUANTITY} to ${MAX_LINE_QUANTITY}.`,
    );
  }
  return value as number;
}

/** quantity * unitPriceMinor, checked against the safe-integer range. */
export function lineTotalMinor(unitPriceMinor: number, quantity: number): number {
  assertMinorAmount(unitPriceMinor, "Unit price");
  const total = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(total)) {
    throw new CartError("validation", "The line total is too large.");
  }
  return total;
}

/** Sums line totals and applies a discount clamped to [0, subtotal]. */
export function computeTotals(lines: readonly MoneyLine[], discountMinor = 0): CartTotals {
  let subtotal = 0;
  let itemCount = 0;
  for (const line of lines) {
    const total = lineTotalMinor(line.unitPriceMinor, line.quantity);
    subtotal += total;
    itemCount += line.quantity;
    if (!Number.isSafeInteger(subtotal)) {
      throw new CartError("validation", "The cart subtotal is too large.");
    }
  }
  const discount = Math.min(Math.max(assertMinorAmount(discountMinor, "Discount"), 0), subtotal);
  return { itemCount, subtotalMinor: subtotal, discountMinor: discount, totalMinor: subtotal - discount };
}
