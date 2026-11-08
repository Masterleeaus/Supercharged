/**
 * Context freshness checks for the workforce runtime. Before an action runs, every piece of context it relies on
 * (schedules, pricing, availability, policies, customer details) must have been observed recently enough. A stale,
 * undated or future-dated item is refused rather than silently driving the action.
 *
 * Pure: no timers, no database, no network. Time is always passed in as `now` (epoch milliseconds), so the caller
 * controls the clock.
 */

export const FRESHNESS_KINDS = ['schedule', 'pricing', 'availability', 'policy', 'customer_details'] as const;

export type FreshnessKind = (typeof FRESHNESS_KINDS)[number];

export type FreshnessLimits = Readonly<Record<FreshnessKind, number>>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Default maximum age, in milliseconds, for each data kind. */
export const FRESHNESS_LIMITS: FreshnessLimits = Object.freeze({
  schedule: DAY_MS,
  pricing: 7 * DAY_MS,
  availability: HOUR_MS,
  policy: 30 * DAY_MS,
  customer_details: 90 * DAY_MS,
});

export interface FreshnessItem {
  kind: string;
  observedAt: number;
  source: string;
}

export type FreshnessResult =
  | { fresh: true }
  | { fresh: false; reason: `stale_${FreshnessKind}`; ageMs: number; maxAgeMs: number }
  | { fresh: false; reason: 'unknown_freshness' }
  | { fresh: false; reason: 'clock_skew' };

export interface FreshnessOptions {
  now: number;
  limits?: Partial<Record<FreshnessKind, number>>;
}

export type FreshnessFailure = {
  item: FreshnessItem;
  reason: `stale_${FreshnessKind}` | 'unknown_freshness' | 'clock_skew';
  ageMs?: number;
  maxAgeMs?: number;
};

export type ActionFreshnessResult = { ok: true } | { ok: false; reasons: FreshnessFailure[] };

function isFreshnessKind(kind: unknown): kind is FreshnessKind {
  return typeof kind === 'string' && (FRESHNESS_KINDS as readonly string[]).includes(kind);
}

/** Merges overrides onto the defaults. Each override must be a finite, non-negative number of milliseconds. */
function resolveLimits(overrides: Partial<Record<FreshnessKind, number>> | undefined): FreshnessLimits {
  if (overrides === undefined) return FRESHNESS_LIMITS;
  const merged: Record<FreshnessKind, number> = { ...FRESHNESS_LIMITS };
  for (const kind of Object.keys(overrides) as string[]) {
    if (!isFreshnessKind(kind)) {
      throw new TypeError(`unknown freshness kind in limits: ${kind}`);
    }
    const value = overrides[kind];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`freshness limit for ${kind} must be a finite non-negative number of milliseconds`);
    }
    merged[kind] = value;
  }
  return Object.freeze(merged);
}

/**
 * Checks one item. An item is fresh when its age is at most the limit for its kind (exactly at the limit is fresh).
 * Unknown kinds and missing or non-finite `observedAt` values are never fresh. An `observedAt` after `now` is never
 * fresh either, since it means the clocks disagree.
 */
export function checkFreshness(item: FreshnessItem, options: FreshnessOptions): FreshnessResult {
  const limits = resolveLimits(options.limits);
  const { observedAt } = item ?? ({} as FreshnessItem);

  if (!isFreshnessKind(item?.kind) || typeof observedAt !== 'number' || !Number.isFinite(observedAt)) {
    return { fresh: false, reason: 'unknown_freshness' };
  }
  if (observedAt > options.now) {
    return { fresh: false, reason: 'clock_skew' };
  }

  const ageMs = options.now - observedAt;
  const maxAgeMs = limits[item.kind];
  if (ageMs > maxAgeMs) {
    return { fresh: false, reason: `stale_${item.kind}`, ageMs, maxAgeMs };
  }
  return { fresh: true };
}

/**
 * Checks every item an action depends on. Returns ok only when all items are fresh. Otherwise lists every item that
 * is not fresh, not just the first.
 */
export function assertFreshForAction(items: readonly FreshnessItem[], options: FreshnessOptions): ActionFreshnessResult {
  const reasons: FreshnessFailure[] = [];
  for (const item of items) {
    const result = checkFreshness(item, options);
    if (result.fresh) continue;
    if ('ageMs' in result) {
      reasons.push({ item, reason: result.reason, ageMs: result.ageMs, maxAgeMs: result.maxAgeMs });
    } else {
      reasons.push({ item, reason: result.reason });
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
