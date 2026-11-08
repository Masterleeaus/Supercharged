/**
 * Storage contract for the chatbot bookings slice.
 *
 * Every method takes companyId as its first argument, runs requireCompanyId() on it, and reads or
 * writes only rows that carry it. Overlap checks and status changes are compare-and-set operations
 * inside the storage, so two concurrent bookings for one slot cannot both succeed. The PHP book()
 * did a plain insert with no check at all.
 *
 * createMemoryBookingStorage() is for tests and local runs. The Drizzle implementation of this same interface is
 * createDrizzleBookingStorage() in drizzle-booking-storage.ts, over the tables in ../db/bookings.ts.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import { intervalsConflict } from "./availability.ts";
import type {
  AppointmentRecord,
  AppointmentStatus,
  CalendarRecord,
  NewAppointment,
  NewCalendar,
  NewReminder,
  ReminderRecord,
} from "./types.ts";

/** Guard for a confirmed-slot check. The calendar must match, and the buffer applies to the new interval. */
export interface OverlapGuard {
  calendarId: string;
  startsAt: Date;
  endsAt: Date;
  bufferMs: number;
}

export type InsertAppointmentResult =
  | { ok: true; record: AppointmentRecord }
  | { ok: false; reason: "calendar_not_found" | "overlap" };

export type TransitionResult =
  | { ok: true; record: AppointmentRecord }
  | { ok: false; reason: "not_found" | "stale_status" | "overlap" };

export interface TransitionChange {
  from: AppointmentStatus;
  to: AppointmentStatus;
  reason: string | null;
  /** Set when moving into confirmed. Null for cancellations and waitlist moves. */
  guard: OverlapGuard | null;
}

export interface BookingStorage {
  insertCalendar(companyId: string, input: NewCalendar, now: Date): Promise<CalendarRecord>;
  findCalendar(companyId: string, id: string): Promise<CalendarRecord | null>;
  listCalendars(companyId: string): Promise<CalendarRecord[]>;

  /**
   * Inserts an appointment. When guard is set, the insert only happens if no confirmed appointment on the
   * same calendar conflicts with it. The check and the insert run as one step.
   */
  insertAppointment(
    companyId: string,
    input: NewAppointment,
    guard: OverlapGuard | null,
    now: Date,
  ): Promise<InsertAppointmentResult>;
  findAppointment(companyId: string, id: string): Promise<AppointmentRecord | null>;
  /** Appointments of any status whose time range overlaps [from, to). */
  listAppointments(
    companyId: string,
    calendarId: string,
    range: { from: Date; to: Date },
  ): Promise<AppointmentRecord[]>;
  transitionAppointment(
    companyId: string,
    id: string,
    change: TransitionChange,
    now: Date,
  ): Promise<TransitionResult>;

  /** Returns null when the appointment does not belong to companyId. */
  insertReminder(companyId: string, input: NewReminder, now: Date): Promise<ReminderRecord | null>;
  listReminders(companyId: string, appointmentId: string): Promise<ReminderRecord[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-memory implementation. Each method body is synchronous after its first await point (there is none),
 * so the check-and-write in insertAppointment and transitionAppointment is atomic on the JS event loop.
 */
export function createMemoryBookingStorage(): BookingStorage {
  // Outer key is companyId. Every lookup starts there.
  const calendars = new Map<string, Map<string, CalendarRecord>>();
  const appointments = new Map<string, Map<string, AppointmentRecord>>();
  const reminders = new Map<string, Map<string, ReminderRecord>>();

  const bucket = <T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> => {
    let rows = store.get(companyId);
    if (!rows) {
      rows = new Map<string, T>();
      store.set(companyId, rows);
    }
    return rows;
  };
  const readBucket = <T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> =>
    store.get(companyId) ?? new Map<string, T>();

  const conflictsWithConfirmed = (
    companyId: string,
    guard: OverlapGuard,
    excludeId: string | null,
  ): boolean =>
    [...readBucket(appointments, companyId).values()].some(
      (a) =>
        a.id !== excludeId &&
        a.calendarId === guard.calendarId &&
        a.status === "confirmed" &&
        intervalsConflict(a.startsAt, a.endsAt, guard.startsAt, guard.endsAt, guard.bufferMs),
    );

  return {
    async insertCalendar(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      const record: CalendarRecord = {
        id: randomUUID(),
        companyId: scope,
        name: input.name,
        timezone: input.timezone,
        availability: input.availability,
        bufferMinutes: input.bufferMinutes,
        createdAt: now,
        updatedAt: now,
      };
      bucket(calendars, scope).set(record.id, record);
      return copy(record);
    },

    async findCalendar(companyId, id) {
      const row = readBucket(calendars, requireCompanyId(companyId)).get(id);
      return row ? copy(row) : null;
    },

    async listCalendars(companyId) {
      return [...readBucket(calendars, requireCompanyId(companyId)).values()].map(copy);
    },

    async insertAppointment(companyId, input, guard, now) {
      const scope = requireCompanyId(companyId);
      if (!readBucket(calendars, scope).has(input.calendarId)) {
        return { ok: false, reason: "calendar_not_found" };
      }
      if (guard && conflictsWithConfirmed(scope, guard, null)) {
        return { ok: false, reason: "overlap" };
      }
      const record: AppointmentRecord = {
        id: randomUUID(),
        companyId: scope,
        calendarId: input.calendarId,
        conversationId: input.conversationId,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status,
        statusReason: null,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      };
      bucket(appointments, scope).set(record.id, record);
      return { ok: true, record: copy(record) };
    },

    async findAppointment(companyId, id) {
      const row = readBucket(appointments, requireCompanyId(companyId)).get(id);
      return row ? copy(row) : null;
    },

    async listAppointments(companyId, calendarId, range) {
      return [...readBucket(appointments, requireCompanyId(companyId)).values()]
        .filter(
          (a) =>
            a.calendarId === calendarId &&
            a.startsAt.getTime() < range.to.getTime() &&
            a.endsAt.getTime() > range.from.getTime(),
        )
        .map(copy);
    },

    async transitionAppointment(companyId, id, change, now) {
      const scope = requireCompanyId(companyId);
      const row = readBucket(appointments, scope).get(id);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.status !== change.from) return { ok: false, reason: "stale_status" };
      if (change.to === "confirmed" && change.guard && conflictsWithConfirmed(scope, change.guard, id)) {
        return { ok: false, reason: "overlap" };
      }
      row.status = change.to;
      row.statusReason = change.reason;
      row.updatedAt = now;
      return { ok: true, record: copy(row) };
    },

    async insertReminder(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      if (!readBucket(appointments, scope).has(input.appointmentId)) return null;
      const record: ReminderRecord = {
        id: randomUUID(),
        companyId: scope,
        appointmentId: input.appointmentId,
        channel: input.channel,
        sendAt: input.sendAt,
        status: "queued",
        createdAt: now,
      };
      bucket(reminders, scope).set(record.id, record);
      return copy(record);
    },

    async listReminders(companyId, appointmentId) {
      return [...readBucket(reminders, requireCompanyId(companyId)).values()]
        .filter((r) => r.appointmentId === appointmentId)
        .map(copy);
    },
  };
}
