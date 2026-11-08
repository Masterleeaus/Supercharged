/**
 * Pure spend-limit decision. Port of BudgetLock::evaluate with the same order of checks:
 * currency, then the single-order cap, then the daily cap. All amounts are integer minor units.
 */
import { CartError, type SpendLimitRecord } from "./cart-types.ts";

export type SpendLimitReason = "currency_mismatch" | "max_order_value" | "daily_spend_limit";

export interface SpendLimitState {
  readonly currency: string;
  readonly maxOrderMinor: number | null;
  readonly dailyLimitMinor: number | null;
  readonly spentTodayMinor: number;
}

export interface SpendLimitDecision {
  readonly allowed: boolean;
  readonly reason: SpendLimitReason | null;
  /** Remaining daily allowance after this amount, or null when the limit has no daily cap. */
  readonly remainingDailyMinor: number | null;
}

export function evaluateSpendLimit(amountMinor: number, currency: string, limit: SpendLimitState): SpendLimitDecision {
  const amount = Math.max(0, amountMinor);
  const requested = currency.toUpperCase();
  const configured = limit.currency.toUpperCase();

  if (configured !== "" && configured !== requested) {
    return { allowed: false, reason: "currency_mismatch", remainingDailyMinor: null };
  }

  const remainingBefore = limit.dailyLimitMinor !== null && limit.dailyLimitMinor > 0
    ? Math.max(0, limit.dailyLimitMinor - limit.spentTodayMinor)
    : null;

  if (limit.maxOrderMinor !== null && limit.maxOrderMinor > 0 && amount > limit.maxOrderMinor) {
    return { allowed: false, reason: "max_order_value", remainingDailyMinor: remainingBefore };
  }

  if (limit.dailyLimitMinor !== null && limit.dailyLimitMinor > 0 && limit.spentTodayMinor + amount > limit.dailyLimitMinor) {
    return { allowed: false, reason: "daily_spend_limit", remainingDailyMinor: remainingBefore };
  }

  return {
    allowed: true,
    reason: null,
    remainingDailyMinor: remainingBefore === null ? null : Math.max(0, remainingBefore - amount),
  };
}

/** Spend counted against the limit today. A stored amount from an earlier UTC day counts as zero. */
export function spentOnDate(limit: Pick<SpendLimitRecord, "spentMinor" | "periodDate">, today: string): number {
  return limit.periodDate === today ? limit.spentMinor : 0;
}

/** Adds an amount to today's spend. Throws rather than exceeding the safe-integer range. */
export function addSpend(limit: SpendLimitRecord, amountMinor: number, today: string): number {
  const next = spentOnDate(limit, today) + amountMinor;
  if (!Number.isSafeInteger(next)) {
    throw new CartError("validation", "The spend total is too large.");
  }
  return next;
}
