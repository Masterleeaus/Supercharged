/**
 * Booking events and webhook signing. Port of WebhookDispatcher.php, without the transport: this module
 * builds the signed body and headers, and the integration layer posts them (out of scope here).
 *
 * Differences from the PHP:
 *  - The signature is computed over the exact string that is sent. PHP signed json_encode($body) and then
 *    let Laravel encode the body again, so the two could differ.
 *  - An empty secret is refused. PHP defaulted the secret to '', which made the HMAC forgeable.
 *  - Event payloads carry ids, times and status only. Customer name, email and phone are never included.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ChatbotError } from "../chatbot-scope.ts";

export const BOOKING_EXTENSION_NAME = "chatbot-booking";
export const BOOKING_SIGNATURE_HEADER = "X-Chatbot-Signature";

export type BookingEventName =
  | "appointment.booked"
  | "appointment.waitlisted"
  | "appointment.status_changed"
  | "reminder.scheduled";

export interface BookingEvent {
  event: BookingEventName;
  extension: typeof BOOKING_EXTENSION_NAME;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** Receives booking events. The default is a no-op; the integration layer supplies the real sink. */
export interface BookingEventSink {
  emit(companyId: string, event: BookingEvent): Promise<void>;
}

export const NOOP_EVENT_SINK: BookingEventSink = {
  async emit() {
    // Intentionally empty. Webhook transport is out of scope for this slice.
  },
};

export function createBookingEvent(event: BookingEventName, payload: Record<string, unknown>, now: Date): BookingEvent {
  return {
    event,
    extension: BOOKING_EXTENSION_NAME,
    payload,
    occurredAt: now.toISOString(),
  };
}

export function signBookingBody(secret: string, body: string): string {
  if (secret.length === 0) {
    throw new ChatbotError("Webhook secret is not configured", 500);
  }
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function verifyBookingSignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signBookingBody(secret, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Builds the exact body and headers to post. The transport must send `body` unchanged. */
export function buildSignedBookingRequest(
  secret: string,
  event: BookingEvent,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      [BOOKING_SIGNATURE_HEADER]: signBookingBody(secret, body),
    },
  };
}
