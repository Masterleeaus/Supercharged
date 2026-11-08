/**
 * Order and return state machines. Ported from Support/OrderLifecycle.php and Support/ReturnLifecycle.php.
 * Only the transitions listed here are valid. Terminal states have no outgoing edges.
 */
import { OrderError } from "./order-errors.ts";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "partially_fulfilled",
  "fulfilled",
  "completed",
  "partially_refunded",
  "returned",
  "payment_failed",
  "cancelled",
  "refunded",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const RETURN_STATUSES = [
  "requested",
  "approved",
  "in_transit",
  "received",
  "inspected",
  "rejected",
  "cancelled",
  "refunded",
  "exchanged",
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ["confirmed", "payment_failed", "cancelled"],
  confirmed: ["processing", "cancelled", "partially_refunded", "refunded"],
  processing: ["partially_fulfilled", "fulfilled", "cancelled", "partially_refunded", "refunded"],
  partially_fulfilled: ["fulfilled", "partially_refunded", "refunded"],
  fulfilled: ["completed", "partially_refunded", "refunded", "returned"],
  completed: ["partially_refunded", "refunded", "returned"],
  partially_refunded: ["refunded", "returned"],
  returned: ["partially_refunded", "refunded"],
  payment_failed: ["pending", "cancelled"],
  cancelled: [],
  refunded: [],
};

const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  requested: ["approved", "rejected", "cancelled"],
  // approved -> refunded matches PHP recordRefund, which accepts an approved return (see REFUNDABLE_RETURN_STATUSES).
  approved: ["in_transit", "received", "cancelled", "refunded"],
  in_transit: ["received", "cancelled"],
  received: ["inspected", "refunded", "exchanged"],
  inspected: ["refunded", "exchanged", "rejected"],
  rejected: [],
  cancelled: [],
  refunded: [],
  exchanged: [],
};

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isReturnStatus(value: string): value is ReturnStatus {
  return (RETURN_STATUSES as readonly string[]).includes(value);
}

export function canTransitionOrder(from: string, to: string): boolean {
  if (!isOrderStatus(from) || !hasOwn(ORDER_TRANSITIONS, from)) {
    return false;
  }
  return (ORDER_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function canTransitionReturn(from: string, to: string): boolean {
  if (!isReturnStatus(from) || !hasOwn(RETURN_TRANSITIONS, from)) {
    return false;
  }
  return (RETURN_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function assertOrderTransition(from: OrderStatus, to: string): OrderStatus {
  if (!isOrderStatus(to)) {
    throw new OrderError(`Unknown order status ${to}.`);
  }
  if (!canTransitionOrder(from, to)) {
    throw new OrderError(`Order cannot move from ${from} to ${to}.`);
  }
  return to;
}

export function assertReturnTransition(from: ReturnStatus, to: string): ReturnStatus {
  if (!isReturnStatus(to)) {
    throw new OrderError(`Unknown return status ${to}.`);
  }
  if (!canTransitionReturn(from, to)) {
    throw new OrderError(`Return cannot move from ${from} to ${to}.`);
  }
  return to;
}

/** Statuses that allow a return to be requested. Matches NativeOrderRuntime::requestReturn. */
export const RETURNABLE_ORDER_STATUSES: readonly OrderStatus[] = ["fulfilled", "completed", "partially_refunded"];

/** Return statuses from which a refund may be recorded. Matches NativeOrderRuntime::recordRefund. */
export const REFUNDABLE_RETURN_STATUSES: readonly ReturnStatus[] = ["approved", "received", "inspected"];
