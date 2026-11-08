/**
 * Cal.com (v2 API) calendar provider behind the CalendarProvider contract.
 *
 * The API key comes from the caller's encrypted credentials and is sent only in the Authorization header.
 * Every request carries a cal-api-version header. The versions are set per endpoint in CALCOM_VERSIONS and
 * The versions and paths were checked against the Cal.com v2 API reference (see DECISIONS.md, section "Provider API
 * facts"). Cal.com has no request idempotency key, so retry safety is enforced by booking-caller.ts, not here.
 *
 * Flag: CHATBOT_EXTERNAL_CALENDARS_ENABLED. Off by default. Webhook verification and parsing do not need the flag.
 */
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import {
  CONTRACT_FLAGS,
  readFlag,
  type CalendarBookingRequest,
  type CalendarBookingResult,
  type CalendarConnectionRef,
  type CalendarCredentials,
  type CalendarEventType,
  type CalendarSlot,
  type CalendarSlotWindow,
  type CalendarWebhookEvent,
  type CalendarWebhookInput,
  type FlagEnv,
  type HttpClient,
} from "../contracts/index.ts";
import { CalendarProviderError } from "./errors.ts";
import { callJson } from "./json-client.ts";
import type { ExternalWindow, ManagedCalendarProvider, RemoteBooking } from "./types.ts";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MAX_LIST_PAGES,
  MAX_REQUEST_WINDOW_DAYS,
  MINUTE_MS,
  asRecord,
  assertTimeout,
  assertWindow,
  badResponse,
  chunkWindow,
  hmacHex,
  isEmail,
  isValidTimezone,
  parseInstant,
  readNumber,
  readString,
  requireCredential,
  safeEqualText,
} from "./util.ts";

export const CALCOM_BASE_URL = "https://api.cal.com/v2";
/** Credential keys. The caller stores these in encrypted settings and passes them in. */
export const CALCOM_API_KEY = "apiKey";
export const CALCOM_WEBHOOK_SECRET = "webhookSecret";
export const CALCOM_SIGNATURE_HEADER = "x-cal-signature-256";

/** Per-endpoint API versions. Override with CalcomProviderOptions.versions if the live API moves on. */
export const CALCOM_VERSIONS = {
  eventTypes: "2024-06-14",
  slots: "2024-09-04",
  bookingsCreate: "2026-02-25",
  bookingsCancel: "2026-02-25",
  bookingsList: "2026-05-01",
} as const;

const PROVIDER = "calcom" as const;
const NUMERIC_ID = /^\d{1,12}$/;
const BOOKING_UID = /^[A-Za-z0-9_-]{1,64}$/;
/** Values of the list endpoint's status filter. "unconfirmed" covers bookings still waiting for the host. */
const BOOKING_STATUSES_TO_LIST = ["upcoming", "past", "cancelled", "unconfirmed"] as const;
/** Booking status values that mean the booking is no longer held (see the booking status enum). */
const CANCELLED_STATUSES = new Set(["cancelled", "rejected"]);

export interface CalcomProviderOptions {
  enabled?: boolean;
  env?: FlagEnv;
  baseUrl?: string;
  timeoutMs?: number;
  versions?: Partial<typeof CALCOM_VERSIONS>;
  now?: () => Date;
}

export function createCalcomProvider(options: CalcomProviderOptions = {}): ManagedCalendarProvider {
  const base = (options.baseUrl ?? CALCOM_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new RangeError("Cal.com baseUrl must be https");
  const timeoutMs = assertTimeout(options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
  const versions = { ...CALCOM_VERSIONS, ...(options.versions ?? {}) };
  const now = options.now ?? (() => new Date());
  const env: FlagEnv = options.env ?? process.env;

  const requireEnabled = (): void => {
    const on = options.enabled ?? readFlag(CONTRACT_FLAGS.EXTERNAL_CALENDARS_ENABLED, env);
    if (!on) throw new ChatbotError("External calendars are not enabled", 503);
  };

  const request = (
    http: HttpClient,
    credentials: CalendarCredentials,
    method: "GET" | "POST",
    path: string,
    version: string,
    query?: URLSearchParams,
    body?: unknown,
  ) => {
    const qs = query && [...query.keys()].length > 0 ? `?${query.toString()}` : "";
    return callJson({
      provider: PROVIDER,
      http,
      method,
      url: `${base}${path}${qs}`,
      headers: {
        authorization: `Bearer ${requireCredential(credentials, CALCOM_API_KEY, PROVIDER)}`,
        "cal-api-version": version,
      },
      body,
      timeoutMs,
    });
  };

  const parseEventTypeId = (externalId: string): number => {
    if (!NUMERIC_ID.test(externalId)) {
      throw new CalendarProviderError(PROVIDER, "invalid_request", "Cal.com event type reference is not valid");
    }
    return Number(externalId);
  };

  const fetchEventTypes = async (http: HttpClient, credentials: CalendarCredentials): Promise<CalendarEventType[]> => {
    const { json } = await request(http, credentials, "GET", "/event-types", versions.eventTypes);
    const data = asRecord(json)?.data;
    if (!Array.isArray(data)) throw badResponse(PROVIDER);
    const types: CalendarEventType[] = [];
    for (const item of data) {
      const row = asRecord(item);
      const id = readNumber(row, "id");
      const title = readString(row, "title");
      const duration = readNumber(row, "lengthInMinutes");
      if (id === null || !title || duration === null) throw badResponse(PROVIDER);
      types.push({ externalId: String(id), name: title, durationMinutes: duration, active: row?.hidden !== true });
    }
    return types;
  };

  /** Cal.com v2 metadata: up to 50 string keys, keys up to 40 characters, values up to 500. */
  const safeMetadata = (metadata: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata).slice(0, 50)) {
      if (key.length > 0 && key.length <= 40 && typeof value === "string") out[key] = value.slice(0, 500);
    }
    return out;
  };

  return {
    key: PROVIDER,

    async listEventTypes(companyId, _chatbotId, credentials, http) {
      requireCompanyId(companyId);
      requireEnabled();
      return fetchEventTypes(http, credentials);
    },

    async listSlots(ref: CalendarConnectionRef, window: CalendarSlotWindow, credentials, http) {
      requireEnabled();
      const from = parseInstant(window.from, "from");
      const to = parseInstant(window.to, "to");
      assertWindow(from, to);
      if (!isValidTimezone(window.timezone)) throw new ChatbotError("timezone is not a valid IANA zone", 422);

      const eventTypeId = parseEventTypeId(ref.externalEventTypeId);
      const eventType = (await fetchEventTypes(http, credentials)).find((t) => t.externalId === String(eventTypeId));
      if (!eventType) throw new CalendarProviderError(PROVIDER, "invalid_request", "Cal.com event type was not found");
      const durationMs = eventType.durationMinutes * MINUTE_MS;

      const offered = new Map<string, CalendarSlot>();
      for (const piece of chunkWindow(from, to, MAX_REQUEST_WINDOW_DAYS)) {
        const query = new URLSearchParams({
          eventTypeId: String(eventTypeId),
          start: piece.from.toISOString(),
          end: piece.to.toISOString(),
          timeZone: window.timezone,
        });
        const { json } = await request(http, credentials, "GET", "/slots", versions.slots, query);
        const data = asRecord(asRecord(json)?.data);
        if (!data) throw badResponse(PROVIDER);
        for (const day of Object.values(data)) {
          if (!Array.isArray(day)) throw badResponse(PROVIDER);
          for (const item of day) {
            const row = asRecord(item);
            const startText = readString(row, "start");
            if (!startText) throw badResponse(PROVIDER);
            const start = new Date(startText);
            if (Number.isNaN(start.getTime())) throw badResponse(PROVIDER);
            const end = new Date(start.getTime() + durationMs);
            if (start.getTime() < from.getTime() || end.getTime() > to.getTime()) continue;
            offered.set(start.toISOString(), { startsAt: start.toISOString(), endsAt: end.toISOString() });
          }
        }
      }
      return [...offered.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },

    async createBooking(ref, input: CalendarBookingRequest, credentials, http) {
      requireEnabled();
      const startsAt = parseInstant(input.startsAt, "startsAt");
      const endsAt = parseInstant(input.endsAt, "endsAt");
      assertWindow(startsAt, endsAt);
      if (!isValidTimezone(input.timezone)) throw new ChatbotError("timezone is not a valid IANA zone", 422);
      if (!isEmail(input.customerEmail)) throw new ChatbotError("customerEmail is not a valid address", 422);
      if (input.customerName.trim().length === 0) throw new ChatbotError("customerName is required", 422);

      const { json } = await request(http, credentials, "POST", "/bookings", versions.bookingsCreate, undefined, {
        start: startsAt.toISOString(),
        eventTypeId: parseEventTypeId(ref.externalEventTypeId),
        attendee: { name: input.customerName, email: input.customerEmail, timeZone: input.timezone, language: "en" },
        metadata: safeMetadata(input.metadata),
      });
      const record = asRecord(json);
      const data = asRecord(record?.data);
      const uid = readString(data, "uid");
      if (record?.status === "error" || !uid || !BOOKING_UID.test(uid)) throw badResponse(PROVIDER);
      return {
        externalBookingId: uid,
        startsAt: readString(data, "start") ?? startsAt.toISOString(),
        endsAt: readString(data, "end") ?? endsAt.toISOString(),
        manageUrl: null,
      } satisfies CalendarBookingResult;
    },

    async cancelBooking(_ref, externalBookingId, reason, credentials, http) {
      requireEnabled();
      if (!BOOKING_UID.test(externalBookingId)) {
        throw new CalendarProviderError(PROVIDER, "invalid_request", "Cal.com booking reference is not valid");
      }
      try {
        await request(
          http,
          credentials,
          "POST",
          `/bookings/${encodeURIComponent(externalBookingId)}/cancel`,
          versions.bookingsCancel,
          undefined,
          reason ? { cancellationReason: reason } : {},
        );
        return true;
      } catch (error) {
        if (error instanceof CalendarProviderError && error.status === 404) return false;
        throw error;
      }
    },

    async listBookings(ref, window: ExternalWindow, credentials, http) {
      requireEnabled();
      assertWindow(window.from, window.to);
      const eventTypeId = parseEventTypeId(ref.externalEventTypeId);
      const found = new Map<string, RemoteBooking>();
      for (const piece of chunkWindow(window.from, window.to, MAX_REQUEST_WINDOW_DAYS)) {
        for (const status of BOOKING_STATUSES_TO_LIST) {
          // Cal.com pages with an opaque cursor (pagination.nextCursor), not skip or take.
          let cursor: string | null = null;
          for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const query = new URLSearchParams({
              status,
              eventTypeIds: String(eventTypeId),
              afterStart: piece.from.toISOString(),
              beforeEnd: piece.to.toISOString(),
              limit: "100",
            });
            if (cursor !== null) query.set("cursor", cursor);
            const { json } = await request(http, credentials, "GET", "/bookings", versions.bookingsList, query);
            const record = asRecord(json);
            const data = record?.data;
            if (!Array.isArray(data)) throw badResponse(PROVIDER);
            for (const item of data) {
              const row = asRecord(item);
              const uid = readString(row, "uid");
              const start = readString(row, "start");
              const end = readString(row, "end");
              if (!uid || !start || !end) throw badResponse(PROVIDER);
              // eventTypeId is deprecated on the booking; the eventType object carries the id. The server filter
              // already applies, so a row without either id is kept and a row with a different id is dropped.
              const typeId = readNumber(asRecord(row?.eventType), "id") ?? readNumber(row, "eventTypeId");
              if (typeId !== null && typeId !== eventTypeId) continue;
              const bookingStatus = readString(row, "status") ?? "";
              found.set(uid, {
                externalBookingId: uid,
                startsAt: new Date(start),
                endsAt: new Date(end),
                status: CANCELLED_STATUSES.has(bookingStatus) ? "cancelled" : "active",
              });
            }
            const pagination = asRecord(record?.pagination);
            if (pagination?.hasMore !== true) break;
            // A listing that is cut short would make reconciliation report false discrepancies, so it fails instead.
            if (page === MAX_LIST_PAGES - 1) throw badResponse(PROVIDER);
            cursor = readString(pagination, "nextCursor");
            if (cursor === null) throw badResponse(PROVIDER);
          }
        }
      }
      return [...found.values()];
    },

    async verifyWebhook(_companyId, input: CalendarWebhookInput, credentials) {
      const secret = credentials[CALCOM_WEBHOOK_SECRET];
      if (typeof secret !== "string" || secret.length === 0 || !input.signature) return false;
      const expected = hmacHex(secret, input.rawBody);
      return safeEqualText(input.signature, expected);
    },

    parseWebhook(_companyId, rawBody): CalendarWebhookEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return [];
      }
      const record = asRecord(parsed);
      if (!record) return [];
      const payload = asRecord(record.payload) ?? {};
      const trigger = readString(record, "triggerEvent");
      const type: CalendarWebhookEvent["type"] =
        trigger === "BOOKING_CREATED"
          ? "booking.created"
          : trigger === "BOOKING_CANCELLED"
            ? "booking.cancelled"
            : trigger === "BOOKING_RESCHEDULED"
              ? "booking.rescheduled"
              : "other";
      const uid = readString(payload, "uid");
      const createdAt = readString(record, "createdAt");
      const parsedAt = createdAt ? new Date(createdAt) : now();
      return [
        {
          providerEventId: `${trigger ?? "unknown"}:${uid ?? ""}:${createdAt ?? ""}`,
          type,
          externalBookingId: uid,
          occurredAt: Number.isNaN(parsedAt.getTime()) ? now() : parsedAt,
        },
      ];
    },
  };
}
