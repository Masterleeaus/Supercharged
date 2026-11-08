/**
 * Voice seconds limit, pure functions. No storage, no clock.
 *
 * The plan column is plans.voice_call_seconds_limit (source: extensions/chatbot/database/migrations/
 * 2025_10_02_000001_add_voice_call_seconds_limit_to_plans.php). Its default is -1, which means unlimited.
 * Every other value is a whole number of seconds. The limit is applied per voice session, in milliseconds.
 */

/** Fail closed: a missing or unreadable plan value gives no voice time at all. */
export const NO_VOICE_TIME_MS = 0;

/**
 * Converts the raw plan value to a session limit in milliseconds.
 * - null or undefined (no plan found): 0, no voice time.
 * - negative (the migration default is -1): null, unlimited.
 * - a whole number of seconds >= 0: that many seconds in milliseconds.
 * - anything else (fraction, NaN, Infinity): 0, no voice time.
 */
export function planLimitToMs(rawSeconds: number | null | undefined): number | null {
  if (rawSeconds === null || rawSeconds === undefined) return NO_VOICE_TIME_MS;
  if (!Number.isInteger(rawSeconds)) return NO_VOICE_TIME_MS;
  if (rawSeconds < 0) return null;
  return rawSeconds * 1000;
}

export type DurationCheck = { ok: true; ms: number | null } | { ok: false };

/**
 * Reads the caller-reported audio duration. null is allowed (unknown). A negative, fractional or non-finite
 * value is rejected, because it could be used to skip the limit.
 */
export function normalizeDurationMs(durationMs: number | null): DurationCheck {
  if (durationMs === null) return { ok: true, ms: null };
  if (!Number.isInteger(durationMs) || durationMs < 0) return { ok: false };
  return { ok: true, ms: durationMs };
}

/**
 * True when a session has had no activity for at least idleMs. lastActivityAt is the session's updatedAt, which
 * every turn step (reserve, release, end) moves forward.
 */
export function isIdle(lastActivityAt: Date, now: Date, idleMs: number): boolean {
  return now.getTime() - lastActivityAt.getTime() >= idleMs;
}

/** Milliseconds left in a session, or null when the session is unlimited. Never negative. */
export function remainingMs(limitMs: number | null, usedMs: number): number | null {
  if (limitMs === null) return null;
  return Math.max(0, limitMs - usedMs);
}
