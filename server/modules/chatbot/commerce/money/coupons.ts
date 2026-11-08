/**
 * Coupons: validation, discount maths and usage reservations. Ported from CouponRuntime.php (resolve, reserve, release,
 * redeem, expire) and the coupon part of PricingRuntime.php (applyCouponDiscount).
 *
 * Usage counting: a coupon's uses are the redeemed usages plus the reservations that have not expired. The cart's own
 * reservation is left out of the count, so a cart can be re-priced without counting itself. Reserving a coupon runs
 * in one storage transaction that locks the coupon row first (see CouponStorage.reserveUsage).
 *
 * Money is integer minor units. Percentages are basis points. Every method takes companyId first, and a row from
 * another company is treated as absent.
 */
import { allocateDiscount, assertMinor, assertPositiveMinor, assertRateBps, BASIS_POINTS, MoneyError, normaliseCurrency, percentageOf } from "./money.ts";
import { createKeyedLock } from "./request-keys.ts";

export const COUPON_TYPES = ["percentage", "fixed", "free_shipping"] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const COUPON_APPLIES_TO = ["cart", "products", "variants", "categories"] as const;
export type CouponAppliesTo = (typeof COUPON_APPLIES_TO)[number];

export const COUPON_USAGE_STATUSES = ["reserved", "redeemed", "released", "expired"] as const;
export type CouponUsageStatus = (typeof COUPON_USAGE_STATUSES)[number];

/** Same default as config('chatbot-ecommerce.pricing.coupon_reservation_ttl_minutes') in the PHP. */
export const COUPON_RESERVATION_TTL_MINUTES = 30;
const CODE_MAX_LENGTH = 64;

export const COUPON_MESSAGES = {
  invalid: "The coupon is invalid or unavailable.",
  minimum: "The coupon minimum purchase has not been met.",
  currency: "The coupon is not valid for this currency.",
  channel: "The coupon is not valid on this channel.",
  firstOrder: "The coupon is limited to a customer’s first order.",
  products: "The coupon does not apply to the products in this cart.",
  usageLimit: "The coupon usage limit has been reached.",
  customerLimit: "The coupon usage limit for this customer has been reached.",
} as const;

export interface CouponRecord {
  readonly companyId: string;
  readonly id: string;
  /** Upper case, trimmed. Unique per company. */
  readonly code: string;
  readonly type: CouponType;
  /** Basis points for percentage, minor units for fixed, 0 for free_shipping. */
  readonly value: number;
  /** Null means any currency. */
  readonly currency: string | null;
  readonly minimumMinor: number;
  /** Cap on a percentage or fixed discount. Null means no cap. */
  readonly maxDiscountMinor: number | null;
  readonly active: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  /** Total uses across all customers, counting redeemed uses and live reservations. Null means no limit. */
  readonly usageLimit: number | null;
  /** Uses per customer. Null means no limit. Only checked when the customer is known. */
  readonly usageLimitPerCustomer: number | null;
  readonly firstOrderOnly: boolean;
  /** Empty means every channel. */
  readonly channels: readonly string[];
  readonly appliesTo: CouponAppliesTo;
  /** Product, variant or category ids, as strings. Used when appliesTo is not cart. */
  readonly targetIds: readonly string[];
  readonly stackable: boolean;
}

export interface CouponUsageRecord {
  readonly companyId: string;
  readonly id: string;
  readonly couponId: string;
  readonly cartId: string;
  readonly customerRef: string | null;
  status: CouponUsageStatus;
  reservedAt: Date;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  releasedAt: Date | null;
}

export interface CouponUsageCounts {
  readonly total: number;
  readonly forCustomer: number;
}

export interface CouponLine {
  readonly lineKey: string;
  readonly productId: string | null;
  readonly variantId: string | null;
  readonly categoryId: string | null;
  /** Line amount before the coupon, in minor units. */
  readonly amountMinor: number;
}

export interface CouponQuoteInput {
  readonly companyId: string;
  readonly code: string | null | undefined;
  readonly lines: readonly CouponLine[];
  readonly subtotalMinor: number;
  readonly shippingMinor: number;
  readonly currency: string;
  readonly channel: string;
  readonly customerRef: string | null;
  readonly completedOrderCount: number;
  readonly cartId: string | null;
  readonly now?: Date;
}

export interface CouponDiscount {
  readonly discountMinor: number;
  readonly shippingDiscountMinor: number;
  readonly eligibleTotalMinor: number;
  /** Discount share per eligible line key. The shares add up to discountMinor. */
  readonly lineShares: ReadonlyMap<string, number>;
}

export interface CouponQuote extends CouponDiscount {
  readonly couponId: string;
  readonly code: string;
  readonly type: CouponType;
}

export interface CouponStorage {
  findCouponByCode(companyId: string, code: string): Promise<CouponRecord | null>;
  /** Returns false when the code already exists for this company. */
  insertCoupon(record: CouponRecord): Promise<boolean>;
  countActiveUsage(companyId: string, couponId: string, excludingCartId: string | null, customerRef: string | null, now: Date): Promise<CouponUsageCounts>;
  /**
   * One transaction. Locks the coupon row, runs check() with the live counts (a throw aborts the whole call), releases
   * this cart's other reservations, then creates or refreshes this cart's reservation. A redeemed usage is returned as it is.
   */
  reserveUsage(input: {
    readonly companyId: string;
    readonly coupon: CouponRecord;
    readonly cartId: string;
    readonly customerRef: string | null;
    readonly now: Date;
    readonly expiresAt: Date;
    readonly check: (counts: CouponUsageCounts) => void;
  }): Promise<CouponUsageRecord>;
  redeemCart(companyId: string, cartId: string, now: Date): Promise<number>;
  releaseCart(companyId: string, cartId: string, now: Date): Promise<number>;
  /** Marks reserved usages whose expiry has passed as expired. Returns the number changed, at most limit. */
  expireDue(companyId: string, now: Date, limit: number): Promise<number>;
}

function requireCompany(value: unknown): string {
  const companyId = typeof value === "string" ? value.trim() : "";
  if (companyId === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  return companyId;
}

/** Trims and upper-cases a code, as the PHP does. Empty means no coupon was given. */
export function normaliseCouponCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** Builds a validated coupon record. Used by the admin path and by tests. Percentages are basis points. */
export function buildCouponRecord(
  companyId: string,
  id: string,
  fields: {
    readonly code: string;
    readonly type: CouponType;
    readonly value: number;
    readonly currency?: string | null;
    readonly minimumMinor?: number;
    readonly maxDiscountMinor?: number | null;
    readonly active?: boolean;
    readonly startsAt?: Date | null;
    readonly endsAt?: Date | null;
    readonly usageLimit?: number | null;
    readonly usageLimitPerCustomer?: number | null;
    readonly firstOrderOnly?: boolean;
    readonly channels?: readonly string[];
    readonly appliesTo?: CouponAppliesTo;
    readonly targetIds?: readonly string[];
    readonly stackable?: boolean;
  },
): CouponRecord {
  const tenant = requireCompany(companyId);
  const code = normaliseCouponCode(fields.code);
  if (code === "" || code.length > CODE_MAX_LENGTH) {
    throw new MoneyError("validation", "A coupon code is required and must be 64 characters or fewer.");
  }
  if (!(COUPON_TYPES as readonly string[]).includes(fields.type)) {
    throw new MoneyError("validation", "The coupon type is not supported.");
  }
  let value: number;
  if (fields.type === "percentage") {
    value = assertRateBps(fields.value, "Coupon percentage");
    if (value > BASIS_POINTS) {
      throw new MoneyError("validation", "A coupon percentage cannot be above 100 percent.");
    }
  } else if (fields.type === "fixed") {
    value = assertPositiveMinor(fields.value, "Coupon amount");
  } else {
    value = 0;
  }
  const appliesTo = fields.appliesTo ?? "cart";
  if (!(COUPON_APPLIES_TO as readonly string[]).includes(appliesTo)) {
    throw new MoneyError("validation", "The coupon scope is not supported.");
  }
  const usageLimit = fields.usageLimit ?? null;
  const usageLimitPerCustomer = fields.usageLimitPerCustomer ?? null;
  for (const [label, limit] of [["Usage limit", usageLimit], ["Usage limit per customer", usageLimitPerCustomer]] as const) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new MoneyError("validation", `${label} must be a whole number of at least 1.`);
    }
  }
  const startsAt = fields.startsAt ?? null;
  const endsAt = fields.endsAt ?? null;
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new MoneyError("validation", "The coupon end date cannot be before its start date.");
  }
  const targetIds = (fields.targetIds ?? []).map((item) => String(item).trim()).filter((item) => item !== "");
  return {
    companyId: tenant,
    id,
    code,
    type: fields.type,
    value,
    currency: fields.currency ? normaliseCurrency(fields.currency) : null,
    minimumMinor: assertMinor(fields.minimumMinor ?? 0, "Minimum amount"),
    maxDiscountMinor: fields.maxDiscountMinor === undefined || fields.maxDiscountMinor === null
      ? null
      : assertPositiveMinor(fields.maxDiscountMinor, "Maximum discount"),
    active: fields.active ?? true,
    startsAt,
    endsAt,
    usageLimit,
    usageLimitPerCustomer,
    firstOrderOnly: fields.firstOrderOnly ?? false,
    channels: (fields.channels ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item !== ""),
    appliesTo,
    targetIds,
    stackable: fields.stackable ?? false,
  };
}

/** True when the coupon applies to this line under its scope. */
export function couponLineApplies(coupon: Pick<CouponRecord, "appliesTo" | "targetIds">, line: CouponLine): boolean {
  switch (coupon.appliesTo) {
    case "products":
      return line.productId !== null && coupon.targetIds.includes(line.productId);
    case "variants":
      return line.variantId !== null && coupon.targetIds.includes(line.variantId);
    case "categories":
      return line.categoryId !== null && coupon.targetIds.includes(line.categoryId);
    default:
      return true;
  }
}

function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total = assertMinor(total + value, "Eligible total");
  }
  return total;
}

/** Discount for a coupon that has passed validation. Port of PricingRuntime::applyCouponDiscount. */
export function computeCouponDiscount(coupon: CouponRecord, lines: readonly CouponLine[], shippingMinor: number): CouponDiscount {
  const eligible = lines.filter((line) => line.lineKey !== "" && couponLineApplies(coupon, line));
  const eligibleTotalMinor = sumMinor(eligible.map((line) => assertMinor(line.amountMinor, "Line amount")));
  if (coupon.type === "free_shipping") {
    return { discountMinor: 0, shippingDiscountMinor: assertMinor(shippingMinor, "Shipping"), eligibleTotalMinor, lineShares: new Map() };
  }
  let discountMinor = coupon.type === "percentage"
    ? percentageOf(eligibleTotalMinor, Math.min(coupon.value, BASIS_POINTS))
    : Math.min(coupon.value, eligibleTotalMinor);
  if (coupon.maxDiscountMinor !== null) {
    discountMinor = Math.min(discountMinor, coupon.maxDiscountMinor);
  }
  const lineShares = allocateDiscount(discountMinor, eligible.map((line) => ({ key: line.lineKey, amount: line.amountMinor })));
  return { discountMinor, shippingDiscountMinor: 0, eligibleTotalMinor, lineShares };
}

/** Returns the refusal message for a coupon, or null when it passes. Same order of checks as the PHP. */
export function couponRefusal(
  coupon: CouponRecord | null,
  input: Pick<CouponQuoteInput, "lines" | "subtotalMinor" | "currency" | "channel" | "completedOrderCount"> & { readonly now: Date },
): string | null {
  if (!coupon || !coupon.active) return COUPON_MESSAGES.invalid;
  if (coupon.startsAt && coupon.startsAt > input.now) return COUPON_MESSAGES.invalid;
  if (coupon.endsAt && coupon.endsAt < input.now) return COUPON_MESSAGES.invalid;
  if (input.subtotalMinor < coupon.minimumMinor) return COUPON_MESSAGES.minimum;
  if (coupon.currency !== null && input.currency.toUpperCase() !== coupon.currency) return COUPON_MESSAGES.currency;
  if (coupon.channels.length > 0 && !coupon.channels.includes(input.channel.trim().toLowerCase())) return COUPON_MESSAGES.channel;
  if (coupon.firstOrderOnly && input.completedOrderCount > 0) return COUPON_MESSAGES.firstOrder;
  if (!input.lines.some((line) => line.lineKey !== "" && couponLineApplies(coupon, line))) return COUPON_MESSAGES.products;
  return null;
}

/** Throws when the coupon has reached its total or per-customer limit. */
export function assertCouponUsage(coupon: CouponRecord, counts: CouponUsageCounts, customerRef: string | null): void {
  if (coupon.usageLimit !== null && counts.total >= coupon.usageLimit) {
    throw new MoneyError("validation", COUPON_MESSAGES.usageLimit);
  }
  if (customerRef !== null && coupon.usageLimitPerCustomer !== null && counts.forCustomer >= coupon.usageLimitPerCustomer) {
    throw new MoneyError("validation", COUPON_MESSAGES.customerLimit);
  }
}

/** Counts the uses that block a new one: redeemed usages, and reservations not yet expired, leaving out one cart. */
export function countCouponUsage(
  usages: Iterable<CouponUsageRecord>,
  companyId: string,
  couponId: string,
  excludingCartId: string | null,
  customerRef: string | null,
  now: Date,
): CouponUsageCounts {
  let total = 0;
  let forCustomer = 0;
  for (const usage of usages) {
    if (usage.companyId !== companyId || usage.couponId !== couponId) continue;
    if (excludingCartId !== null && usage.cartId === excludingCartId) continue;
    const live = usage.status === "redeemed" || (usage.status === "reserved" && (usage.expiresAt === null || usage.expiresAt > now));
    if (!live) continue;
    total += 1;
    if (customerRef !== null && usage.customerRef === customerRef) forCustomer += 1;
  }
  return { total, forCustomer };
}

export interface CouponServiceOptions {
  readonly storage: CouponStorage;
  readonly now?: () => Date;
  readonly reservationTtlMinutes?: number;
}

export interface CouponReservation {
  readonly quote: CouponQuote;
  readonly usage: CouponUsageRecord;
}

export interface CouponService {
  /** Null when no code was given. Throws a validation MoneyError with the PHP message when the coupon is refused. */
  quote(input: CouponQuoteInput): Promise<CouponQuote | null>;
  /** Quotes, then reserves the coupon for the cart in one transaction. Null when no code was given. */
  reserve(input: CouponQuoteInput): Promise<CouponReservation | null>;
  releaseCart(companyId: string, cartId: string): Promise<number>;
  redeemCart(companyId: string, cartId: string): Promise<number>;
  expireDue(companyId: string, limit?: number): Promise<number>;
}

export function createCouponService(options: CouponServiceOptions): CouponService {
  const clock = options.now ?? (() => new Date());
  const ttl = Math.min(Math.max(options.reservationTtlMinutes ?? COUPON_RESERVATION_TTL_MINUTES, 1), 1440);

  const evaluate = async (input: CouponQuoteInput): Promise<{ coupon: CouponRecord; quote: CouponQuote } | null> => {
    const companyId = requireCompany(input.companyId);
    const code = normaliseCouponCode(input.code);
    if (code === "") return null;
    const now = input.now ?? clock();
    const currency = normaliseCurrency(input.currency);
    const subtotalMinor = assertMinor(input.subtotalMinor, "Subtotal");
    const shippingMinor = assertMinor(input.shippingMinor, "Shipping");
    const coupon = await options.storage.findCouponByCode(companyId, code);
    const refusal = couponRefusal(coupon, { ...input, subtotalMinor, currency, now });
    if (refusal !== null || coupon === null) {
      throw new MoneyError("validation", refusal ?? COUPON_MESSAGES.invalid);
    }
    const counts = await options.storage.countActiveUsage(companyId, coupon.id, input.cartId, input.customerRef, now);
    assertCouponUsage(coupon, counts, input.customerRef);
    const discount = computeCouponDiscount(coupon, input.lines, shippingMinor);
    return { coupon, quote: { ...discount, couponId: coupon.id, code: coupon.code, type: coupon.type } };
  };

  return {
    quote: async (input) => (await evaluate(input))?.quote ?? null,

    async reserve(input) {
      const companyId = requireCompany(input.companyId);
      const result = await evaluate(input);
      if (result === null) return null;
      if (typeof input.cartId !== "string" || input.cartId.trim() === "") {
        throw new MoneyError("validation", "A cart is required to reserve a coupon.");
      }
      const now = input.now ?? clock();
      const usage = await options.storage.reserveUsage({
        companyId,
        coupon: result.coupon,
        cartId: input.cartId,
        customerRef: input.customerRef,
        now,
        expiresAt: new Date(now.getTime() + ttl * 60_000),
        check: (counts) => assertCouponUsage(result.coupon, counts, input.customerRef),
      });
      return { quote: result.quote, usage };
    },

    releaseCart: (companyId, cartId) => options.storage.releaseCart(requireCompany(companyId), cartId, clock()),
    redeemCart: (companyId, cartId) => options.storage.redeemCart(requireCompany(companyId), cartId, clock()),
    expireDue: (companyId, limit = 500) => options.storage.expireDue(requireCompany(companyId), clock(), Math.min(Math.max(limit, 1), 5000)),
  };
}

/** In-memory CouponStorage for tests and local runs. Keys are scoped by company, as the database constraints are. */
export function createMemoryCouponStorage(): CouponStorage & { readonly usages: ReadonlyMap<string, CouponUsageRecord> } {
  const coupons = new Map<string, CouponRecord>();
  const usages = new Map<string, CouponUsageRecord>();
  const withLock = createKeyedLock();
  const scoped = (...parts: string[]): string => parts.join("\u0000");

  const sweep = (companyId: string, cartId: string | null, status: CouponUsageStatus, now: Date, mark: (usage: CouponUsageRecord) => void): number => {
    let changed = 0;
    for (const usage of usages.values()) {
      if (usage.companyId !== companyId || usage.status !== "reserved") continue;
      if (cartId !== null && usage.cartId !== cartId) continue;
      mark(usage);
      usage.status = status;
      usage.releasedAt = status === "redeemed" ? usage.releasedAt : now;
      changed += 1;
    }
    return changed;
  };

  return {
    usages,
    async findCouponByCode(companyId, code) {
      const record = coupons.get(scoped(companyId, code));
      return record && record.companyId === companyId ? record : null;
    },
    async insertCoupon(record) {
      const key = scoped(record.companyId, record.code);
      if (coupons.has(key)) return false;
      coupons.set(key, record);
      return true;
    },
    async countActiveUsage(companyId, couponId, excludingCartId, customerRef, now) {
      return countCouponUsage(usages.values(), companyId, couponId, excludingCartId, customerRef, now);
    },
    async reserveUsage(input) {
      return withLock(scoped(input.companyId, "coupon", input.coupon.id), async () => {
        input.check(countCouponUsage(usages.values(), input.companyId, input.coupon.id, input.cartId, input.customerRef, input.now));

        for (const usage of usages.values()) {
          if (usage.companyId === input.companyId && usage.cartId === input.cartId && usage.couponId !== input.coupon.id && usage.status === "reserved") {
            usage.status = "released";
            usage.releasedAt = input.now;
          }
        }

        const slot = scoped(input.companyId, "usage", input.coupon.id, input.cartId);
        const existing = usages.get(slot);
        if (existing && existing.status === "redeemed") {
          return existing;
        }
        const record: CouponUsageRecord = existing
          ? Object.assign(existing, { status: "reserved" as const, expiresAt: input.expiresAt, releasedAt: null, customerRef: input.customerRef })
          : {
              companyId: input.companyId,
              id: `cpu_${usages.size + 1}`,
              couponId: input.coupon.id,
              cartId: input.cartId,
              customerRef: input.customerRef,
              status: "reserved",
              reservedAt: input.now,
              expiresAt: input.expiresAt,
              redeemedAt: null,
              releasedAt: null,
            };
        usages.set(slot, record);
        return record;
      });
    },
    async redeemCart(companyId, cartId, now) {
      return sweep(companyId, cartId, "redeemed", now, (usage) => {
        usage.redeemedAt = now;
        usage.expiresAt = null;
      });
    },
    async releaseCart(companyId, cartId, now) {
      return sweep(companyId, cartId, "released", now, (usage) => {
        usage.expiresAt = null;
      });
    },
    async expireDue(companyId, now, limit) {
      let changed = 0;
      for (const usage of usages.values()) {
        if (changed >= limit) break;
        if (usage.companyId === companyId && usage.status === "reserved" && usage.expiresAt !== null && usage.expiresAt <= now) {
          usage.status = "expired";
          usage.releasedAt = now;
          changed += 1;
        }
      }
      return changed;
    },
  };
}
