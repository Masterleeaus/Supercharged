/**
 * External booking port. Calendly and Cal.com are optional calendar sources. Native bookings (bookings/) do not
 * use this port. Flag: CHATBOT_EXTERNAL_CALENDARS_ENABLED.
 *
 * Reminders are sent through ReminderSender. The bookings slice decides when a reminder is due; this port only sends it.
 */
import type { HttpClient } from "./http.ts";
import type { ReminderChannel } from "../bookings/types.ts";

export const CALENDAR_PROVIDER_KEYS = ["calendly", "calcom"] as const;
export type CalendarProviderKey = (typeof CALENDAR_PROVIDER_KEYS)[number];

/** Decrypted credentials for one calendar connection. In memory for one call. Never logged. */
export type CalendarCredentials = Readonly<Record<string, string>>;

export interface CalendarConnectionRef {
  companyId: string;
  chatbotId: string;
  provider: CalendarProviderKey;
  /** Id of the event type or event type URI on the provider side. */
  externalEventTypeId: string;
}

export interface CalendarEventType {
  externalId: string;
  name: string;
  durationMinutes: number;
  active: boolean;
}

export interface CalendarSlotWindow {
  /** ISO 8601 with offset. */
  from: string;
  to: string;
  timezone: string;
}

export interface CalendarSlot {
  startsAt: string;
  endsAt: string;
}

export interface CalendarBookingRequest {
  startsAt: string;
  endsAt: string;
  timezone: string;
  customerName: string;
  customerEmail: string;
  /** Same key on a retry returns the existing booking. */
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface CalendarBookingResult {
  externalBookingId: string;
  startsAt: string;
  endsAt: string;
  /** Link the customer can use to reschedule or cancel on the provider's page. */
  manageUrl: string | null;
}

export interface CalendarWebhookInput {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
}

export interface CalendarWebhookEvent {
  providerEventId: string;
  type: "booking.created" | "booking.cancelled" | "booking.rescheduled" | "other";
  externalBookingId: string | null;
  occurredAt: Date;
}

export interface CalendarProvider {
  readonly key: CalendarProviderKey;
  listEventTypes(companyId: string, chatbotId: string, credentials: CalendarCredentials, http: HttpClient): Promise<CalendarEventType[]>;
  listSlots(ref: CalendarConnectionRef, window: CalendarSlotWindow, credentials: CalendarCredentials, http: HttpClient): Promise<CalendarSlot[]>;
  createBooking(ref: CalendarConnectionRef, request: CalendarBookingRequest, credentials: CalendarCredentials, http: HttpClient): Promise<CalendarBookingResult>;
  cancelBooking(ref: CalendarConnectionRef, externalBookingId: string, reason: string | null, credentials: CalendarCredentials, http: HttpClient): Promise<boolean>;
  /** Fails closed: returns false when the signature or secret is missing or wrong. */
  verifyWebhook(companyId: string, input: CalendarWebhookInput, credentials: CalendarCredentials): Promise<boolean>;
  parseWebhook(companyId: string, rawBody: string): CalendarWebhookEvent[];
  /**
   * Optional. Lists bookings the provider holds for this connection in a window, for reconciliation. Added by
   * change request C4 (booking-providers slice). Optional so providers that cannot list still compile.
   */
  listBookings?(
    ref: CalendarConnectionRef,
    window: CalendarBookingWindow,
    credentials: CalendarCredentials,
    http: HttpClient,
  ): Promise<CalendarExternalBooking[]>;
}

/** Time window for listBookings. Both ends are instants. */
export interface CalendarBookingWindow {
  from: Date;
  to: Date;
}

/** One booking as the provider reports it. Customer details are deliberately absent. */
export interface CalendarExternalBooking {
  externalBookingId: string;
  startsAt: Date;
  endsAt: Date;
  status: "active" | "cancelled";
}

export interface ReminderRequest {
  companyId: string;
  appointmentId: string;
  channel: ReminderChannel;
  /** Recipient address for the channel: email address, phone number, or chat id. */
  recipient: string;
  body: string;
  /** Same key must not send the reminder twice. Usually appointmentId plus channel plus sendAt. */
  idempotencyKey: string;
}

export type ReminderSendResult =
  | { status: "sent"; externalMessageId: string | null }
  | { status: "failed"; retryable: boolean; reason: string };

export interface ReminderSender {
  readonly channel: ReminderChannel;
  send(request: ReminderRequest, http: HttpClient): Promise<ReminderSendResult>;
}
