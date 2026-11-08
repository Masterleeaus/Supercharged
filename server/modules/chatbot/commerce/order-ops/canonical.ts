/**
 * Hashing and validation helpers shared by the order-ops services. No storage, no company id: these are pure.
 * Hashes use canonical JSON (sorted keys), so the same data always gives the same hash regardless of key order.
 */
import { createHash } from "node:crypto";
import { OrderOpsError } from "./types.ts";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with object keys sorted. Dates become ISO strings. undefined values are dropped, as in JSON. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function assertMinor(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new OrderOpsError(`${field} must be an integer amount in minor units`);
  }
  return value;
}

export function assertNonNegativeMinor(value: unknown, field: string): number {
  const amount = assertMinor(value, field);
  if (amount < 0) throw new OrderOpsError(`${field} must not be negative`);
  return amount;
}

export function assertCurrency(value: unknown, field = "currency"): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new OrderOpsError(`${field} must be a three-letter upper-case ISO code`);
  }
  return value;
}

export function assertBasisPoints(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new OrderOpsError(`${field} must be an integer between 0 and 10000 basis points`);
  }
  return value;
}

export function requireText(value: unknown, field: string, maxLength = 191): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > maxLength) {
    throw new OrderOpsError(`${field} is required and must be at most ${maxLength} characters`);
  }
  return text;
}

/** Source names as the PHP UnifiedOrderSource normalizes them. "internal" becomes "native". */
export function normalizeSource(source: string): string {
  const value = source.trim().toLowerCase();
  if (value === "internal") return "native";
  return value === "" ? "unknown" : value;
}

export function isExternalSource(source: string): boolean {
  return normalizeSource(source) !== "native";
}
