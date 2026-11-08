/**
 * Webhook signature check for payment events. Ported from PaymentWebhookVerifier.php with the same header shape:
 * signature "t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">" and a separate timestamp header.
 *
 * Fails closed: a missing secret, a missing or malformed header, a timestamp outside the tolerance, a timestamp
 * that does not match the signed one, or a wrong MAC all return false. The MAC is compared in constant time.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentWebhookInput } from "../../contracts/index.ts";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

function mac(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

/** Builds the signature header for a body. Used by tests and by a provider's own signing code. */
export function signPaymentWebhook(rawBody: string, secret: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${mac(secret, timestampSeconds, rawBody)}`;
}

/** Returns true only when the signature is valid for this body, timestamp and secret, inside the tolerance. */
export function verifyPaymentWebhookSignature(
  input: PaymentWebhookInput,
  secret: string | undefined,
  nowSeconds: number,
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (typeof secret !== "string" || secret === "") {
    return false;
  }
  if (typeof input.signature !== "string" || input.signature === "") {
    return false;
  }
  if (typeof input.timestamp !== "string" || !/^\d{1,15}$/.test(input.timestamp)) {
    return false;
  }

  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > Math.max(0, toleranceSeconds)) {
    return false;
  }

  let signedTimestamp: string | null = null;
  let providedMac: string | null = null;
  for (const part of input.signature.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && signedTimestamp === null) {
      signedTimestamp = value;
    }
    if (key === "v1" && providedMac === null) {
      providedMac = value;
    }
  }

  if (signedTimestamp !== input.timestamp || providedMac === null || !/^[0-9a-f]{64}$/.test(providedMac)) {
    return false;
  }

  const expected = Buffer.from(mac(secret, timestamp, input.rawBody), "hex");
  const provided = Buffer.from(providedMac, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Stable key for a webhook event. Uses the provider event id, or the body hash when the event has none. */
export function paymentWebhookEventKey(provider: string, providerEventId: string | null, rawBody: string): string {
  const identity = typeof providerEventId === "string" && providerEventId.trim() !== ""
    ? providerEventId.trim()
    : createHash("sha256").update(rawBody).digest("hex");
  return createHash("sha256").update(`${provider.trim().toLowerCase()}|${identity}`).digest("hex");
}
