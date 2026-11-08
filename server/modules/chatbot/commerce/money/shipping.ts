/**
 * Shipping rates and the internal ShippingProvider. Ported from ShippingRateCalculator.php,
 * ShippingZoneMatcher.php and Providers/InternalShippingProvider.php.
 *
 * Weights are integer grams. The PHP used float kilograms. A weight rate charges per started kilogram.
 * Quotes carry an expiry time. A quote is never returned after it has expired, and the caller re-quotes.
 */
import { createHash } from "node:crypto";
import type { ShippingAddress, ShippingCartSnapshot, ShippingProvider, ShippingQuote } from "../../contracts/index.ts";
import { assertMinor, MoneyError } from "./money.ts";
import { matchesZone, type ZoneRules } from "./zones.ts";

export type ShippingRateType = "flat" | "weight" | "subtotal" | "free";
export type ShippingMethodType = "delivery" | "pickup" | "digital";
export type ShippingProductType = "physical" | "digital" | "service";

export interface ShippingTier {
  readonly minMinor: number;
  readonly maxMinor: number | null;
  readonly amountMinor: number;
}

export interface ShippingRate {
  readonly rateType: ShippingRateType;
  readonly amountMinor: number;
  readonly baseAmountMinor: number;
  readonly perKilogramMinor: number;
  readonly freeAboveMinor: number | null;
  readonly tiers: readonly ShippingTier[];
}

/** Port of ShippingRateCalculator::calculate. Returns minor units. */
export function shippingRateAmount(rate: ShippingRate, subtotalMinor: number, weightGrams: number): number {
  const subtotal = assertMinor(subtotalMinor, "Subtotal");
  const grams = assertMinor(weightGrams, "Weight");
  if (rate.freeAboveMinor !== null && subtotal >= Math.max(0, rate.freeAboveMinor)) {
    return 0;
  }
  switch (rate.rateType) {
    case "flat":
      return Math.max(0, rate.amountMinor);
    case "free":
      return 0;
    case "weight": {
      const kilograms = grams > 0 ? Math.ceil(grams / 1000) : 0;
      return Math.max(0, rate.baseAmountMinor) + kilograms * Math.max(0, rate.perKilogramMinor);
    }
    case "subtotal": {
      for (const tier of rate.tiers) {
        const inMinimum = subtotal >= Math.max(0, tier.minMinor);
        const inMaximum = tier.maxMinor === null || subtotal <= Math.max(0, tier.maxMinor);
        if (inMinimum && inMaximum) {
          return Math.max(0, tier.amountMinor);
        }
      }
      throw new MoneyError("validation", "No subtotal shipping tier matched.");
    }
    default:
      throw new MoneyError("validation", "Unsupported shipping rate type.");
  }
}

export interface ShippingMethodConfig {
  readonly companyId: string;
  readonly code: string;
  readonly name: string;
  readonly methodType: ShippingMethodType;
  readonly currency: string;
  readonly active: boolean;
  readonly priority: number;
  readonly minimumSubtotalMinor: number;
  readonly maximumSubtotalMinor: number | null;
  readonly minimumWeightGrams: number;
  readonly maximumWeightGrams: number | null;
  /** Null means the method is not limited by address. Delivery methods are usually zoned. */
  readonly zone: ZoneRules | null;
  readonly estimatedDaysMin: number | null;
  readonly estimatedDaysMax: number | null;
  readonly rate: ShippingRate;
}

export interface InternalShippingQuote extends ShippingQuote {
  readonly code: string;
  readonly methodType: ShippingMethodType;
  readonly name: string;
  readonly subtotalMinor: number;
  readonly weightGrams: number;
  readonly estimatedDaysMin: number | null;
  readonly source: "internal" | "built_in";
}

/** Product type of a cart line. Lines without a type are physical, as in the PHP. */
export function lineProductType(line: ShippingCartSnapshot["lines"][number]): ShippingProductType {
  const declared = (line as { productType?: unknown }).productType;
  return declared === "digital" || declared === "service" ? declared : "physical";
}

function cartFacts(cart: ShippingCartSnapshot): { subtotalMinor: number; weightGrams: number; requiresDelivery: boolean } {
  let subtotalMinor = 0;
  let weightGrams = 0;
  let requiresDelivery = false;
  for (const line of cart.lines) {
    const quantity = assertMinor(line.quantity, "Quantity");
    subtotalMinor += assertMinor(line.unitPriceMinor, "Unit price") * quantity;
    if (lineProductType(line) === "physical") {
      requiresDelivery = true;
      weightGrams += assertMinor(line.weightGrams ?? 0, "Weight") * quantity;
    }
  }
  return { subtotalMinor, weightGrams, requiresDelivery };
}

export interface ShippingProviderOptions {
  readonly methods: readonly ShippingMethodConfig[];
  /** Quote lifetime in minutes. Clamped to 1 to 120. */
  readonly quoteTtlMinutes?: number;
  readonly now?: () => Date;
}

/** Internal ShippingProvider over in-memory method configuration. */
export function createInternalShippingProvider(options: ShippingProviderOptions): ShippingProvider {
  const ttl = Math.min(Math.max(options.quoteTtlMinutes ?? 15, 1), 120);
  const now = options.now ?? (() => new Date());

  return {
    async quotes(companyId: string, cart: ShippingCartSnapshot, address: ShippingAddress): Promise<ShippingQuote[]> {
      const facts = cartFacts(cart);
      const currency = cart.currency.trim().toUpperCase();
      const expiresAt = new Date(now().getTime() + ttl * 60_000);
      const addressKey = createHash("sha256").update(JSON.stringify([address.countryCode, address.region, address.postcode])).digest("hex");
      const rows: InternalShippingQuote[] = [];

      const methods = options.methods
        .filter((method) => method.companyId === companyId && method.active)
        .sort((a, b) => b.priority - a.priority || a.code.localeCompare(b.code));

      for (const method of methods) {
        if (method.methodType === "delivery" && !facts.requiresDelivery) continue;
        if (method.methodType === "digital" && facts.requiresDelivery) continue;
        if (method.methodType === "delivery" && method.zone !== null && !matchesZone({ country: address.countryCode, region: address.region, postcode: address.postcode }, method.zone, { singleCharacterWildcard: true })) continue;
        if (method.currency.trim().toUpperCase() !== currency) continue;
        if (facts.subtotalMinor < method.minimumSubtotalMinor) continue;
        if (method.maximumSubtotalMinor !== null && facts.subtotalMinor > method.maximumSubtotalMinor) continue;
        if (facts.weightGrams < method.minimumWeightGrams) continue;
        if (method.maximumWeightGrams !== null && facts.weightGrams > method.maximumWeightGrams) continue;

        const amount = method.methodType === "pickup" || method.methodType === "digital"
          ? 0
          : shippingRateAmount(method.rate, facts.subtotalMinor, facts.weightGrams);
        const quoteId = createHash("sha256")
          .update(JSON.stringify([companyId, cart.cartId, method.code, amount, currency, addressKey]))
          .digest("hex");
        rows.push({
          quoteId,
          carrier: "internal",
          service: method.code,
          priceMinor: amount,
          currency,
          estimatedDays: method.estimatedDaysMax,
          expiresAt,
          code: method.code,
          methodType: method.methodType,
          name: method.name,
          subtotalMinor: facts.subtotalMinor,
          weightGrams: facts.weightGrams,
          estimatedDaysMin: method.estimatedDaysMin,
          source: "internal",
        });
      }

      if (!facts.requiresDelivery && !rows.some((row) => row.methodType === "digital")) {
        rows.push({
          quoteId: createHash("sha256").update(JSON.stringify([companyId, cart.cartId, "digital", currency])).digest("hex"),
          carrier: "internal",
          service: "digital",
          priceMinor: 0,
          currency,
          estimatedDays: 0,
          expiresAt,
          code: "digital",
          methodType: "digital",
          name: "Digital delivery",
          subtotalMinor: facts.subtotalMinor,
          weightGrams: 0,
          estimatedDaysMin: 0,
          source: "built_in",
        });
      }

      return rows;
    },
  };
}

/** Quotes still valid at the given time. The caller must not use an expired quote. */
export function unexpiredQuotes(quotes: readonly ShippingQuote[], at: Date): ShippingQuote[] {
  return quotes.filter((quote) => quote.expiresAt.getTime() > at.getTime());
}

/** Converts a kilogram weight from a catalogue field to whole grams. Done once at the edge, never in totals. */
export function gramsFromKilograms(kilograms: number): number {
  if (!Number.isFinite(kilograms) || kilograms < 0) {
    throw new MoneyError("validation", "Weight must be zero or more kilograms.");
  }
  return Math.round(kilograms * 1000);
}
