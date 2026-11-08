/**
 * Helpers shared by the inventory and fulfilment services: input checks, stock row locking and the
 * stale-reservation sweep. Each helper takes the transaction-scoped storage as its first argument.
 */
import { ChatbotError } from "../chatbot-scope.ts";
import type { FulfilmentStorage } from "./fulfilment-storage.ts";
import { canTransitionReservation, availableUnits } from "./state.ts";
import {
  RESERVATION_STATUS,
  type FulfilmentMethod,
  FULFILMENT_METHODS,
  type Id,
  type ReservationRecord,
  type StockRecord,
} from "./types.ts";

/** 422 for rejected input or state, 409 for conflicts, 404 for missing rows in scope. */
export function fail(message: string, status = 422): ChatbotError {
  return new ChatbotError(message, status);
}

export function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw fail(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function requireIdempotencyKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key === "" || key.length > 191) {
    throw fail("A non-empty idempotency key of at most 191 characters is required.");
  }
  return key;
}

export function requireId(value: unknown, field: string): Id {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`${field} is required.`);
  }
  return value.trim();
}

export function requireMethod(value: unknown): FulfilmentMethod {
  if (typeof value !== "string" || !(FULFILMENT_METHODS as readonly string[]).includes(value)) {
    throw fail("methodType must be one of delivery, pickup or digital.");
  }
  return value as FulfilmentMethod;
}

/**
 * Returns the stock row for (variant, location), creating a zero row when none exists. Writes made
 * inside a transaction are rolled back with it, so a failed request leaves no empty row behind.
 */
export async function lockStock(
  tx: FulfilmentStorage,
  companyId: Id,
  variantId: Id,
  locationId: Id | null,
): Promise<StockRecord> {
  if (locationId !== null) {
    await requireLocation(tx, companyId, locationId);
  }
  const existing = await tx.getStock(companyId, variantId, locationId);
  if (existing) return existing;

  const created: StockRecord = {
    companyId,
    variantId,
    locationId,
    quantity: 0,
    reserved: 0,
    committed: 0,
    allocated: 0,
    damaged: 0,
    safetyStock: 0,
    incoming: 0,
    lowStockThreshold: 0,
    allowBackorder: false,
    version: 0,
  };
  await tx.saveStock(companyId, created);
  return created;
}

export async function requireLocation(tx: FulfilmentStorage, companyId: Id, locationId: Id) {
  const location = await tx.getLocation(companyId, locationId);
  if (!location) throw fail("Inventory location was not found.", 404);
  return location;
}

/**
 * Marks active reservations on this stock row whose expiry has passed as expired, and returns their
 * units to the free pool. Mirrors InventoryRuntime::expireStaleReservationsForStock.
 */
export async function expireStaleForStock(
  tx: FulfilmentStorage,
  companyId: Id,
  stock: StockRecord,
  at: Date,
): Promise<StockRecord> {
  const active = await tx.listActiveReservations(companyId, stock.variantId, stock.locationId);
  const stale = active.filter((reservation) => reservation.expiresAt.getTime() <= at.getTime());
  if (stale.length === 0) return stock;

  const released = stale.reduce((sum, reservation) => sum + reservation.quantity, 0);
  const updated: StockRecord = {
    ...stock,
    reserved: Math.max(0, stock.reserved - released),
    version: stock.version + 1,
  };
  await tx.saveStock(companyId, updated);

  for (const reservation of stale) {
    await tx.saveReservation(companyId, {
      ...reservation,
      status: RESERVATION_STATUS.expired,
      releasedAt: at,
      releaseReason: "expired",
    });
  }
  return updated;
}

export function assertReservationTransition(from: ReservationRecord["status"], to: ReservationRecord["status"]): void {
  if (!canTransitionReservation(from, to)) {
    throw fail(`Reservation cannot transition from ${from} to ${to}.`);
  }
}

export function unitsAvailable(stock: StockRecord): number {
  return availableUnits(stock);
}
