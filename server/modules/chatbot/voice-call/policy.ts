/**
 * Pure rules for voice calls: phone masking, seconds quota, call duration, and webhook signatures.
 * No storage, no network, no clock. Every function here is deterministic and testable on its own.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Number of trailing digits that may appear in any output or log line. */
export const VISIBLE_PHONE_DIGITS = 4;

/** Keys whose values are never written to logs, whatever their content. */
export const LOG_DENY_KEYS: ReadonlySet<string> = new Set([
  "rawBody",
  "body",
  "credentials",
  "signature",
  "secret",
  "audio",
  "transcript",
]);

/**
 * Masks a phone number so only the last four digits remain. Formatting characters are dropped.
 * Numbers with four digits or fewer are fully hidden. Returns null for empty input.
 */
export function maskPhone(value: string | null | undefined): string | null {
  if (value == null) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length <= VISIBLE_PHONE_DIGITS) return "*".repeat(4);
  return "*".repeat(digits.length - VISIBLE_PHONE_DIGITS) + digits.slice(-VISIBLE_PHONE_DIGITS);
}

// Lookarounds keep UUID segments and identifiers such as "a1-2345-6789" out of the match.
const PHONE_LIKE = /(?<![\w-])\+?\d[\d\s().-]{5,}\d(?![\w-])/g;

/** Masks every phone-like run of eight or more digits inside free text (error messages, provider text). */
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactPhoneText(text: string): string {
  return text.replace(PHONE_LIKE, (match) => {
    if (UUID_ONLY.test(match)) return match;
    const digits = match.replace(/\D/g, "");
    return digits.length >= 8 ? (maskPhone(match) ?? "****") : match;
  });
}

/** Accepts E.164-style numbers only: optional +, then 6 to 15 digits. Spaces, dashes and brackets are allowed. */
export function isPlausiblePhone(value: string): boolean {
  const compact = value.replace(/[\s().-]/g, "");
  return /^\+?\d{6,15}$/.test(compact);
}

export type QuotaDecision =
  | { allowed: true; remainingSeconds: number | null }
  | { allowed: false; reason: "plan_disabled" | "limit_reached" };

/**
 * Seconds quota for one chatbot in one month.
 * secondsLimit: -1 means unlimited, 0 means voice calls are not in the plan, any other negative or
 * non-integer value fails closed as disabled. A positive value is the monthly cap.
 * usedSeconds: completed call seconds this month. reservedSeconds: caps still held by calls in progress.
 */
export function evaluateQuota(input: {
  secondsLimit: number;
  usedSeconds: number;
  reservedSeconds: number;
}): QuotaDecision {
  const { secondsLimit, usedSeconds, reservedSeconds } = input;
  if (!Number.isInteger(secondsLimit) || secondsLimit === 0 || secondsLimit < -1) {
    return { allowed: false, reason: "plan_disabled" };
  }
  if (secondsLimit === -1) return { allowed: true, remainingSeconds: null };
  const remaining = secondsLimit - usedSeconds - reservedSeconds;
  if (remaining <= 0) return { allowed: false, reason: "limit_reached" };
  return { allowed: true, remainingSeconds: remaining };
}

/** Moment a call must end, given when it was answered and its cap. Null when the call has no cap. */
export function limitDeadline(startedAt: Date, maxSeconds: number | null): Date | null {
  if (maxSeconds == null) return null;
  return new Date(startedAt.getTime() + maxSeconds * 1000);
}

/**
 * Billable duration from server timestamps. Client-reported durations are never used.
 * An unanswered call is 0 seconds. A capped call never exceeds its cap.
 */
export function callDurationSeconds(startedAt: Date | null, endedAt: Date, maxSeconds: number | null): number {
  if (!startedAt) return 0;
  const elapsed = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  return maxSeconds == null ? elapsed : Math.min(elapsed, maxSeconds);
}

/** Start of the calendar month in UTC, used as the quota window. */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** HMAC-SHA256 over "<timestamp>.<rawBody>", hex encoded. Providers that sign this way can use it directly. */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/**
 * Constant-time check of a webhook signature. Missing secret, missing signature, or a length mismatch is a
 * rejection. An optional "sha256=" prefix on the header is accepted.
 */
export function verifySignedWebhook(input: {
  secret: string | null | undefined;
  timestamp: string | null;
  rawBody: string;
  signature: string | null;
}): boolean {
  if (!input.secret || !input.signature || !input.timestamp) return false;
  const provided = input.signature.trim().toLowerCase().replace(/^sha256=/, "");
  const expected = signWebhookPayload(input.secret, input.timestamp, input.rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Parses a webhook timestamp given as Unix seconds or ISO 8601. Returns null when it is absent or unreadable.
 * A timestamp outside the freshness window (in either direction) is rejected by the caller.
 */
export function parseWebhookTimestamp(raw: string | null): Date | null {
  if (raw == null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  const date = /^\d+$/.test(trimmed) ? new Date(Number(trimmed) * 1000) : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isFreshWebhook(timestamp: Date, now: Date, maxAgeSeconds: number): boolean {
  return Math.abs(now.getTime() - timestamp.getTime()) <= maxAgeSeconds * 1000;
}
