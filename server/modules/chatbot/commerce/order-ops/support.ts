/**
 * Small helpers shared by the order-ops services: connection scope checks, the outbox write, and the
 * flag reader. Pure functions plus one storage call. Nothing here reads the environment itself.
 */
import { readFlag, CONTRACT_FLAGS, type FlagEnv, type MarketplaceConnectionRef } from "../../contracts/index.ts";
import type { OrderOpsStore } from "./storage.ts";
import { OrderOpsError, type ConnectionScope } from "./types.ts";

/** A scope with a different company is treated as absent, so the caller gets a 404 and no hint of the row. */
export function assertConnectionScope(companyId: string, scope: ConnectionScope): void {
  if (scope.companyId !== companyId) throw new OrderOpsError("Marketplace connection not found.", 404);
}

export function connectionRef(scope: ConnectionScope): MarketplaceConnectionRef {
  return { companyId: scope.companyId, connectionId: scope.connectionId, provider: scope.provider };
}

export function requireOwner(scope: ConnectionScope, userId: string, message: string): void {
  if (scope.ownerUserId !== userId) throw new OrderOpsError(message, 422);
}

/** Writes an outbox row inside the caller's transaction. A publish failure later never rolls this back. */
export async function enqueue(
  store: OrderOpsStore,
  companyId: string,
  topic: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  dedupeKey: string,
  now: Date,
): Promise<void> {
  await store.outbox.insert(companyId, {
    topic,
    aggregateId,
    payload,
    dedupeKey,
    status: "pending",
    attempts: 0,
    availableAt: now,
    publishedAt: null,
    createdAt: now,
  });
}

export function marketplaceWriteEnabled(env: FlagEnv): boolean {
  return readFlag(CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED, env);
}

/** Reads a non-negative integer field from a provider payload. Non-integers are refused, not truncated. */
export function intField(value: unknown, field: string, fallback: number | null = null): number {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw new OrderOpsError(`${field} is required`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new OrderOpsError(`${field} must be an integer`);
  }
  return value;
}
