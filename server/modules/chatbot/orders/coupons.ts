/**
 * Coupon rules as pure functions. Ported from Services/CouponRuntime.php and the discount branch of
 * Services/PricingRuntime.php. Storage and clocks are passed in, so these functions have no side effects.
 *
 * Usage counting: a redeemed usage always counts. A reserved usage counts until its expiry passes.
 * Released and expired usages never count. The current cart's own usage is excluded from the limits.
 */
import { OrderError } from "./order-errors.ts";
import { clampMinor, percentageOf, type MinorUnits } from "./money.ts";
import type { CouponRecord, CouponUsageRecord } from "./order-types.ts";

export const MAX_PERCENT_BASIS_POINTS = 10_000;
export const DEFAULT_RESERVATION_TTL_MINUTES = 30;

export interface CouponLine {
  lineKey: string;
  productId: string | null;
  variantId: string | null;
  categoryId: string | null;
  grossTotal: MinorUnits;
  discountTotal: MinorUnits;
}

export interface CouponCartContext {
  subtotal: MinorUnits;
  lines: readonly CouponLine[];
  currency: string;
  channel: string | null;
  completedOrderCount: number;
  cartId: string | null;
  customerIdentityId: string | null;
  now: Date;
}

export function normaliseCouponCode(code: unknown): string | null {
  if (typeof code !== "string") {
    return null;
  }
  const trimmed = code.trim().toUpperCase();
  return trimmed === "" ? null : trimmed;
}

export function isCouponInWindow(coupon: CouponRecord, now: Date): boolean {
  if (!coupon.active) {
    return false;
  }
  if (coupon.startsAt !== null && coupon.startsAt.getTime() > now.getTime()) {
    return false;
  }
  if (coupon.endsAt !== null && coupon.endsAt.getTime() < now.getTime()) {
    return false;
  }
  return true;
}

export function eligibleLineKeys(coupon: CouponRecord, lines: readonly CouponLine[]): string[] {
  const targets = new Set(coupon.targetIds);
  const keys: string[] = [];
  for (const line of lines) {
    let eligible: boolean;
    switch (coupon.appliesTo) {
      case "products":
        eligible = line.productId !== null && targets.has(line.productId);
        break;
      case "variants":
        eligible = line.variantId !== null && targets.has(line.variantId);
        break;
      case "categories":
        eligible = line.categoryId !== null && targets.has(line.categoryId);
        break;
      default:
        eligible = true;
    }
    if (eligible && line.lineKey !== "") {
      keys.push(line.lineKey);
    }
  }
  return keys;
}

/** Sum of net amounts (gross minus line discounts) on the lines the coupon targets. */
export function eligibleAmount(coupon: CouponRecord, lines: readonly CouponLine[]): MinorUnits {
  const keys = new Set(eligibleLineKeys(coupon, lines));
  let total = 0;
  for (const line of lines) {
    if (keys.has(line.lineKey)) {
      total += Math.max(0, line.grossTotal - line.discountTotal);
    }
  }
  return total;
}

/** Discount a coupon yields for an eligible amount. Percentages are basis points, rounded half up. */
export function couponDiscount(coupon: CouponRecord, eligibleTotal: MinorUnits): MinorUnits {
  let discount =
    coupon.type === "percentage"
      ? percentageOf(eligibleTotal, Math.min(coupon.value, MAX_PERCENT_BASIS_POINTS))
      : clampMinor(coupon.value, 0, eligibleTotal);
  if (coupon.maxDiscountAmount !== null) {
    discount = Math.min(discount, coupon.maxDiscountAmount);
  }
  return discount;
}

export function isUsageCounted(usage: CouponUsageRecord, now: Date): boolean {
  if (usage.status === "redeemed") {
    return true;
  }
  if (usage.status === "reserved") {
    return usage.expiresAt === null || usage.expiresAt.getTime() > now.getTime();
  }
  return false;
}

/** Throws when the coupon's global or per-customer usage limit has been reached. */
export function assertUsageAvailable(
  coupon: CouponRecord,
  usages: readonly CouponUsageRecord[],
  scope: { cartId: string | null; customerIdentityId: string | null; now: Date },
): void {
  const counted = usages.filter(
    (usage) => usage.couponId === coupon.id && (scope.cartId === null || usage.cartId !== scope.cartId) && isUsageCounted(usage, scope.now),
  );
  if (coupon.usageLimit !== null && counted.length >= coupon.usageLimit) {
    throw new OrderError("The coupon usage limit has been reached.");
  }
  if (scope.customerIdentityId !== null && coupon.usageLimitPerCustomer !== null) {
    const customerUses = counted.filter((usage) => usage.customerIdentityId === scope.customerIdentityId).length;
    if (customerUses >= coupon.usageLimitPerCustomer) {
      throw new OrderError("The coupon usage limit for this customer has been reached.");
    }
  }
}

/**
 * Checks everything except the usage limits, in the same order as CouponRuntime::validationError.
 * Returns the eligible amount so the caller can compute the discount without a second pass.
 */
export function assertCouponApplicable(
  coupon: CouponRecord,
  usages: readonly CouponUsageRecord[],
  ctx: CouponCartContext,
): MinorUnits {
  if (!isCouponInWindow(coupon, ctx.now)) {
    throw new OrderError("The coupon is invalid or unavailable.");
  }
  if (ctx.subtotal < coupon.minimumAmount) {
    throw new OrderError("The coupon minimum purchase has not been met.");
  }
  if (coupon.currency !== null && ctx.currency.toUpperCase() !== coupon.currency.toUpperCase()) {
    throw new OrderError("The coupon is not valid for this currency.");
  }
  if (coupon.channels.length > 0 && (ctx.channel === null || !coupon.channels.includes(ctx.channel))) {
    throw new OrderError("The coupon is not valid on this channel.");
  }
  if (coupon.firstOrderOnly && ctx.completedOrderCount > 0) {
    throw new OrderError("The coupon is limited to a customer's first order.");
  }
  const eligible = eligibleLineKeys(coupon, ctx.lines);
  if (eligible.length === 0) {
    throw new OrderError("The coupon does not apply to the products in this cart.");
  }
  assertUsageAvailable(coupon, usages, { cartId: ctx.cartId, customerIdentityId: ctx.customerIdentityId, now: ctx.now });
  return eligibleAmount(coupon, ctx.lines);
}
