/**
 * Types private to the booking-providers folder. Contract types come from ../contracts/index.ts and are not
 * redefined here.
 */
import type {
  CalendarBookingWindow,
  CalendarConnectionRef,
  CalendarCredentials,
  CalendarExternalBooking,
  CalendarProvider,
  CalendarProviderKey,
  HttpClient,
} from "../contracts/index.ts";
import type { StoredSealed } from "../secrets/sealed-form.ts";

/** Lower bound on the reminder lead time, in minutes. */
export const REMINDER_LEAD_MIN_MINUTES = 5;
/** Upper bound on the reminder lead time: one week. */
export const REMINDER_LEAD_MAX_MINUTES = 7 * 24 * 60;

/** Same shape as the contract's CalendarBookingWindow. Kept as a name so existing callers compile. */
export type ExternalWindow = CalendarBookingWindow;

export type RemoteBookingStatus = CalendarExternalBooking["status"];

/** One booking as the provider reports it. Same shape as the contract's CalendarExternalBooking. */
export type RemoteBooking = CalendarExternalBooking;

/** Lists bookings the provider holds for this connection. Used by reconciliation. */
export interface ExternalBookingLister {
  listBookings(
    ref: CalendarConnectionRef,
    window: ExternalWindow,
    credentials: CalendarCredentials,
    http: HttpClient,
  ): Promise<RemoteBooking[]>;
}

export type ManagedCalendarProvider = CalendarProvider & ExternalBookingLister;

export type LinkStatus = "active" | "cancelled";

/** Local record of a provider booking, keyed by company. Written when a provider booking is created. */
export interface ProviderLinkRecord {
  id: string;
  companyId: string;
  chatbotId: string;
  provider: CalendarProviderKey;
  externalEventTypeId: string;
  externalBookingId: string;
  appointmentId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: LinkStatus;
  manageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProviderLink {
  chatbotId: string;
  provider: CalendarProviderKey;
  externalEventTypeId: string;
  externalBookingId: string;
  appointmentId: string | null;
  startsAt: Date;
  endsAt: Date;
  manageUrl: string | null;
}

export interface ProviderLinkStore {
  /** Inserts a link. A second insert for the same provider booking returns the existing row. */
  insertLink(companyId: string, input: NewProviderLink, now: Date): Promise<ProviderLinkRecord>;
  /** Links whose time range overlaps the window. */
  listLinks(companyId: string, provider: CalendarProviderKey, window: ExternalWindow): Promise<ProviderLinkRecord[]>;
  setLinkStatus(
    companyId: string,
    provider: CalendarProviderKey,
    externalBookingId: string,
    status: LinkStatus,
    now: Date,
  ): Promise<boolean>;
}

export type ReminderSendStatus = "sending" | "sent" | "failed" | "cancelled";

export interface ReminderSendRecord {
  companyId: string;
  appointmentId: string;
  channel: string;
  status: ReminderSendStatus;
  idempotencyKey: string;
  externalMessageId: string | null;
  reason: string | null;
  updatedAt: Date;
}

export type ReminderOutcome =
  | { status: "sent"; externalMessageId: string | null }
  | { status: "failed"; reason: string }
  | { status: "cancelled" };

/**
 * One row per (company, appointment, channel). That row is the "once per booking" guarantee: once it exists,
 * no later run can claim it again, whatever its status.
 */
export interface ReminderLedgerStore {
  /** Inserts a "sending" row when none exists. Returns false when a row already exists. */
  claim(companyId: string, appointmentId: string, channel: string, idempotencyKey: string, now: Date): Promise<boolean>;
  complete(companyId: string, appointmentId: string, channel: string, outcome: ReminderOutcome, now: Date): Promise<void>;
  /** Deletes a "sending" row so the reminder can be tried again. Used after a retryable failure only. */
  release(companyId: string, appointmentId: string, channel: string): Promise<void>;
  /** Inserts a "cancelled" row when none exists. A row already in "sending" or "sent" is left alone. */
  cancel(companyId: string, appointmentId: string, channel: string, now: Date): Promise<void>;
  find(companyId: string, appointmentId: string, channel: string): Promise<ReminderSendRecord | null>;
}

/**
 * pending: the provider call has started and its outcome is not known yet.
 * booked: the provider accepted the booking; the external id and manage link are stored for replay.
 * rejected: the provider refused the request (a 4xx or 429), so no booking exists and the same key may be retried.
 * unknown: the call timed out, the connection failed, or the reply could not be read. A booking may exist.
 *          Nothing retries it automatically; the operator checks the provider first.
 */
export type BookingAttemptStatus = "pending" | "booked" | "rejected" | "unknown";

export interface BookingAttemptRecord {
  companyId: string;
  provider: CalendarProviderKey;
  idempotencyKey: string;
  /** Hash of the booking fields. A retry with the same key and different fields is refused. */
  requestHash: string;
  status: BookingAttemptStatus;
  externalBookingId: string | null;
  manageUrl: string | null;
  updatedAt: Date;
}

export type BookingAttemptOutcome =
  | { status: "booked"; externalBookingId: string; manageUrl: string | null }
  | { status: "rejected" }
  | { status: "unknown" };

/** One row per (company, provider, idempotency key). That row is what stops a retry from posting a second booking. */
export interface BookingAttemptStore {
  /** Inserts a "pending" row when none exists. Returns the row and whether this call created it. */
  begin(
    companyId: string,
    provider: CalendarProviderKey,
    idempotencyKey: string,
    requestHash: string,
    now: Date,
  ): Promise<{ created: boolean; record: BookingAttemptRecord }>;
  /** Moves a "rejected" row back to "pending" for a deliberate retry. Returns false when the row is in any other state. */
  reclaim(companyId: string, provider: CalendarProviderKey, idempotencyKey: string, now: Date): Promise<boolean>;
  /** Moves a "pending" row to its final state. Returns false when the row is not pending. */
  settle(
    companyId: string,
    provider: CalendarProviderKey,
    idempotencyKey: string,
    outcome: BookingAttemptOutcome,
    now: Date,
  ): Promise<boolean>;
}

/** Encrypted calendar secrets. Only the sealed form is stored. Plaintext exists in memory for one call. */
export const CALENDAR_SECRET_PURPOSES = ["api_key", "webhook_secret"] as const;
export type CalendarSecretPurpose = (typeof CALENDAR_SECRET_PURPOSES)[number];

export interface CalendarSecretStorage {
  /** Insert or replace the sealed value for (company, provider, purpose). */
  put(companyId: string, provider: CalendarProviderKey, purpose: CalendarSecretPurpose, sealed: StoredSealed, now: Date): Promise<void>;
  /** Returns the sealed value, or null when absent or stored under another company. */
  get(companyId: string, provider: CalendarProviderKey, purpose: CalendarSecretPurpose): Promise<StoredSealed | null>;
}
