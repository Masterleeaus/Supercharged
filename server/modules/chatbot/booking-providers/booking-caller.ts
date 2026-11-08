/**
 * Retry-safe booking. One attempt row per (company, provider, idempotency key) is written before any request.
 *
 * Why this is needed: neither Calendly nor Cal.com takes an idempotency key on booking create (see DECISIONS.md,
 * P2 and P5). A client that retries after a timeout could therefore create two events. This caller stops that:
 *
 *  - A new key creates a "pending" row, then the provider is called once.
 *  - The same key again returns the stored booking ("booked"). No second request is made.
 *  - The same key with different booking fields is refused (key_reused).
 *  - A timeout, a network error, a 5xx or an unreadable reply leaves the row "unknown". The provider may have
 *    booked it, so a retry is refused until an operator has checked the provider (outcome_unknown).
 *  - A 4xx or 429 means the provider refused the request, so the row is "rejected" and the same key may be
 *    retried on purpose.
 *  - A call that is still running blocks a second call with the same key (in_progress).
 *
 * Nothing here logs. Errors carry fixed messages and never the key, the request body or the credentials.
 */
import { createHash } from "node:crypto";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type {
  CalendarBookingRequest,
  CalendarBookingResult,
  CalendarConnectionRef,
  CalendarCredentials,
  CalendarProvider,
  HttpClient,
} from "../contracts/index.ts";
import { CalendarProviderError } from "./errors.ts";
import type { BookingAttemptOutcome, BookingAttemptStore, ProviderLinkRecord, ProviderLinkStore } from "./types.ts";
import { parseInstant } from "./util.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,128}$/;

export type BookingAttemptCode = "in_progress" | "outcome_unknown" | "key_reused";

export class BookingAttemptError extends ChatbotError {
  readonly code: BookingAttemptCode;

  constructor(code: BookingAttemptCode, message: string) {
    super(message, 409);
    this.name = "BookingAttemptError";
    this.code = code;
  }
}

export interface BookingCallerDeps {
  provider: CalendarProvider;
  links: ProviderLinkStore;
  attempts: BookingAttemptStore;
  http: HttpClient;
  now?: () => Date;
}

export interface BookingCallInput {
  companyId: string;
  chatbotId: string;
  appointmentId: string | null;
  ref: CalendarConnectionRef;
  request: CalendarBookingRequest;
  credentials: CalendarCredentials;
}

export interface BookingCallResult {
  booking: CalendarBookingResult;
  link: ProviderLinkRecord;
  /** True when this call returned the booking an earlier call made, and sent no request. */
  replayed: boolean;
}

/**
 * SHA-256 over the fields that define the booking. A retry must match it exactly. The email is lower-cased, because
 * the same address in another case is the same customer.
 */
export function bookingRequestHash(ref: CalendarConnectionRef, request: CalendarBookingRequest): string {
  const canonical = JSON.stringify([
    ref.provider,
    ref.externalEventTypeId,
    parseInstant(request.startsAt, "startsAt").toISOString(),
    parseInstant(request.endsAt, "endsAt").toISOString(),
    request.timezone,
    request.customerName.trim(),
    request.customerEmail.trim().toLowerCase(),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Sorts a provider failure into an attempt outcome. Only a failure that proves no booking was made counts as
 * "rejected". Anything that might have reached the provider counts as "unknown".
 */
function classifyFailure(error: unknown): BookingAttemptOutcome {
  // Thrown before any request: flag off, validation, missing credential.
  if (error instanceof ChatbotError) return { status: "rejected" };
  if (error instanceof CalendarProviderError) {
    if (error.code === "config" || error.code === "invalid_request") return { status: "rejected" };
    if (error.code === "http" && error.status !== null && (error.status === 429 || (error.status >= 400 && error.status < 500))) {
      return { status: "rejected" };
    }
  }
  // Timeouts, network errors, 5xx, an unreadable 2xx reply, or anything unexpected: the booking may exist.
  return { status: "unknown" };
}

export function createBookingCaller(deps: BookingCallerDeps) {
  const now = deps.now ?? (() => new Date());

  const linkBooking = (input: BookingCallInput, booking: CalendarBookingResult, at: Date): Promise<ProviderLinkRecord> =>
    deps.links.insertLink(
      input.companyId,
      {
        chatbotId: input.chatbotId,
        provider: input.ref.provider,
        externalEventTypeId: input.ref.externalEventTypeId,
        externalBookingId: booking.externalBookingId,
        appointmentId: input.appointmentId,
        startsAt: new Date(booking.startsAt),
        endsAt: new Date(booking.endsAt),
        manageUrl: booking.manageUrl,
      },
      at,
    );

  return {
    async book(input: BookingCallInput): Promise<BookingCallResult> {
      const scope = requireCompanyId(input.companyId);
      const provider = deps.provider.key;
      const key = input.request.idempotencyKey;
      if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
        throw new ChatbotError("idempotencyKey must be 8 to 128 characters: letters, digits, colon, underscore or hyphen", 422);
      }
      if (input.ref.provider !== provider || input.ref.companyId !== scope) {
        throw new ChatbotError("booking connection does not match this provider or company", 422);
      }
      const requestHash = bookingRequestHash(input.ref, input.request);
      const at = now();

      const begun = await deps.attempts.begin(scope, provider, key, requestHash, at);
      const record = begun.record;
      if (!begun.created) {
        if (record.requestHash !== requestHash) {
          throw new BookingAttemptError("key_reused", "This idempotency key was used for a different booking");
        }
        if (record.status === "booked") {
          if (record.externalBookingId === null) throw new ChatbotError("stored booking attempt is incomplete", 500);
          const booking: CalendarBookingResult = {
            externalBookingId: record.externalBookingId,
            startsAt: parseInstant(input.request.startsAt, "startsAt").toISOString(),
            endsAt: parseInstant(input.request.endsAt, "endsAt").toISOString(),
            manageUrl: record.manageUrl,
          };
          // Re-linking is safe: insertLink returns the existing row for the same provider booking.
          const link = await linkBooking(input, booking, at);
          return { booking, link, replayed: true };
        }
        if (record.status === "unknown") {
          throw new BookingAttemptError("outcome_unknown", "A previous attempt with this key has an unknown outcome. Check the provider before retrying");
        }
        if (record.status === "pending") {
          throw new BookingAttemptError("in_progress", "A booking with this key is already in progress");
        }
        // rejected: the provider refused it, so nothing was booked. Retry only if this call wins the reclaim.
        const reclaimed = await deps.attempts.reclaim(scope, provider, key, at);
        if (!reclaimed) throw new BookingAttemptError("in_progress", "A booking with this key is already in progress");
      }

      let booking: CalendarBookingResult;
      try {
        booking = await deps.provider.createBooking(input.ref, input.request, input.credentials, deps.http);
      } catch (error) {
        // Record the outcome, then rethrow the provider's own error. A failed write here leaves the row pending,
        // which blocks retries until an operator checks it (safe, not a duplicate).
        await deps.attempts.settle(scope, provider, key, classifyFailure(error), now());
        throw error;
      }

      const settled = await deps.attempts.settle(
        scope,
        provider,
        key,
        { status: "booked", externalBookingId: booking.externalBookingId, manageUrl: booking.manageUrl },
        now(),
      );
      if (!settled) throw new BookingAttemptError("outcome_unknown", "The booking could not be recorded. Check the provider before retrying");
      const link = await linkBooking(input, booking, now());
      return { booking, link, replayed: false };
    },
  };
}
