/**
 * Line and order totals in integer minor units.
 *
 * Rules, matching PricingRuntime.php:
 *   grossTotal   = unitPrice * quantity
 *   netBeforeTax = max(0, grossTotal - discountTotal)
 *   lineTotal    = netBeforeTax + taxTotal
 *   subtotal     = sum(grossTotal)
 *   total        = sum(lineTotal) + shippingTotal
 *
 * Tax amounts are inputs. Tax calculation providers are out of scope, so this module checks the
 * arithmetic only. It does not compute tax.
 */
import { OrderError } from "./order-errors.ts";
import { addMinor, assertMinorUnits, assertNonNegativeMinor, assertPositiveQuantity, type MinorUnits } from "./money.ts";

export interface PricedLineInput {
  quantity: number;
  unitPrice: MinorUnits;
  discountTotal: MinorUnits;
  taxTotal: MinorUnits;
  lineTotal: MinorUnits;
}

export interface LineTotals {
  grossTotal: MinorUnits;
  netBeforeTax: MinorUnits;
  lineTotal: MinorUnits;
}

export interface OrderTotals {
  subtotal: MinorUnits;
  discountTotal: MinorUnits;
  taxTotal: MinorUnits;
  shippingTotal: MinorUnits;
  total: MinorUnits;
}

/** Recomputes one line and fails when the stored line total disagrees with the arithmetic. */
export function computeLineTotals(line: PricedLineInput): LineTotals {
  const quantity = assertPositiveQuantity(line.quantity, "quantity");
  const unitPrice = assertNonNegativeMinor(line.unitPrice, "unitPrice");
  const discountTotal = assertNonNegativeMinor(line.discountTotal, "discountTotal");
  const taxTotal = assertNonNegativeMinor(line.taxTotal, "taxTotal");
  const lineTotal = assertNonNegativeMinor(line.lineTotal, "lineTotal");

  const grossTotal = assertMinorUnits(unitPrice * quantity, "grossTotal");
  if (discountTotal > grossTotal) {
    throw new OrderError("Line discount cannot exceed the line gross total.");
  }
  const netBeforeTax = grossTotal - discountTotal;
  const expected = addMinor(netBeforeTax, taxTotal);
  if (lineTotal !== expected) {
    throw new OrderError(`Line total ${lineTotal} does not equal net plus tax ${expected}.`);
  }
  return { grossTotal, netBeforeTax, lineTotal };
}

/** Sums validated lines and adds shipping. Shipping is an input; shipping rules are out of scope. */
export function computeOrderTotals(lines: readonly PricedLineInput[], shippingTotal: MinorUnits): OrderTotals {
  if (lines.length === 0) {
    throw new OrderError("An order needs at least one line.");
  }
  const shipping = assertNonNegativeMinor(shippingTotal, "shippingTotal");
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let lineSum = 0;
  for (const line of lines) {
    const computed = computeLineTotals(line);
    subtotal = addMinor(subtotal, computed.grossTotal);
    discountTotal = addMinor(discountTotal, line.discountTotal);
    taxTotal = addMinor(taxTotal, line.taxTotal);
    lineSum = addMinor(lineSum, computed.lineTotal);
  }
  return {
    subtotal,
    discountTotal,
    taxTotal,
    shippingTotal: shipping,
    total: addMinor(lineSum, shipping),
  };
}

/** Throws unless the totals a checkout reports equal the recomputed totals. Fails closed on drift. */
export function assertTotalsMatch(expected: OrderTotals, reported: OrderTotals): void {
  const keys: (keyof OrderTotals)[] = ["subtotal", "discountTotal", "taxTotal", "shippingTotal", "total"];
  for (const key of keys) {
    if (expected[key] !== reported[key]) {
      throw new OrderError(`Checkout ${key} ${reported[key]} does not match the recomputed ${expected[key]}.`);
    }
  }
}
