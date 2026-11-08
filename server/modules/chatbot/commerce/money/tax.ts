/**
 * Tax calculation and the internal TaxProvider. Ported from TaxRuntime.php (the non-exemption parts),
 * TaxCalculator.php, TaxZoneMatcher.php and Providers/InternalTaxProvider.php.
 *
 * Rounding is half up on integer minor units. Inclusive prices are split by dividing out the rate, and the rounding
 * difference goes to the last component so the components add up to the gross price.
 *
 * Not ported: compound components (the contract TaxRate has no compound flag). Exemption records are in
 * tax-exemptions.ts, and their result is passed in as the exempt flags. See DECISIONS.md.
 */
import type { TaxAddress, TaxLine, TaxProvider, TaxRate, TaxZone } from "../../contracts/index.ts";
import { MAX_RATE_BPS, MoneyError, multiplyMinor, roundedDivide, assertMinor, BASIS_POINTS } from "./money.ts";
import { matchesZone, type ZoneRules } from "./zones.ts";

/** A zone as the internal provider stores it. The contract TaxZone is the public subset. */
export interface TaxZoneConfig extends TaxZone {
  readonly companyId: string;
  readonly countries: readonly string[];
  readonly regions: readonly string[];
  readonly postcodePatterns: readonly string[];
  /** Null leaves the price basis to the caller. */
  readonly pricesIncludeTax: boolean | null;
  readonly priority: number;
  readonly active: boolean;
}

/** A rate as the internal provider stores it. The contract TaxRate is the public subset. */
export interface TaxRateConfig extends TaxRate {
  readonly companyId: string;
  readonly active: boolean;
  readonly priority: number;
  readonly appliesToProducts: boolean;
  readonly appliesToShipping: boolean;
}

export interface TaxComponent {
  readonly label: string;
  readonly zoneId: string | null;
  readonly rateBps: number;
  readonly amountMinor: number;
}

export interface TaxCalculation {
  readonly baseMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly components: readonly TaxComponent[];
}

/** Keeps only positive rates and clamps each to MAX_RATE_BPS. */
function usableRates(rates: readonly TaxRate[]): TaxRate[] {
  return rates
    .filter((rate) => Number.isSafeInteger(rate.rateBps) && rate.rateBps > 0)
    .map((rate) => ({ ...rate, rateBps: Math.min(rate.rateBps, MAX_RATE_BPS) }));
}

/** Port of TaxCalculator::calculate for non-compound components. */
export function calculateTaxComponents(amountMinor: number, rates: readonly TaxRate[], pricesIncludeTax: boolean): TaxCalculation {
  const amount = assertMinor(amountMinor, "Amount");
  const usable = usableRates(rates);
  if (amount === 0 || usable.length === 0) {
    return { baseMinor: amount, taxMinor: 0, totalMinor: amount, components: [] };
  }

  const rateSum = usable.reduce((sum, rate) => sum + rate.rateBps, 0);
  const base = pricesIncludeTax ? roundedDivide(multiplyMinor(amount, BASIS_POINTS), BASIS_POINTS + rateSum) : amount;

  const components = usable.map((rate) => ({
    label: rate.label,
    zoneId: rate.zoneId,
    rateBps: rate.rateBps,
    amountMinor: roundedDivide(multiplyMinor(base, rate.rateBps), BASIS_POINTS),
  }));

  if (pricesIncludeTax) {
    const expectedTax = amount - base;
    const taxSoFar = components.reduce((sum, component) => sum + component.amountMinor, 0);
    const delta = expectedTax - taxSoFar;
    if (delta !== 0) {
      const last = components[components.length - 1];
      last.amountMinor = Math.max(0, last.amountMinor + delta);
    }
  }

  const taxMinor = components.reduce((sum, component) => sum + component.amountMinor, 0);
  return {
    baseMinor: base,
    taxMinor,
    totalMinor: pricesIncludeTax ? amount : base + taxMinor,
    components,
  };
}

export interface InternalTaxConfig {
  readonly zones: readonly TaxZoneConfig[];
  readonly rates: readonly TaxRateConfig[];
}

function zoneRules(zone: TaxZoneConfig): ZoneRules {
  return { countries: zone.countries, regions: zone.regions, postcodePatterns: zone.postcodePatterns };
}

/** Pricing basis set on the matched zone, when it has one. */
export function zonePricesIncludeTax(zone: TaxZone | null): boolean | null {
  if (zone === null || !("pricesIncludeTax" in zone)) {
    return null;
  }
  const value = (zone as { pricesIncludeTax?: unknown }).pricesIncludeTax;
  return typeof value === "boolean" ? value : null;
}

/** Internal TaxProvider over in-memory configuration. Rate lookups are scoped to the company. */
export function createInternalTaxProvider(config: InternalTaxConfig): TaxProvider {
  const pick = (companyId: string, zone: TaxZone | null, taxClass: string, shipping: boolean): TaxRate[] => {
    const rows = config.rates.filter((rate) =>
      rate.companyId === companyId
      && rate.active
      && rate.taxClass === taxClass
      && (shipping ? rate.appliesToShipping : rate.appliesToProducts)
      && (rate.zoneId === null || (zone !== null && rate.zoneId === zone.id)),
    );
    rows.sort((a, b) => {
      const aZone = a.zoneId === null ? 1 : 0;
      const bZone = b.zoneId === null ? 1 : 0;
      return aZone - bZone || b.priority - a.priority || a.label.localeCompare(b.label);
    });
    return rows.map((rate) => ({ zoneId: rate.zoneId, taxClass: rate.taxClass, rateBps: rate.rateBps, inclusive: rate.inclusive, label: rate.label }));
  };

  return {
    async resolveZone(companyId: string, address: TaxAddress): Promise<TaxZone | null> {
      const zones = config.zones
        .filter((zone) => zone.companyId === companyId && zone.active)
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
      for (const zone of zones) {
        if (matchesZone({ country: address.countryCode, region: address.region, postcode: address.postcode }, zoneRules(zone), { singleCharacterWildcard: false })) {
          return zone;
        }
      }
      return null;
    },

    async ratesForLine(companyId: string, line: TaxLine, zone: TaxZone | null): Promise<TaxRate[]> {
      const taxClass = (line.taxClass ?? "").trim() || "default";
      const rates = pick(companyId, zone, taxClass, false);
      if (rates.length > 0 || taxClass === "default") {
        return rates;
      }
      return pick(companyId, zone, "default", false);
    },

    async ratesForShipping(companyId: string, zone: TaxZone | null): Promise<TaxRate[]> {
      return pick(companyId, zone, "shipping", true);
    },
  };
}

export interface OrderTaxLine {
  readonly lineId: string;
  readonly taxClass: string | null;
  readonly quantity: number;
  readonly amountMinor: number;
  readonly exempt: boolean;
}

export interface OrderTaxInput {
  readonly lines: readonly OrderTaxLine[];
  readonly shippingMinor: number;
  readonly pricesIncludeTax: boolean;
  readonly address: TaxAddress;
  /** Set when the whole order is exempt. Records come from tax-exemptions.ts (decideTaxExemption). */
  readonly exempt: boolean;
  /** Set when shipping alone is exempt, for example a "shipping" class exemption record. Defaults to `exempt`. */
  readonly shippingExempt?: boolean;
}

export interface OrderTaxResult {
  readonly zoneId: string | null;
  readonly pricesIncludeTax: boolean;
  readonly lines: ReadonlyArray<{ readonly lineId: string; readonly taxableMinor: number; readonly taxMinor: number }>;
  readonly shippingTaxMinor: number;
  readonly taxTotalMinor: number;
  readonly components: readonly TaxComponent[];
}

/** Runs the whole order through a TaxProvider: resolve the zone, then rates per line and for shipping. */
export async function calculateOrderTax(provider: TaxProvider, companyId: string, input: OrderTaxInput): Promise<OrderTaxResult> {
  if (companyId.trim() === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  const zone = await provider.resolveZone(companyId, input.address);
  const pricesIncludeTax = zonePricesIncludeTax(zone) ?? input.pricesIncludeTax;
  const aggregate = new Map<string, TaxComponent>();
  const absorb = (components: readonly TaxComponent[]): void => {
    for (const component of components) {
      const key = `${component.zoneId ?? "none"}\u0000${component.label}\u0000${component.rateBps}`;
      const previous = aggregate.get(key);
      aggregate.set(key, previous ? { ...previous, amountMinor: previous.amountMinor + component.amountMinor } : component);
    }
  };

  const lines: Array<{ lineId: string; taxableMinor: number; taxMinor: number }> = [];
  let taxTotal = 0;
  for (const line of input.lines) {
    const exempt = input.exempt || line.exempt;
    const rates = exempt ? [] : await provider.ratesForLine(companyId, { lineId: line.lineId, taxClass: line.taxClass, amountMinor: line.amountMinor, quantity: line.quantity }, zone);
    const calc = calculateTaxComponents(line.amountMinor, rates, pricesIncludeTax);
    lines.push({ lineId: line.lineId, taxableMinor: calc.baseMinor, taxMinor: calc.taxMinor });
    taxTotal += calc.taxMinor;
    absorb(calc.components);
  }

  const shippingExempt = input.exempt || input.shippingExempt === true;
  const shippingRates = shippingExempt ? [] : await provider.ratesForShipping(companyId, zone, input.shippingMinor);
  const shipping = calculateTaxComponents(input.shippingMinor, shippingRates, pricesIncludeTax);
  taxTotal += shipping.taxMinor;
  absorb(shipping.components);

  return {
    zoneId: zone?.id ?? null,
    pricesIncludeTax,
    lines,
    shippingTaxMinor: shipping.taxMinor,
    taxTotalMinor: taxTotal,
    components: [...aggregate.values()],
  };
}
