/**
 * Calendly calendar provider behind the CalendarProvider contract.
 *
 * Only the access token from the encrypted settings is used for auth. It goes in the Authorization header and
 * nowhere else: not in URLs, not in errors, not in logs. Provider URLs are built from ids, and any URL the provider
 * returns (pagination) is followed only when it stays under the configured base, so the token never goes to another host.
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
import type { BookingSettingsStore } from "../bookings/drizzle-booking-storage.ts";
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
  type JsonRecord,
} from "./util.ts";

export const CALENDLY_BASE_URL = "https://api.calendly.com";
/** Credential keys. The caller stores these in the encrypted settings and passes them in. */
export const CALENDLY_TOKEN_KEY = "accessToken";
export const CALENDLY_SIGNING_KEY = "webhookSigningKey";

const PROVIDER = "calendly" as const;
/** Calendly's documented tolerance for the webhook timestamp (3 minutes). */
const WEBHOOK_TOLERANCE_MS = 3 * MINUTE_MS;
const RESOURCE_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface CalendlyProviderOptions {
  /** Overrides the flag. Tests pass it explicitly. */
  enabled?: boolean;
  env?: FlagEnv;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export function createCalendlyProvider(options: CalendlyProviderOptions = {}): ManagedCalendarProvider {
  const base = (options.baseUrl ?? CALENDLY_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new RangeError("Calendly baseUrl must be https");
  const timeoutMs = assertTimeout(options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
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
    url: string,
    body?: unknown,
  ) =>
    callJson({
      provider: PROVIDER,
      http,
      method,
      url,
      headers: { authorization: `Bearer ${requireCredential(credentials, CALENDLY_TOKEN_KEY, PROVIDER)}` },
      body,
      timeoutMs,
    });

  /** Follows a provider-supplied next-page URL only when it stays under the base URL. */
  const nextPage = (page: JsonRecord | null): string | null => {
    const pagination = asRecord(page?.pagination);
    const next = pagination?.next_page;
    if (next === undefined || next === null) return null;
    if (typeof next === "string" && next.startsWith(`${base}/`)) return next;
    throw badResponse(PROVIDER);
  };

  const eventTypeId = (uri: string): string => {
    const prefix = `${base}/event_types/`;
    const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : "";
    if (!RESOURCE_ID.test(id)) {
      throw new CalendarProviderError(PROVIDER, "invalid_request", "Calendly event type reference is not valid");
    }
    return id;
  };

  const scheduledEventId = (uri: string): string => {
    const prefix = `${base}/scheduled_events/`;
    const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : "";
    if (!RESOURCE_ID.test(id)) {
      throw new CalendarProviderError(PROVIDER, "invalid_request", "Calendly booking reference is not valid");
    }
    return id;
  };

  const userUri = async (http: HttpClient, credentials: CalendarCredentials): Promise<string> => {
    const { json } = await request(http, credentials, "GET", `${base}/users/me`);
    const uri = readString(asRecord(asRecord(json)?.resource), "uri");
    if (!uri || !uri.startsWith(`${base}/users/`)) throw badResponse(PROVIDER);
    return uri;
  };

  const eventTypeDuration = async (
    uri: string,
    http: HttpClient,
    credentials: CalendarCredentials,
  ): Promise<number> => {
    const id = eventTypeId(uri);
    const { json } = await request(http, credentials, "GET", `${base}/event_types/${id}`);
    const duration = readNumber(asRecord(asRecord(json)?.resource), "duration");
    if (duration === null || duration <= 0) throw badResponse(PROVIDER);
    return duration;
  };

  /** Collects every page of a Calendly collection. */
  const collectAll = async (
    firstUrl: string,
    http: HttpClient,
    credentials: CalendarCredentials,
  ): Promise<JsonRecord[]> => {
    const items: JsonRecord[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; url !== null; page++) {
      // A listing that is cut short would make reconciliation report false discrepancies, so it fails instead.
      if (page >= MAX_LIST_PAGES) throw badResponse(PROVIDER);
      const { json } = await request(http, credentials, "GET", url);
      const record = asRecord(json);
      const collection = record && Array.isArray(record.collection) ? record.collection : null;
      if (!collection) throw badResponse(PROVIDER);
      for (const item of collection) {
        const row = asRecord(item);
        if (row) items.push(row);
      }
      url = nextPage(record);
    }
    return items;
  };

  return {
    key: PROVIDER,

    async listEventTypes(companyId, _chatbotId, credentials, http) {
      requireCompanyId(companyId);
      requireEnabled();
      const user = await userUri(http, credentials);
      const query = new URLSearchParams({ user, count: "100" });
      const rows = await collectAll(`${base}/event_types?${query.toString()}`, http, credentials);
      const types: CalendarEventType[] = [];
      for (const row of rows) {
        const uri = readString(row, "uri");
        const name = readString(row, "name");
        const duration = readNumber(row, "duration");
        if (!uri || !name || duration === null) throw badResponse(PROVIDER);
        types.push({ externalId: uri, name, durationMinutes: duration, active: row.active !== false });
      }
      return types;
    },

    async listSlots(ref: CalendarConnectionRef, window: CalendarSlotWindow, credentials, http) {
      requireEnabled();
      const from = parseInstant(window.from, "from");
      const to = parseInstant(window.to, "to");
      assertWindow(from, to);
      if (!isValidTimezone(window.timezone)) throw new ChatbotError("timezone is not a valid IANA zone", 422);

      const id = eventTypeId(ref.externalEventTypeId);
      const duration = await eventTypeDuration(ref.externalEventTypeId, http, credentials);
      const durationMs = duration * MINUTE_MS;
      const offered = new Map<string, CalendarSlot>();

      for (const piece of chunkWindow(from, to, MAX_REQUEST_WINDOW_DAYS)) {
        const query = new URLSearchParams({
          event_type: `${base}/event_types/${id}`,
          start_time: piece.from.toISOString(),
          end_time: piece.to.toISOString(),
        });
        const { json } = await request(http, credentials, "GET", `${base}/event_type_available_times?${query.toString()}`);
        const record = asRecord(json);
        const collection = record && Array.isArray(record.collection) ? record.collection : null;
        if (!collection) throw badResponse(PROVIDER);
        for (const item of collection) {
          const row = asRecord(item);
          if (row?.status !== "available") continue;
          const startText = readString(row, "start_time");
          if (!startText) throw badResponse(PROVIDER);
          const start = new Date(startText);
          if (Number.isNaN(start.getTime())) throw badResponse(PROVIDER);
          const end = new Date(start.getTime() + durationMs);
          if (start.getTime() < from.getTime() || end.getTime() > to.getTime()) continue;
          offered.set(start.toISOString(), { startsAt: start.toISOString(), endsAt: end.toISOString() });
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

      const id = eventTypeId(ref.externalEventTypeId);
      // Calendly has no request-level idempotency key and does not store our metadata. Retry protection is enforced
      // by booking-caller.ts (one attempt row per idempotency key, checked before this request). See DECISIONS.md, P5.
      const { json } = await request(http, credentials, "POST", `${base}/invitees`, {
        event_type: `${base}/event_types/${id}`,
        start_time: startsAt.toISOString(),
        invitee: { name: input.customerName, email: input.customerEmail, timezone: input.timezone },
      });
      // The invitee docs show "event", "reschedule_url" and "cancel_url" at the top level of the response. Some
      // single-resource responses wrap the object in "resource", so both places are read. The event must sit under
      // this provider's scheduled_events path, or the response is refused.
      const top = asRecord(json);
      const wrapped = asRecord(top?.resource);
      const eventUri = readString(top, "event") ?? readString(wrapped, "event");
      if (!eventUri || !eventUri.startsWith(`${base}/scheduled_events/`)) throw badResponse(PROVIDER);
      return {
        externalBookingId: eventUri,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        manageUrl:
          readString(top, "reschedule_url") ??
          readString(wrapped, "reschedule_url") ??
          readString(top, "cancel_url") ??
          readString(wrapped, "cancel_url"),
      } satisfies CalendarBookingResult;
    },

    async cancelBooking(_ref, externalBookingId, reason, credentials, http) {
      requireEnabled();
      const id = scheduledEventId(externalBookingId);
      try {
        await request(
          http,
          credentials,
          "POST",
          `${base}/scheduled_events/${id}/cancellation`,
          reason ? { reason } : {},
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
      const user = await userUri(http, credentials);
      const found = new Map<string, RemoteBooking>();
      for (const piece of chunkWindow(window.from, window.to, MAX_REQUEST_WINDOW_DAYS)) {
        const query = new URLSearchParams({
          user,
          min_start_time: piece.from.toISOString(),
          max_start_time: piece.to.toISOString(),
          count: "100",
        });
        const rows = await collectAll(`${base}/scheduled_events?${query.toString()}`, http, credentials);
        for (const row of rows) {
          const uri = readString(row, "uri");
          const start = readString(row, "start_time");
          const end = readString(row, "end_time");
          if (!uri || !start || !end) throw badResponse(PROVIDER);
          // Keep only this event type when the provider says which type a booking belongs to.
          const eventType = readString(row, "event_type");
          if (eventType !== null && eventType !== ref.externalEventTypeId) continue;
          found.set(uri, {
            externalBookingId: uri,
            startsAt: new Date(start),
            endsAt: new Date(end),
            status: row.status === "canceled" ? "cancelled" : "active",
          });
        }
      }
      return [...found.values()];
    },

    async verifyWebhook(_companyId, input: CalendarWebhookInput, credentials) {
      const secret = credentials[CALENDLY_SIGNING_KEY];
      if (typeof secret !== "string" || secret.length === 0 || !input.signature) return false;
      // Header form: "t=<unix seconds>,v1=<hex>". The v1 value signs "<t>.<raw body>".
      const parts = input.signature.split(",").map((part) => part.trim());
      const t = parts.find((part) => part.startsWith("t="))?.slice(2);
      const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
      if (!t || !/^\d{1,12}$/.test(t) || signatures.length === 0) return false;
      if (input.timestamp !== null && input.timestamp !== t) return false;
      if (Math.abs(now().getTime() - Number(t) * 1000) > WEBHOOK_TOLERANCE_MS) return false;
      const expected = hmacHex(secret, `${t}.${input.rawBody}`);
      let matched = false;
      for (const candidate of signatures) {
        if (safeEqualText(candidate, expected)) matched = true;
      }
      return matched;
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
      const event = readString(record, "event");
      const type: CalendarWebhookEvent["type"] =
        event === "invitee.created" ? "booking.created" : event === "invitee.canceled" ? "booking.cancelled" : "other";
      const createdAt = readString(record, "created_at");
      const parsedAt = createdAt ? new Date(createdAt) : now();
      return [
        {
          providerEventId: readString(payload, "uri") ?? `${event ?? "unknown"}:${createdAt ?? ""}`,
          type,
          externalBookingId: readString(payload, "event"),
          occurredAt: Number.isNaN(parsedAt.getTime()) ? now() : parsedAt,
        },
      ];
    },
  };
}

/**
 * Builds Calendly credentials from the encrypted settings. The token is decrypted here, for one call, and is
 * never returned to the browser. Returns null when no token is stored.
 */
export async function loadCalendlyCredentials(
  companyId: string,
  settings: Pick<BookingSettingsStore, "readCalendlyToken">,
  extra: { webhookSigningKey?: string } = {},
): Promise<CalendarCredentials | null> {
  requireCompanyId(companyId);
  const token = await settings.readCalendlyToken(companyId);
  if (!token) return null;
  const credentials: Record<string, string> = { [CALENDLY_TOKEN_KEY]: token };
  if (extra.webhookSigningKey) credentials[CALENDLY_SIGNING_KEY] = extra.webhookSigningKey;
  return credentials;
}
