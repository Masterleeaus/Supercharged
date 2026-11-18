/**
 * Outbound event catalogue for the bridge (#359). A bridge may subscribe only to these events.
 * Delivery itself (queueing, retries, subscription storage) is not in this module.
 */
export const BRIDGE_EVENTS = [
  'booking.created',
  'job.completed',
  'quote.accepted',
  'invoice.paid',
  'message.received',
] as const;
export type BridgeEvent = (typeof BRIDGE_EVENTS)[number];

export function isBridgeEvent(value: unknown): value is BridgeEvent {
  return typeof value === 'string' && (BRIDGE_EVENTS as readonly string[]).includes(value);
}
