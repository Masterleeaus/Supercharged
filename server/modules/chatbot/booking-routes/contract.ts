/**
 * Structural contract for the booking HTTP layer. This folder does not import the bookings module
 * (server/modules/chatbot/bookings/), which another agent is writing. The router depends only on
 * BookingService below. BookingStorage describes what that service is expected to sit on, and the
 * in-memory fakes in tests implement it.
 *
 * Every method takes companyId as its first argument and must read or write only rows carrying it.
 * Returning null for a row that exists under another company is required: the router maps null to 404,
 * so a cross-company id looks the same as a missing one.
 */

/**
 * Wire statuses. confirmed is the PHP migration default and the bookings slice's status (bookings/DECISIONS.md D5).
 * waitlisted is written by PHP BookingRuntime. cancelled is set only through the cancel route.
 */
export type BookingStatus = "confirmed" | "waitlisted" | "cancelled";

/** A booking as the HTTP layer returns it. No companyId: the caller already knows its own company. */
export interface BookingView {
  id: string;
  calendarId: number;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  metadata: Record<string, unknown>;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row as storage holds it, carrying the company that owns it. */
export interface BookingRecord extends BookingView {
  companyId: string;
}

export interface BookingListQuery {
  calendarId?: number;
  status?: BookingStatus | "all";
  /** Inclusive lower bound on endsAt (ISO 8601 with offset). */
  from?: string;
  /** Exclusive upper bound on startsAt (ISO 8601 with offset). */
  to?: string;
  limit: number;
  offset: number;
}

export interface NewBookingInput {
  calendarId: number;
  startsAt: string;
  endsAt: string;
  /** Only confirmed or waitlisted can be set on create. Cancelling goes through cancelBooking. */
  status: "confirmed" | "waitlisted";
  metadata: Record<string, unknown>;
}

export interface BookingUpdateInput {
  startsAt?: string;
  endsAt?: string;
  status?: "confirmed" | "waitlisted";
  metadata?: Record<string, unknown>;
}

export interface AssistantSettingsView {
  /** The token itself is never returned. Only whether one is stored. */
  calendlyAccessTokenSet: boolean;
  bookingAssistantConditions: string[];
}

export interface AssistantSettingsUpdate {
  /** A string stores the token. null clears it. Undefined leaves it unchanged. */
  calendlyAccessToken?: string | null;
  bookingAssistantConditions?: string[];
}

export interface BookingStorage {
  listBookings(companyId: string, query: BookingListQuery): Promise<BookingRecord[]>;
  getBooking(companyId: string, id: string): Promise<BookingRecord | null>;
  insertBooking(
    companyId: string,
    row: NewBookingInput & { id: string; createdAt: string; updatedAt: string },
  ): Promise<BookingRecord>;
  updateBooking(
    companyId: string,
    id: string,
    patch: Partial<Omit<BookingRecord, "id" | "companyId" | "createdAt">>,
  ): Promise<BookingRecord | null>;
  /** Non-cancelled bookings on one calendar that overlap [startsAt, endsAt). */
  findOverlapping(
    companyId: string,
    calendarId: number,
    startsAt: string,
    endsAt: string,
    excludeId?: string,
  ): Promise<BookingRecord[]>;
  getAssistantSettings(companyId: string): Promise<{ calendlyAccessToken: string | null; bookingAssistantConditions: string[] } | null>;
  saveAssistantSettings(
    companyId: string,
    patch: { calendlyAccessToken?: string | null; bookingAssistantConditions?: string[] },
  ): Promise<void>;
}

/**
 * Business operations the routes call. Returns null when the booking does not exist for this company.
 * Throws an error with a numeric `status` (400 to 499) and a message for rule failures, such as an
 * overlap (409). The router duck-types on that shape, so the bookings module's own error class works
 * without being imported here.
 */
export interface BookingService {
  listBookings(companyId: string, query: BookingListQuery): Promise<BookingView[]>;
  getBooking(companyId: string, id: string): Promise<BookingView | null>;
  createBooking(companyId: string, input: NewBookingInput): Promise<BookingView>;
  updateBooking(companyId: string, id: string, patch: BookingUpdateInput): Promise<BookingView | null>;
  cancelBooking(companyId: string, id: string, reason: string | null): Promise<BookingView | null>;
  getAssistantSettings(companyId: string): Promise<AssistantSettingsView>;
  updateAssistantSettings(companyId: string, patch: AssistantSettingsUpdate): Promise<AssistantSettingsView>;
}

export interface BookingRouteDef {
  method: "GET" | "POST" | "PATCH";
  path: string;
}

/** Mounted paths relative to the mount base (for example /api/chatbot). Kept next to the router. */
export const BOOKING_ROUTES: readonly BookingRouteDef[] = [
  { method: "GET", path: "/bookings" },
  { method: "POST", path: "/bookings" },
  { method: "GET", path: "/bookings/:id" },
  { method: "PATCH", path: "/bookings/:id" },
  { method: "POST", path: "/bookings/:id/cancel" },
  { method: "GET", path: "/booking-settings" },
  { method: "PATCH", path: "/booking-settings" },
];
