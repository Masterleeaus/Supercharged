/**
 * Pure rules for fulfilment and reservation state, plus the availability arithmetic.
 * Ported from Support/FulfillmentStatus.php, Support/InventoryReservationState.php and
 * Support/InventoryAvailability.php. No I/O, so the rules can be tested in isolation.
 */
import {
  FULFILMENT_STATUS,
  RESERVATION_STATUS,
  type FulfilmentStatus,
  type ReservationStatus,
} from "./types.ts";

const FULFILMENT_TRANSITIONS: Record<FulfilmentStatus, readonly FulfilmentStatus[]> = {
  pending: [FULFILMENT_STATUS.processing, FULFILMENT_STATUS.shipped, FULFILMENT_STATUS.cancelled],
  processing: [FULFILMENT_STATUS.shipped, FULFILMENT_STATUS.cancelled],
  shipped: [FULFILMENT_STATUS.delivered],
  delivered: [],
  cancelled: [],
};

const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  active: [RESERVATION_STATUS.committed, RESERVATION_STATUS.released, RESERVATION_STATUS.expired],
  committed: [],
  released: [],
  expired: [],
};

export function canTransitionFulfilment(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
  return FULFILMENT_TRANSITIONS[from].includes(to);
}

export function canTransitionReservation(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

/** A fulfilment that holds an allocation against an order. Cancelled ones do not. */
export function holdsOrderQuantity(status: FulfilmentStatus): boolean {
  return status !== FULFILMENT_STATUS.cancelled;
}

/** A fulfilment whose units have left the building. */
export function isShipped(status: FulfilmentStatus): boolean {
  return status === FULFILMENT_STATUS.shipped || status === FULFILMENT_STATUS.delivered;
}

export type FulfilmentAggregate = "unfulfilled" | "partially_fulfilled" | "fulfilled" | "delivered";

/** Same rule as FulfillmentStatus::aggregate in the PHP source. */
export function aggregateFulfilment(
  totalQuantity: number,
  fulfilledQuantity: number,
  deliveredQuantity: number,
): FulfilmentAggregate {
  if (totalQuantity < 1 || fulfilledQuantity < 1) return "unfulfilled";
  if (deliveredQuantity >= totalQuantity) return "delivered";
  if (fulfilledQuantity >= totalQuantity) return "fulfilled";
  return "partially_fulfilled";
}

export interface StockLevels {
  quantity: number;
  reserved: number;
  committed: number;
  damaged: number;
  safetyStock: number;
}

/** quantity minus reserved, committed, damaged and safety stock, never below zero. */
export function availableUnits(levels: StockLevels): number {
  return Math.max(0, levels.quantity - levels.reserved - levels.committed - levels.damaged - levels.safetyStock);
}

/**
 * Deterministic JSON with object keys sorted at every depth. Used for the idempotency request hash,
 * so the same request always hashes the same way regardless of key order.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
