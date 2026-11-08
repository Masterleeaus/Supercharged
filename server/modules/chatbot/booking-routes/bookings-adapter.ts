/**
 * Adapter: builds the BookingService that router.ts expects (contract.ts) on top of the bookings slice service and
 * its storage. Use it as the `service` option of createBookingRouter.
 *
 * The shapes differ, so this file translates:
 *  - calendarId: the router uses a positive number, bookings use a UUID. The storage maps one to the other
 *    (CalendarNumbering in bookings/drizzle-booking-storage.ts).
 *  - Customer details: the router body has no name or contact fields. They are read from metadata
 *    (customer_name, customer_email, customer_phone), moved into their own columns, and removed from metadata.
 *    The bookings validator then enforces the rules (name required, email or phone required).
 *  - Settings: the adapter returns only whether a Calendly token is stored (calendlyAccessTokenSet). The token is
 *    never read here. The storage reports presence; readCalendlyToken is for provider calls and is not used.
 *  - Reschedule and metadata changes have no bookings-slice operation yet. They answer 422 instead of guessing.
 *
 * Errors: rule errors are ChatbotError instances (numeric status, message), which the router maps. "Not found" from
 * the bookings service is turned into null, as the contract requires.
 */
import { ChatbotError } from "../chatbot-scope.ts";
import type { BookingService as SliceBookingService } from "../bookings/booking-service.ts";
import type { BookingStorage } from "../bookings/booking-storage.ts";
import type { BookingSettingsStore, CalendarNumbering } from "../bookings/drizzle-booking-storage.ts";
import type { AppointmentRecord } from "../bookings/types.ts";
import type {
  AssistantSettingsUpdate,
  AssistantSettingsView,
  BookingListQuery,
  BookingService,
  BookingUpdateInput,
  BookingView,
  NewBookingInput,
} from "./contract.ts";

export type BookingsAdapterStorage = BookingStorage & BookingSettingsStore & CalendarNumbering;

export interface BookingsAdapterDeps {
  service: SliceBookingService;
  storage: BookingsAdapterStorage;
}

const CUSTOMER_KEYS = ["customer_name", "customer_email", "customer_phone"] as const;

function isNotFound(err: unknown): boolean {
  return err instanceof ChatbotError && err.status === 404;
}

/** Splits customer details out of metadata. Metadata that is left over is what the caller sent, minus those keys. */
function splitCustomer(metadata: Record<string, unknown>): {
  customer: Record<string, unknown>;
  rest: Record<string, unknown>;
} {
  const customer: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((CUSTOMER_KEYS as readonly string[]).includes(key)) customer[key] = value;
    else rest[key] = value;
  }
  return { customer, rest };
}

export function createBookingRoutesService(deps: BookingsAdapterDeps): BookingService {
  const { service, storage } = deps;

  /** Builds the HTTP view of a stored appointment. Customer name, email and phone are not part of the view. */
  const viewOf = async (companyId: string, record: AppointmentRecord): Promise<BookingView> => {
    const calendarNumber = await storage.calendarNumberOf(companyId, record.calendarId);
    if (calendarNumber === null) {
      throw new ChatbotError("Calendar not found", 404);
    }
    return {
      id: record.id,
      calendarId: calendarNumber,
      startsAt: record.startsAt.toISOString(),
      endsAt: record.endsAt.toISOString(),
      status: record.status,
      metadata: record.metadata ?? {},
      cancelReason: record.statusReason,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  };

  const calendarIdFor = async (companyId: string, calendarNumber: number): Promise<string> => {
    const id = await storage.calendarIdForNumber(companyId, calendarNumber);
    if (!id) throw new ChatbotError("Calendar not found", 404);
    return id;
  };

  const toSliceInput = (calendarId: string, input: NewBookingInput) => {
    const { customer, rest } = splitCustomer(input.metadata);
    return {
      calendar_id: calendarId,
      customer_name: customer.customer_name,
      customer_email: customer.customer_email,
      customer_phone: customer.customer_phone,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      metadata: Object.keys(rest).length > 0 ? rest : undefined,
    };
  };

  const getBooking = async (companyId: string, id: string): Promise<BookingView | null> => {
    const record = await storage.findAppointment(companyId, id);
    return record ? viewOf(companyId, record) : null;
  };

  return {
    async listBookings(companyId, query: BookingListQuery) {
      if (!query.from || !query.to) {
        throw new ChatbotError("from and to are required to list bookings", 422);
      }
      const targets: Array<{ id: string; number: number }> = [];
      if (query.calendarId !== undefined) {
        targets.push({ id: await calendarIdFor(companyId, query.calendarId), number: query.calendarId });
      } else {
        for (const calendar of await storage.listCalendars(companyId)) {
          const number = await storage.calendarNumberOf(companyId, calendar.id);
          if (number !== null) targets.push({ id: calendar.id, number });
        }
      }

      const views: BookingView[] = [];
      for (const target of targets) {
        const records = await service.listAppointments(companyId, target.id, { from: query.from, to: query.to });
        for (const record of records) {
          views.push(await viewOf(companyId, record));
        }
      }

      const wanted = query.status && query.status !== "all" ? query.status : null;
      const sorted = views
        .filter((view) => wanted === null || view.status === wanted)
        .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
      return sorted.slice(query.offset, query.offset + query.limit);
    },

    getBooking,

    async createBooking(companyId, input: NewBookingInput) {
      const calendarId = await calendarIdFor(companyId, input.calendarId);
      const payload = toSliceInput(calendarId, input);
      const record =
        input.status === "waitlisted"
          ? await service.waitlist(companyId, payload)
          : await service.book(companyId, payload);
      return viewOf(companyId, record);
    },

    async updateBooking(companyId, id, patch: BookingUpdateInput) {
      if (patch.startsAt !== undefined || patch.endsAt !== undefined || patch.metadata !== undefined) {
        throw new ChatbotError("Changing the time or metadata of a booking is not supported yet. Cancel and rebook.", 422);
      }
      if (patch.status === undefined) {
        return getBooking(companyId, id);
      }
      try {
        const record =
          patch.status === "confirmed"
            ? await service.promote(companyId, id)
            : await service.transition(companyId, id, "waitlisted");
        return viewOf(companyId, record);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async cancelBooking(companyId, id, reason) {
      try {
        const record = await service.cancel(companyId, id, reason ?? null);
        return viewOf(companyId, record);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async getAssistantSettings(companyId): Promise<AssistantSettingsView> {
      const settings = await storage.getSettings(companyId);
      return {
        calendlyAccessTokenSet: settings.hasCalendlyToken,
        bookingAssistantConditions: settings.bookingAssistantConditions,
      };
    },

    async updateAssistantSettings(companyId, patch: AssistantSettingsUpdate): Promise<AssistantSettingsView> {
      const saved = await storage.saveSettings(companyId, patch);
      return {
        calendlyAccessTokenSet: saved.hasCalendlyToken,
        bookingAssistantConditions: saved.bookingAssistantConditions,
      };
    },
  };
}
