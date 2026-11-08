/**
 * Payment status rules. Ported from PaymentLifecycle.php and PaymentStatus.php, but written against the contract
 * status list (PAYMENT_STATUSES in contracts/commerce.ts). The contract has no partially_captured or
 * partially_refunded status, so partial money movement is read from the captured, authorised and refunded amounts
 * instead of from the status. See DECISIONS.md.
 */
import { PAYMENT_STATUSES, type PaymentStatus } from "../../contracts/index.ts";
import { MoneyError } from "./money.ts";

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ["refunded", "canceled", "failed", "expired"];

const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  requires_payment_method: ["requires_capture", "succeeded", "canceled", "failed", "expired"],
  requires_capture: ["succeeded", "canceled", "failed", "expired"],
  succeeded: ["refunded"],
  refunded: [],
  canceled: [],
  failed: [],
  expired: [],
};

/** Returns the status when value is one the contract allows, otherwise throws. */
export function assertKnownPaymentStatus(value: unknown): PaymentStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(PAYMENT_STATUSES as readonly string[]).includes(status)) {
    throw new MoneyError("validation", "The payment provider returned an unsupported status.");
  }
  return status as PaymentStatus;
}

/** A status may stay the same (partial movement) or follow the transition table. */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new MoneyError("state", `Payment status cannot move from ${from} to ${to}.`);
  }
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/** Amount still open for capture: authorised minus captured, never negative. */
export function remainingCapture(authorizedMinor: number, capturedMinor: number): number {
  return Math.max(0, authorizedMinor - capturedMinor);
}

/** Amount still refundable: captured minus refunded, never negative. */
export function remainingRefund(capturedMinor: number, refundedMinor: number): number {
  return Math.max(0, capturedMinor - refundedMinor);
}

/**
 * Status after a refund. The intent becomes refunded only when every captured cent has been refunded and the
 * full authorised amount has been captured. Otherwise the status does not change.
 */
export function statusAfterRefund(
  current: PaymentStatus,
  capturedMinor: number,
  refundedMinor: number,
  authorizedMinor: number,
): PaymentStatus {
  if (refundedMinor >= capturedMinor && capturedMinor >= authorizedMinor && capturedMinor > 0) {
    return "refunded";
  }
  return current;
}
