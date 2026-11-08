/**
 * Outbound notification port for order and return events. The Commerce Crew runtime emits these as
 * ExtensionEvent objects. The Desk port has no event bus yet, so the default publisher drops them.
 * A real transport (queue, webhook, Ably) is out of scope for this slice.
 */
export type OrderPublishedEventType = "commerce.order.created" | "commerce.return.requested";

export interface OrderPublishedEvent {
  companyId: string;
  type: OrderPublishedEventType;
  payload: Record<string, unknown>;
}

export interface OrderEventPublisher {
  publish(event: OrderPublishedEvent): void;
}

/** No-op publisher. Used unless the caller injects a real one. */
export const noopOrderEventPublisher: OrderEventPublisher = {
  publish(): void {
    // Intentionally empty. See DECISIONS.md.
  },
};
