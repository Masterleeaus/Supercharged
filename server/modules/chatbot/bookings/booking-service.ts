/**
 * Booking service: calendars, availability, booking, waitlist, status transitions and reminders.
 * Port of BookingRuntime.php and the appointment model, with the gaps in the PHP closed:
 *   - available() returned busy rows only. This returns free slots from working hours, timezone and buffer.
 *   - book() had no overlap check. This checks inside storage, atomically.
 *   - Status changes were unchecked. They now follow the state machine.
 *
 * Every method takes companyId first and calls requireCompanyId() before anything else. The service is
 * disabled unless the feature flag is on: every method then throws a 503 ChatbotError.
 */
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import { coveredByWindows, generateSlots, workingWindows } from "./availability.ts";
import type { BookingStorage, OverlapGuard } from "./booking-storage.ts";
import { isBookingsEnabled } from "./flags.ts";
import { assertTransition } from "./state-machine.ts";
import {
  validateAppointmentInput,
  validateCalendarInput,
  validateRangeQuery,
  validateReason,
  validateReminderInput,
  type AppointmentInput,
} from "./validation.ts";
import {
  NOOP_EVENT_SINK,
  createBookingEvent,
  type BookingEventName,
  type BookingEventSink,
} from "./webhooks.ts";
import type {
  AppointmentRecord,
  AppointmentStatus,
  CalendarRecord,
  Interval,
  NewCalendar,
  ReminderRecord,
} from "./types.ts";

const MINUTE_MS = 60_000;

export interface AvailabilityResult {
  calendarId: string;
  timezone: string;
  durationMinutes: number;
  from: string;
  to: string;
  /** Free slots, ISO 8601 UTC. */
  slots: Array<{ start: string; end: string }>;
  /** Confirmed bookings in the range, times only. Customer details are never returned. */
  busy: Array<{ start: string; end: string }>;
}

export interface BookingServiceDeps {
  storage: BookingStorage;
  now?: () => Date;
  /** Defaults to the CHATBOT_BOOKINGS_ENABLED flag. Tests pass it explicitly. */
  enabled?: boolean;
  events?: BookingEventSink;
}

export interface BookingService {
  createCalendar(companyId: string, input: unknown): Promise<CalendarRecord>;
  listCalendars(companyId: string): Promise<CalendarRecord[]>;
  getAvailability(companyId: string, calendarId: string, query: unknown): Promise<AvailabilityResult>;
  listAppointments(companyId: string, calendarId: string, query: unknown): Promise<AppointmentRecord[]>;
  book(companyId: string, input: unknown): Promise<AppointmentRecord>;
  waitlist(companyId: string, input: unknown): Promise<AppointmentRecord>;
  /** Moves an appointment to a new status, following the state machine. */
  transition(
    companyId: string,
    appointmentId: string,
    to: AppointmentStatus,
    reason?: unknown,
  ): Promise<AppointmentRecord>;
  cancel(companyId: string, appointmentId: string, reason?: unknown): Promise<AppointmentRecord>;
  /** Promotes a waitlisted appointment to confirmed. Fails with 409 if its slot is now taken. */
  promote(companyId: string, appointmentId: string): Promise<AppointmentRecord>;
  scheduleReminder(companyId: string, appointmentId: string, input: unknown): Promise<ReminderRecord>;
  listReminders(companyId: string, appointmentId: string): Promise<ReminderRecord[]>;
}

function toIso(date: Date): string {
  return date.toISOString();
}

function summarise(record: AppointmentRecord): Record<string, unknown> {
  return {
    appointment_id: record.id,
    calendar_id: record.calendarId,
    status: record.status,
    starts_at: toIso(record.startsAt),
    ends_at: toIso(record.endsAt),
  };
}

export function createBookingService(deps: BookingServiceDeps): BookingService {
  const storage = deps.storage;
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? isBookingsEnabled();
  const events = deps.events ?? NOOP_EVENT_SINK;

  const ensureEnabled = (): void => {
    if (!enabled) throw new ChatbotError("Bookings are not enabled", 503);
  };

  const requireCalendar = async (companyId: string, calendarId: string): Promise<CalendarRecord> => {
    const calendar = await storage.findCalendar(companyId, calendarId);
    if (!calendar) throw new ChatbotError("Calendar not found", 404);
    return calendar;
  };

  const requireAppointment = async (companyId: string, appointmentId: string): Promise<AppointmentRecord> => {
    const appointment = await storage.findAppointment(companyId, appointmentId);
    if (!appointment) throw new ChatbotError("Appointment not found", 404);
    return appointment;
  };

  const emit = async (companyId: string, name: BookingEventName, payload: Record<string, unknown>) => {
    await events.emit(companyId, createBookingEvent(name, payload, now()));
  };

  /** Shared path for book() and waitlist(). Validates, checks working hours, then writes. */
  const createAppointment = async (
    scope: string,
    input: unknown,
    status: "confirmed" | "waitlisted",
  ): Promise<AppointmentRecord> => {
    const now0 = now();
    const value: AppointmentInput = validateAppointmentInput(input, now0);
    const calendar = await requireCalendar(scope, value.calendarId);

    const windows = workingWindows(calendar, value.startsAt, value.endsAt);
    if (!coveredByWindows(windows, value.startsAt, value.endsAt)) {
      throw new ChatbotError("Requested time is outside working hours", 422);
    }

    const guard: OverlapGuard | null =
      status === "confirmed"
        ? {
            calendarId: calendar.id,
            startsAt: value.startsAt,
            endsAt: value.endsAt,
            bufferMs: calendar.bufferMinutes * MINUTE_MS,
          }
        : null;

    const result = await storage.insertAppointment(
      scope,
      {
        calendarId: calendar.id,
        conversationId: value.conversationId,
        customerName: value.customerName,
        customerEmail: value.customerEmail,
        customerPhone: value.customerPhone,
        startsAt: value.startsAt,
        endsAt: value.endsAt,
        status,
        metadata: value.metadata,
      },
      guard,
      now0,
    );
    if (!result.ok) {
      if (result.reason === "calendar_not_found") throw new ChatbotError("Calendar not found", 404);
      throw new ChatbotError("That time is no longer available", 409);
    }
    return result.record;
  };

  const service: BookingService = {
    async createCalendar(companyId, input) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const value: NewCalendar = validateCalendarInput(input);
      return storage.insertCalendar(scope, value, now());
    },

    async listCalendars(companyId) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      return storage.listCalendars(scope);
    },

    async getAvailability(companyId, calendarId, query) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const range = validateRangeQuery(query);
      const calendar = await requireCalendar(scope, calendarId);
      const current = now();
      const durationMs = range.durationMinutes * MINUTE_MS;
      const bufferMs = calendar.bufferMinutes * MINUTE_MS;

      // The slot grid is anchored to the working-hours start, not to the query start or to now. Slots are
      // generated on that grid and then filtered to the requested range, so an unaligned query never shifts
      // the times that are offered.
      const windows = workingWindows(calendar, range.from, range.to);

      const booked = (
        await storage.listAppointments(scope, calendar.id, {
          from: new Date(range.from.getTime() - bufferMs),
          to: new Date(range.to.getTime() + bufferMs),
        })
      ).filter((a) => a.status === "confirmed");
      const busy: Interval[] = booked.map((a) => ({ start: a.startsAt, end: a.endsAt }));

      const slots = generateSlots(windows, busy, durationMs, bufferMs, current).filter(
        (s) => s.start.getTime() >= range.from.getTime() && s.end.getTime() <= range.to.getTime(),
      );
      return {
        calendarId: calendar.id,
        timezone: calendar.timezone,
        durationMinutes: range.durationMinutes,
        from: toIso(range.from),
        to: toIso(range.to),
        slots: slots.map((s) => ({ start: toIso(s.start), end: toIso(s.end) })),
        busy: busy.map((b) => ({ start: toIso(b.start), end: toIso(b.end) })),
      };
    },

    async listAppointments(companyId, calendarId, query) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const range = validateRangeQuery(query);
      await requireCalendar(scope, calendarId);
      return storage.listAppointments(scope, calendarId, { from: range.from, to: range.to });
    },

    async book(companyId, input) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const record = await createAppointment(scope, input, "confirmed");
      await emit(scope, "appointment.booked", summarise(record));
      return record;
    },

    async waitlist(companyId, input) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const record = await createAppointment(scope, input, "waitlisted");
      await emit(scope, "appointment.waitlisted", summarise(record));
      return record;
    },

    async transition(companyId, appointmentId, to, reason) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const statusReason = validateReason(reason);
      const current = await requireAppointment(scope, appointmentId);
      assertTransition(current.status, to);

      let guard: OverlapGuard | null = null;
      if (to === "confirmed") {
        const calendar = await requireCalendar(scope, current.calendarId);
        guard = {
          calendarId: calendar.id,
          startsAt: current.startsAt,
          endsAt: current.endsAt,
          bufferMs: calendar.bufferMinutes * MINUTE_MS,
        };
      }

      const result = await storage.transitionAppointment(
        scope,
        appointmentId,
        { from: current.status, to, reason: statusReason, guard },
        now(),
      );
      if (!result.ok) {
        if (result.reason === "not_found") throw new ChatbotError("Appointment not found", 404);
        if (result.reason === "overlap") throw new ChatbotError("That time is no longer available", 409);
        throw new ChatbotError("Appointment status changed, reload and try again", 409);
      }
      await emit(scope, "appointment.status_changed", {
        ...summarise(result.record),
        previous_status: current.status,
      });
      return result.record;
    },

    async cancel(companyId, appointmentId, reason) {
      return service.transition(companyId, appointmentId, "cancelled", reason);
    },

    async promote(companyId, appointmentId) {
      return service.transition(companyId, appointmentId, "confirmed");
    },

    async scheduleReminder(companyId, appointmentId, input) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      const current = now();
      const value = validateReminderInput(input, appointmentId);
      const appointment = await requireAppointment(scope, appointmentId);
      if (appointment.status === "cancelled") {
        throw new ChatbotError("Cannot schedule a reminder for a cancelled appointment", 409);
      }
      if (value.sendAt.getTime() <= current.getTime()) {
        throw new ChatbotError("Validation failed: send_at must be in the future", 422);
      }
      if (value.sendAt.getTime() >= appointment.startsAt.getTime()) {
        throw new ChatbotError("Validation failed: send_at must be before the appointment starts", 422);
      }
      const record = await storage.insertReminder(scope, value, current);
      if (!record) throw new ChatbotError("Appointment not found", 404);
      await emit(scope, "reminder.scheduled", {
        appointment_id: appointmentId,
        reminder_id: record.id,
        channel: record.channel,
        send_at: toIso(record.sendAt),
      });
      return record;
    },

    async listReminders(companyId, appointmentId) {
      const scope = requireCompanyId(companyId);
      ensureEnabled();
      await requireAppointment(scope, appointmentId);
      return storage.listReminders(scope, appointmentId);
    },
  };

  return service;
}
