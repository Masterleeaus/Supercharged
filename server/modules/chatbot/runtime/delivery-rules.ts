/*
 * Delivery status rules for outbound messages (port of the status logic in MessageRuntime.php).
 * Pure: the caller stores the result. The chatbot storage has no delivery_status column yet, so nothing is persisted here.
 *
 * Rules (from the PHP rank table):
 * - Status only moves forward: queued 10, sent 20, delivered 30, read 40, failed 50.
 * - A same-rank or lower target returns the current status unchanged.
 * - A failed message cannot advance. It must be retried first, which moves it back to queued and counts the retry.
 * - markFailed does nothing to a message that is already read.
 */
import type { MessageStatus } from "../contracts/index.ts";

export const DELIVERY_RANK: Readonly<Record<MessageStatus, number>> = {
  queued: 10,
  sent: 20,
  delivered: 30,
  read: 40,
  failed: 50,
};

export class DeliveryError extends Error {
  constructor(readonly code: "retry_required" | "not_failed") {
    super(code);
    this.name = "DeliveryError";
  }
}

export interface DeliveryResult {
  status: MessageStatus;
  changed: boolean;
  retryCount?: number;
}

/** Advances to sent, delivered or read. Throws when the message is failed. */
export function advanceDelivery(current: MessageStatus, target: Exclude<MessageStatus, "failed">): DeliveryResult {
  if (current === "failed") throw new DeliveryError("retry_required");
  if (DELIVERY_RANK[target] <= DELIVERY_RANK[current]) return { status: current, changed: false };
  return { status: target, changed: true };
}

/** Marks a message failed. A read message keeps its status. */
export function markFailedDelivery(current: MessageStatus): DeliveryResult {
  if (current === "read") return { status: current, changed: false };
  if (current === "failed") return { status: "failed", changed: false };
  return { status: "failed", changed: true };
}

/** Moves a failed message back to queued and adds one to its retry count. Only failed messages can be retried. */
export function retryDelivery(current: MessageStatus, retryCount: number): DeliveryResult {
  if (current !== "failed") throw new DeliveryError("not_failed");
  return { status: "queued", changed: true, retryCount: Math.max(0, Math.trunc(retryCount)) + 1 };
}
