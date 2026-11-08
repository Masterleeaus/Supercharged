/**
 * Pricing rule evaluation. Ported from PricingRuntime.php (line and cart discounts, price overrides, the snapshot
 * hash) and DiscountAllocator.php. Implements the PricingProvider contract.
 *
 * Money is integer minor units. A percentage rule uses basis points and rounds half up to whole cents. A cart-level
 * discount is split across the eligible lines so the line discounts add up exactly to the cart discount.
 *
 * Not ported: coupons (CouponRuntime.php reserves coupon usage in the database, which is a separate slice), and
 * shipping-scope free-shipping rules (the contract has no free_shipping type). See DECISIONS.md.
 */
import type { PricingAdjustment, PricingContext, PricingProvider, PricingResult, PricingRule, ShippingCartLine } from "../../contracts/index.ts";
import { isPricingRulesEnabled } from "./flags.ts";
import { allocateDiscount, assertMinor, clampMinor, MoneyError, multiplyMinor, normaliseCurrency, percentageOf, assertRateBps } from "./money.ts";
import { hashRequest } from "./request-keys.ts";
import type { FlagEnv } from "../../contracts/index.ts";

/** A rule with the fields PricingRuntime reads that the contract PricingRule does not carry. */
export interface PricingRuleRecord extends PricingRule {
  /** Product, variant or category id, depending on targetType. Null for a rule that applies to everything. */
  readonly targetId: number | null;
  readonly minQuantity: number;
  readonly minSubtotalMinor: number;
  /** Restricts the rule to one customer when set. */
  readonly customerRef: string | null;
  /** For fixed discounts: multiply the value by the line quantity. */
  readonly perUnit: boolean;
}

export interface PricingCatalogEntry {
  readonly productId: number;
  readonly categoryId: number | null;
}

export interface PricingProviderOptions {
  /** Resolves a variant to its product and category. Returns null for an unknown variant. */
  readonly catalog: (variantId: number) => PricingCatalogEntry | null;
  /** Rule evaluation runs only when CHATBOT_PRICING_RULES_ENABLED is exactly "true". Otherwise list prices stand. */
  readonly env: FlagEnv;
}

interface WorkingLine {
  readonly lineId: string;
  readonly variantId: number;
  readonly productId: number;
  readonly categoryId: number | null;
  readonly quantity: number;
  readonly listUnitMinor: number;
  unitMinor: number;
  grossMinor: number;
  discountMinor: number;
}

const DISCOUNT_TYPES: ReadonlySet<string> = new Set(["percentage_discount", "fixed_discount"]);

function ruleIsActiveAt(rule: PricingRuleRecord, at: Date, currency: string, companyId: string): boolean {
  if (!rule.active || rule.companyId !== companyId) return false;
  if (rule.startsAt !== null && rule.startsAt.getTime() > at.getTime()) return false;
  if (rule.endsAt !== null && rule.endsAt.getTime() < at.getTime()) return false;
  if (rule.currency !== null && rule.currency.toUpperCase() !== currency) return false;
  return true;
}

function ruleMatchesContext(rule: PricingRuleRecord, context: PricingContext, currency: string, subtotalMinor: number): boolean {
  if (rule.minSubtotalMinor > subtotalMinor) return false;
  if (rule.currency !== null && rule.currency.toUpperCase() !== currency) return false;
  if (rule.channel !== null && rule.channel !== context.channel) return false;
  if (rule.customerRef !== null && rule.customerRef !== context.customerRef) return false;
  return true;
}

function ruleMatchesTarget(rule: PricingRuleRecord, line: WorkingLine): boolean {
  switch (rule.targetType) {
    case "product":
      return rule.targetId === line.productId;
    case "variant":
      return rule.targetId === line.variantId;
    case "category":
      return rule.targetId === line.categoryId;
    default:
      return true;
  }
}

function sortRules(rules: readonly PricingRuleRecord[]): PricingRuleRecord[] {
  return [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function createInternalPricingProvider(options: PricingProviderOptions): PricingProvider {
  return {
    evaluate(context: PricingContext, rules: PricingRuleRecord[]): PricingResult {
      const currency = normaliseCurrency(context.cart.currency);
      const lines: WorkingLine[] = context.cart.lines.map((line: ShippingCartLine, index: number) => {
        const quantity = assertMinor(line.quantity, "Quantity");
        if (quantity < 1) {
          throw new MoneyError("validation", "Quantity must be at least 1.");
        }
        const listUnitMinor = assertMinor(line.unitPriceMinor, "Unit price");
        const entry = options.catalog(line.variantId);
        if (entry === null) {
          throw new MoneyError("validation", "The selected product variant is unavailable.");
        }
        const gross = multiplyMinor(listUnitMinor, quantity);
        return {
          lineId: `${line.variantId}#${index}`,
          variantId: line.variantId,
          productId: entry.productId,
          categoryId: entry.categoryId,
          quantity,
          listUnitMinor,
          unitMinor: listUnitMinor,
          grossMinor: gross,
          discountMinor: 0,
        };
      });

      const active = isPricingRulesEnabled(options.env)
        ? sortRules(rules.filter((rule) => ruleIsActiveAt(rule, context.at, currency, context.companyId)))
        : [];
      const adjustments: PricingAdjustment[] = [];
      const listSubtotal = lines.reduce((sum, line) => sum + line.listUnitMinor * line.quantity, 0);

      // Price overrides: first matching line rule wins for each line. Matched against the list subtotal.
      for (const line of lines) {
        const rule = active.find((candidate) =>
          candidate.scope === "line"
          && candidate.ruleType === "price_override"
          && ruleMatchesContext(candidate, context, currency, listSubtotal)
          && line.quantity >= candidate.minQuantity
          && ruleMatchesTarget(candidate, line),
        );
        if (!rule) continue;
        const overridden = assertMinor(rule.value, "Override price");
        const newGross = multiplyMinor(overridden, line.quantity);
        const reduction = Math.max(0, line.grossMinor - newGross);
        line.unitMinor = overridden;
        line.grossMinor = newGross;
        if (reduction > 0) {
          adjustments.push({ ruleId: rule.id, scope: "line", lineId: line.lineId, amountMinor: reduction });
        }
      }

      const subtotal = lines.reduce((sum, line) => sum + line.grossMinor, 0);

      const apply = (line: WorkingLine, requested: number, rule: PricingRuleRecord): void => {
        const remaining = Math.max(0, line.grossMinor - line.discountMinor);
        const amount = clampMinor(requested, remaining);
        if (amount <= 0) return;
        line.discountMinor += amount;
        adjustments.push({ ruleId: rule.id, scope: rule.scope, lineId: line.lineId, amountMinor: amount });
      };

      // Line discounts. A non-stackable rule stops the search for that line.
      for (const line of lines) {
        for (const rule of active) {
          if (rule.scope !== "line" || !DISCOUNT_TYPES.has(rule.ruleType)) continue;
          if (!ruleMatchesContext(rule, context, currency, subtotal)) continue;
          if (!ruleMatchesTarget(rule, line) || line.quantity < rule.minQuantity) continue;
          const remaining = Math.max(0, line.grossMinor - line.discountMinor);
          const amount = rule.ruleType === "percentage_discount"
            ? percentageOf(remaining, rule.value)
            : clampMinor(rule.perUnit ? multiplyMinor(assertMinor(rule.value, "Discount"), line.quantity) : assertMinor(rule.value, "Discount"), remaining);
          apply(line, amount, rule);
          if (!rule.stackable) break;
        }
      }

      // Cart discounts. The discount is computed on the eligible total, then split across those lines.
      for (const rule of active) {
        if (rule.scope !== "cart" || !DISCOUNT_TYPES.has(rule.ruleType)) continue;
        if (!ruleMatchesContext(rule, context, currency, subtotal)) continue;
        const eligible = lines.filter((line) => ruleMatchesTarget(rule, line) && line.quantity >= rule.minQuantity);
        if (eligible.length === 0) continue;
        const eligibleTotal = eligible.reduce((sum, line) => sum + Math.max(0, line.grossMinor - line.discountMinor), 0);
        const discount = rule.ruleType === "percentage_discount"
          ? percentageOf(eligibleTotal, rule.value)
          : clampMinor(assertMinor(rule.value, "Discount"), eligibleTotal);
        const allocation = allocateDiscount(discount, eligible.map((line) => ({
          key: line.lineId,
          amount: Math.max(0, line.grossMinor - line.discountMinor),
        })));
        for (const line of eligible) {
          apply(line, allocation.get(line.lineId) ?? 0, rule);
        }
        if (!rule.stackable) break;
      }

      const discountMinor = lines.reduce((sum, line) => sum + line.discountMinor, 0);
      const totalMinor = Math.max(0, subtotal - discountMinor);
      const snapshotHash = hashRequest({
        companyId: context.companyId,
        currency,
        channel: context.channel,
        at: context.at.toISOString(),
        rules: active.map((rule) => [rule.id, rule.priority, rule.value]),
        lines: lines.map((line) => [line.lineId, line.quantity, line.unitMinor, line.grossMinor, line.discountMinor]),
        result: [subtotal, discountMinor, totalMinor],
      });

      return { subtotalMinor: subtotal, discountMinor, totalMinor, adjustments, snapshotHash };
    },
  };
}

/** Checks a rule's value before it is stored. Percentages are basis points, others are minor units. */
export function assertPricingRuleValue(ruleType: PricingRule["ruleType"], value: number): number {
  if (ruleType === "percentage_discount") {
    return assertRateBps(value, "Percentage");
  }
  return assertMinor(value, "Value");
}
