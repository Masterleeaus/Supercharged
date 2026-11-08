/**
 * Pure detection of order exceptions. Port of OrderExceptionDetector.php. Returns the exceptions an order
 * currently has. The caller decides what to open, reopen or auto-resolve.
 */
import { createHash } from "node:crypto";
import type { ExceptionType } from "./types.ts";

export interface ExceptionInput {
  paymentStatus: string;
  fulfillmentStatus: string;
  placedAtMs: number | null;
  shippingAddress: Record<string, unknown>;
  stockConflict: boolean;
  returnDisputed: boolean;
  reconciliationStatus: string;
}

export interface DetectedException {
  type: ExceptionType;
  severity: "warning" | "high" | "critical";
  message: string;
}

export function detectExceptions(input: ExceptionInput, nowMs: number, fulfilmentDelaySeconds: number): DetectedException[] {
  const found: DetectedException[] = [];
  const address = input.shippingAddress ?? {};
  const line1 = text(address.line1 ?? address.address_line_1);
  const city = text(address.city ?? address.locality);
  const country = text(address.country ?? address.country_code);
  const fulfilment = input.fulfillmentStatus.toLowerCase();
  if (!(line1 !== "" && city !== "" && country !== "") && !["digital", "not_required"].includes(input.fulfillmentStatus)) {
    found.push({ type: "invalid_address", severity: "high", message: "Shipping address is incomplete." });
  }
  if (["failed", "declined", "cancelled", "chargeback"].includes(input.paymentStatus.toLowerCase())) {
    found.push({ type: "payment_failure", severity: "high", message: "The order payment is not in a successful state." });
  }
  if (input.placedAtMs !== null && input.placedAtMs > 0 && nowMs - input.placedAtMs > fulfilmentDelaySeconds * 1000 && ["", "pending", "unfulfilled", "processing"].includes(fulfilment)) {
    found.push({ type: "fulfillment_delay", severity: "warning", message: "The order has exceeded the fulfilment delay threshold." });
  }
  if (input.stockConflict) {
    found.push({ type: "stock_conflict", severity: "critical", message: "The order has an unresolved stock conflict." });
  }
  if (input.returnDisputed) {
    found.push({ type: "disputed_return", severity: "high", message: "A return or refund is disputed." });
  }
  if (input.reconciliationStatus === "variance") {
    found.push({ type: "settlement_variance", severity: "warning", message: "The reported payout does not reconcile with expected net proceeds." });
  }
  return found;
}

/** Stable per order and type, so a re-scan finds the same exception instead of opening a second one. */
export function exceptionFingerprint(orderId: string, type: ExceptionType): string {
  return createHash("sha256").update(`${orderId}:${type}`, "utf8").digest("hex");
}

export const EXCEPTION_TITLES: Record<ExceptionType, string> = {
  invalid_address: "Invalid or incomplete delivery address",
  payment_failure: "Payment failure",
  fulfillment_delay: "Fulfilment delay",
  stock_conflict: "Stock conflict",
  disputed_return: "Disputed return",
  settlement_variance: "Settlement variance",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
