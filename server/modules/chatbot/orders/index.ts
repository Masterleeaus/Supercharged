/**
 * Native orders module entry point. Port of the Commerce Crew native order runtime for Desk.
 *
 * Off by default. The module refuses to run unless the caller passes `enabled: true`. Desk code reads
 * the environment in one place and passes the result in. This matches the chatbot module, which takes
 * its feature switches as options and does not read process.env itself.
 *
 *   const enabled = nativeOrdersEnabled(process.env);
 *   const orders = createOrderService({ storage: createMemoryOrderStorage(), enabled });
 */
export { createOrderService, type OrderService, type OrderServiceOptions, type OrderDetail, type ReturnDetail, type CheckoutOrderInput, type CheckoutLineInput, type ReturnRequestInput, type CouponInput, type CouponCartInput, type CouponQuote, type CouponCartScope } from "./order-service.ts";
export { createMemoryOrderStorage, type OrderStorage } from "./order-storage.ts";
export { noopOrderEventPublisher, type OrderEventPublisher, type OrderPublishedEvent } from "./order-events.ts";
export { OrderError } from "./order-errors.ts";
export { canTransitionOrder, canTransitionReturn, ORDER_STATUSES, RETURN_STATUSES, type OrderStatus, type ReturnStatus } from "./lifecycle.ts";
export { computeLineTotals, computeOrderTotals, type OrderTotals, type PricedLineInput } from "./totals.ts";
export type {
  CouponAppliesTo,
  CouponRecord,
  CouponType,
  CouponUsageRecord,
  OrderEventRecord,
  OrderItemRecord,
  OrderRecord,
  ReturnItemRecord,
  ReturnRecord,
  ReturnResolution,
} from "./order-types.ts";

export const NATIVE_ORDERS_FLAG = "CHATBOT_NATIVE_ORDERS_ENABLED";

/** Reads the feature flag from an env-like object. Anything other than the exact string "true" is off. */
export function nativeOrdersEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[NATIVE_ORDERS_FLAG] === "true";
}
