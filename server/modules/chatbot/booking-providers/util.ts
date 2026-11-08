/**
 * Small pure helpers shared by the Calendly and Cal.com providers. No I/O, no globals except the clock
 * passed in by callers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ChatbotError } from "../chatbot-scope.ts";
import type { CalendarCredentials, CalendarProviderKey } from "../contracts/index.ts";
import { CalendarProviderError } from "./errors.ts";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
/** Per-request window cap used by both providers' availability and listing calls. */
export const MAX_REQUEST_WINDOW_DAYS = 31;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
/** Pages followed in one listing. Protects against a provider that never stops paging. */
export const MAX_LIST_PAGES = 20;

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer");
  }
  return timeoutMs;
}

/** Accepts a Date, or an ISO 8601 string with an offset. Anything else is a 422. */
export function parseInstant(value: unknown, label: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ChatbotError(`${label} is not a valid date`, 422);
    return value;
  }
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) {
    throw new ChatbotError(`${label} must be ISO 8601 with an offset or Z`, 422);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ChatbotError(`${label} is not a valid date`, 422);
  return date;
}

export function assertWindow(from: Date, to: Date): void {
  if (to.getTime() <= from.getTime()) throw new ChatbotError("to must be after from", 422);
}

/** Splits [from, to) into pieces no longer than maxDays. */
export function chunkWindow(from: Date, to: Date, maxDays: number = MAX_REQUEST_WINDOW_DAYS): Array<{ from: Date; to: Date }> {
  const pieces: Array<{ from: Date; to: Date }> = [];
  const step = maxDays * DAY_MS;
  for (let start = from.getTime(); start < to.getTime(); start += step) {
    pieces.push({ from: new Date(start), to: new Date(Math.min(start + step, to.getTime())) });
  }
  return pieces;
}

export function isValidTimezone(zone: string): boolean {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

/**
 * Reads a credential that must be present. The error names the key, never the value.
 */
export function requireCredential(credentials: CalendarCredentials, key: string, provider: CalendarProviderKey): string {
  const value = credentials[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CalendarProviderError(provider, "config", `${provider} credential "${key}" is not configured`);
  }
  return value;
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Constant-time comparison of two strings. Unequal lengths return false without comparing bytes. */
export function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function readString(obj: JsonRecord | null, key: string): string | null {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readNumber(obj: JsonRecord | null, key: string): number | null {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function badResponse(provider: CalendarProviderKey): CalendarProviderError {
  return new CalendarProviderError(provider, "bad_response", `${provider} returned an unexpected response`);
}
