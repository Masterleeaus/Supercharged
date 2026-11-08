/**
 * Idempotency helpers shared by the money services: a canonical request hash, a required-key check, and an
 * in-process keyed lock. The database unique constraints are the cross-process guard. The lock only serialises
 * calls inside one process so that a provider is not called twice for the same key.
 */
import { createHash } from "node:crypto";
import { MoneyError } from "./money.ts";

const KEY_MAX_LENGTH = 191;

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        sorted[key] = canonicalise(item);
      }
    }
    return sorted;
  }
  return value;
}

/** SHA-256 over JSON with sorted keys. Equal requests hash equally, whatever the key order of the input. */
export function hashRequest(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalise(data))).digest("hex");
}

/** Trims the key and rejects an empty one. Keys longer than 191 characters are cut, as in the PHP port. */
export function requiredIdempotencyKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key === "") {
    throw new MoneyError("validation", "An idempotency key is required.");
  }
  return key.slice(0, KEY_MAX_LENGTH);
}

/** Runs fn for one key at a time inside this process. Keys that differ run in parallel. */
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async function runLocked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
}
