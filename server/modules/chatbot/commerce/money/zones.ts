/**
 * Address-to-zone matching shared by tax and shipping. Ported from TaxZoneMatcher.php and ShippingZoneMatcher.php.
 *
 * A zone with an empty list for a field does not restrict that field. Country and region compare upper-cased.
 * Postcodes and patterns drop whitespace and compare upper-cased. A pattern is either "*" (any postcode), a
 * numeric range "3000-3999", or a glob using "*". Shipping also accepts "?" for one character.
 */

export interface ZoneRules {
  readonly countries: readonly string[];
  readonly regions: readonly string[];
  readonly postcodePatterns: readonly string[];
}

export interface ZoneAddress {
  readonly country: string | null;
  readonly region: string | null;
  readonly postcode: string | null;
}

export interface ZoneMatchOptions {
  /** Shipping zones accept "?" as one character. Tax zones do not. */
  readonly singleCharacterWildcard: boolean;
}

const stripSpace = (value: string): string => value.replace(/\s+/g, "");

function normaliseList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter((value) => value !== ""))];
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function postcodeMatchesAny(postcode: string, patterns: readonly string[], options: ZoneMatchOptions): boolean {
  if (postcode === "") {
    return false;
  }
  for (const pattern of patterns) {
    if (pattern === "*") {
      return true;
    }
    const range = /^(\d+)-(\d+)$/.exec(pattern);
    if (range && /^\d+$/.test(postcode)) {
      const value = Number(postcode);
      if (value >= Number(range[1]) && value <= Number(range[2])) {
        return true;
      }
      continue;
    }
    let source = escapeForRegex(pattern).replace(/\\\*/g, ".*");
    if (options.singleCharacterWildcard) {
      source = source.replace(/\\\?/g, ".");
    }
    if (new RegExp(`^${source}$`, "i").test(postcode)) {
      return true;
    }
  }
  return false;
}

/** True when the address falls inside the zone. */
export function matchesZone(address: ZoneAddress, zone: ZoneRules, options: ZoneMatchOptions): boolean {
  const country = (address.country ?? "").trim().toUpperCase();
  const region = (address.region ?? "").trim().toUpperCase();
  const postcode = stripSpace((address.postcode ?? "").trim().toUpperCase());

  const countries = normaliseList(zone.countries);
  if (countries.length > 0 && !countries.includes(country)) {
    return false;
  }
  const regions = normaliseList(zone.regions);
  if (regions.length > 0 && !regions.includes(region)) {
    return false;
  }
  const patterns = [...new Set(zone.postcodePatterns.map((value) => stripSpace(value.trim().toUpperCase())).filter((value) => value !== ""))];
  if (patterns.length > 0 && !postcodeMatchesAny(postcode, patterns, options)) {
    return false;
  }
  return true;
}
