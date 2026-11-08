/**
 * Drizzle implementation of the bookings storage contract (BookingStorage in booking-storage.ts), plus the settings
 * store and calendar numbering that the HTTP adapter needs.
 *
 * Rules that hold for every method:
 *  - The company id is the first argument and goes through requireCompanyId() before anything else (403 if bad).
 *  - Every query carries company_id. The query builders below are exported so the tests can render them to SQL.
 *  - Double booking: a booking is checked and written inside one transaction, after the calendar row is locked
 *    (SELECT ... FOR UPDATE). The EXCLUDE constraint in the migration is the last line of defence (see db/bookings.ts).
 *  - The Calendly token is encrypted before it reaches a query (bookings/secret-box.ts). A missing key throws
 *    before any query is built. The token is stored as one versioned string in the ciphertext column; older rows
 *    with the three-column layout still read.
 *
 * Not wired to a database. Nothing in this file runs a migration. The tests render SQL only.
 */
import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  chatbotAppointments as appointments,
  chatbotBookingCalendars as calendars,
  chatbotBookingReminders as reminders,
  chatbotBookingSettings as settings,
} from "../db/bookings.ts";
import type {
  AppointmentRecord,
  AppointmentStatus,
  CalendarRecord,
  NewAppointment,
  NewCalendar,
  NewReminder,
  ReminderRecord,
  WeeklyAvailability,
} from "./types.ts";
import type {
  BookingStorage,
  InsertAppointmentResult,
  TransitionChange,
  TransitionResult,
} from "./booking-storage.ts";
import {
  createSecretBox,
  openCalendlyTokenColumns,
  sealCalendlyTokenColumns,
  type SecretBox,
} from "./secret-box.ts";

const MINUTE_MS = 60_000;

export interface BookingSettings {
  hasCalendlyToken: boolean;
  bookingAssistantConditions: string[];
}

export interface BookingSettingsPatch {
  /** A string stores (encrypts) the token. null clears it. Undefined leaves it unchanged. */
  calendlyAccessToken?: string | null;
  bookingAssistantConditions?: string[];
}

/** Company settings. The token itself is only returned by readCalendlyToken, which the HTTP layer never calls. */
export interface BookingSettingsStore {
  getSettings(companyId: string): Promise<BookingSettings>;
  saveSettings(companyId: string, patch: BookingSettingsPatch): Promise<BookingSettings>;
  readCalendlyToken(companyId: string): Promise<string | null>;
}

/** Maps the UUID calendar id to the numeric id the HTTP contract uses, and back. Both are scoped to the company. */
export interface CalendarNumbering {
  calendarNumberOf(companyId: string, calendarId: string): Promise<number | null>;
  calendarIdForNumber(companyId: string, calendarNumber: number): Promise<string | null>;
}

export type DrizzleBookingStorage = BookingStorage & BookingSettingsStore & CalendarNumbering;

type BookingDb = NodePgDatabase<Record<string, unknown>>;
type BookingTx = Parameters<Parameters<BookingDb["transaction"]>[0]>[0];
type Executor = BookingDb | BookingTx;

export interface DrizzleBookingStorageOptions {
  db: BookingDb;
  /** Defaults to a box that reads CHATBOT_SECRET_KEY from process.env on first use. Tests pass their own. */
  secretBox?: SecretBox;
  now?: () => Date;
}

export interface CalendarInsertInput extends NewCalendar {}

/**
 * Sealed token columns, or null for "clear the token". Undefined means "leave the token unchanged".
 * The current form sets the iv and tag columns to null and puts the versioned string in the ciphertext column.
 */
interface TokenColumns {
  calendlyTokenIv: string | null;
  calendlyTokenTag: string | null;
  calendlyTokenCiphertext: string | null;
}

/**
 * Query builders. Each one takes an executor (the db or a transaction) and returns an unexecuted Drizzle query.
 * The storage runs them; the tests render them.
 */
export const bookingQueries = {
  calendarById(db: Executor, companyId: string, id: string) {
    return db
      .select()
      .from(calendars)
      .where(and(eq(calendars.companyId, companyId), eq(calendars.id, id)))
      .limit(1);
  },

  calendars(db: Executor, companyId: string) {
    return db.select().from(calendars).where(eq(calendars.companyId, companyId));
  },

  calendarNumberById(db: Executor, companyId: string, id: string) {
    return db
      .select({ calendarNumber: calendars.calendarNumber })
      .from(calendars)
      .where(and(eq(calendars.companyId, companyId), eq(calendars.id, id)))
      .limit(1);
  },

  calendarIdByNumber(db: Executor, companyId: string, calendarNumber: number) {
    return db
      .select({ id: calendars.id })
      .from(calendars)
      .where(and(eq(calendars.companyId, companyId), eq(calendars.calendarNumber, calendarNumber)))
      .limit(1);
  },

  /** Row lock on the calendar. Run it first, inside a transaction, before any overlap check on that calendar. */
  lockCalendar(db: Executor, companyId: string, id: string) {
    return db
      .select({ id: calendars.id, bufferMinutes: calendars.bufferMinutes })
      .from(calendars)
      .where(and(eq(calendars.companyId, companyId), eq(calendars.id, id)))
      .limit(1)
      .for("update");
  },

  insertCalendar(db: Executor, companyId: string, input: CalendarInsertInput, now: Date) {
    return db
      .insert(calendars)
      .values({
        companyId,
        name: input.name,
        timezone: input.timezone,
        availability: input.availability as Record<string, { enabled: boolean; start: string; end: string }> | null,
        bufferMinutes: input.bufferMinutes,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  },

  /**
   * Confirmed appointments on one calendar that conflict with [startsAt, endsAt), with the buffer applied on both
   * sides. Same rule as intervalsConflict(): existing.start < new.end + buffer AND new.start < existing.end + buffer.
   */
  conflicts(
    db: Executor,
    companyId: string,
    calendarId: string,
    startsAt: Date,
    endsAt: Date,
    bufferMs: number,
    excludeId: string | null,
  ) {
    return db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.companyId, companyId),
          eq(appointments.calendarId, calendarId),
          eq(appointments.status, "confirmed"),
          lt(appointments.startsAt, new Date(endsAt.getTime() + bufferMs)),
          gt(appointments.endsAt, new Date(startsAt.getTime() - bufferMs)),
          excludeId === null ? undefined : ne(appointments.id, excludeId),
        ),
      )
      .limit(1);
  },

  /** Any status, overlapping [from, to). Matches the in-memory listAppointments. */
  listAppointmentsInRange(db: Executor, companyId: string, calendarId: string, range: { from: Date; to: Date }) {
    return db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.companyId, companyId),
          eq(appointments.calendarId, calendarId),
          lt(appointments.startsAt, range.to),
          gt(appointments.endsAt, range.from),
        ),
      );
  },

  appointmentById(db: Executor, companyId: string, id: string) {
    return db
      .select()
      .from(appointments)
      .where(and(eq(appointments.companyId, companyId), eq(appointments.id, id)))
      .limit(1);
  },

  insertAppointment(db: Executor, companyId: string, input: NewAppointment, bufferMs: number, now: Date) {
    const blockedEnd = new Date(input.endsAt.getTime() + bufferMs);
    return db
      .insert(appointments)
      .values({
        companyId,
        calendarId: input.calendarId,
        conversationId: input.conversationId,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        // ISO strings, not Date objects: raw SQL params bypass drizzle's column mapping, and pg would serialise a Date in local time.
        blockedRange: sql`tstzrange(${input.startsAt.toISOString()}, ${blockedEnd.toISOString()}, '[)')`,
        status: input.status,
        statusReason: null,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  },

  /** Compare-and-set on the current status, so a stale write matches no row. */
  updateAppointmentStatus(
    db: Executor,
    companyId: string,
    id: string,
    change: { from: AppointmentStatus; to: AppointmentStatus; reason: string | null },
    now: Date,
  ) {
    return db
      .update(appointments)
      .set({ status: change.to, statusReason: change.reason, updatedAt: now })
      .where(
        and(
          eq(appointments.companyId, companyId),
          eq(appointments.id, id),
          eq(appointments.status, change.from),
        ),
      )
      .returning();
  },

  insertReminder(db: Executor, companyId: string, input: NewReminder, now: Date) {
    return db
      .insert(reminders)
      .values({
        companyId,
        appointmentId: input.appointmentId,
        channel: input.channel,
        sendAt: input.sendAt,
        status: "queued",
        createdAt: now,
      })
      .returning();
  },

  remindersFor(db: Executor, companyId: string, appointmentId: string) {
    return db
      .select()
      .from(reminders)
      .where(and(eq(reminders.companyId, companyId), eq(reminders.appointmentId, appointmentId)));
  },

  settingsRow(db: Executor, companyId: string) {
    return db.select().from(settings).where(eq(settings.companyId, companyId)).limit(1);
  },

  /** One row per company. Only the columns that were given are written on conflict. */
  upsertSettings(
    db: Executor,
    companyId: string,
    change: { token?: TokenColumns; conditions?: string[] },
    now: Date,
  ) {
    const token: TokenColumns = change.token ?? {
      calendlyTokenIv: null,
      calendlyTokenTag: null,
      calendlyTokenCiphertext: null,
    };
    const set: Record<string, unknown> = { updatedAt: now };
    if (change.token !== undefined) Object.assign(set, token);
    if (change.conditions !== undefined) set.bookingAssistantConditions = change.conditions;
    return db
      .insert(settings)
      .values({
        companyId,
        ...token,
        bookingAssistantConditions: change.conditions ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: settings.companyId, set })
      .returning();
  },
};

function toCalendar(row: typeof calendars.$inferSelect): CalendarRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    timezone: row.timezone,
    availability: (row.availability as WeeklyAvailability | null) ?? null,
    bufferMinutes: row.bufferMinutes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAppointment(row: typeof appointments.$inferSelect): AppointmentRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    calendarId: row.calendarId,
    conversationId: row.conversationId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as AppointmentStatus,
    statusReason: row.statusReason,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReminder(row: typeof reminders.$inferSelect): ReminderRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    appointmentId: row.appointmentId,
    channel: row.channel as ReminderRecord["channel"],
    sendAt: row.sendAt,
    status: row.status as ReminderRecord["status"],
    createdAt: row.createdAt,
  };
}

function toSettings(row: typeof settings.$inferSelect | undefined): BookingSettings {
  return {
    hasCalendlyToken: Boolean(row && row.calendlyTokenCiphertext !== null),
    bookingAssistantConditions: row?.bookingAssistantConditions ?? [],
  };
}

/** Postgres SQLSTATEs for exclusion (23P01) and unique (23505) violations, from the overlap guards. */
function isOverlapViolation(err: unknown): boolean {
  const direct = (err as { code?: unknown } | null)?.code;
  const nested = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return direct === "23P01" || direct === "23505" || nested === "23P01" || nested === "23505";
}

export function createDrizzleBookingStorage(options: DrizzleBookingStorageOptions): DrizzleBookingStorage {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  // Reads the key only when a token method needs it, so construction never throws. The default box is cached.
  let defaultBox: SecretBox | undefined;
  const secretBox = (): SecretBox => {
    if (options.secretBox) return options.secretBox;
    defaultBox ??= createSecretBox();
    return defaultBox;
  };

  const hasConflict = async (
    exec: Executor,
    scope: string,
    calendarId: string,
    startsAt: Date,
    endsAt: Date,
    bufferMs: number,
    excludeId: string | null,
  ): Promise<boolean> => {
    const rows = await bookingQueries.conflicts(exec, scope, calendarId, startsAt, endsAt, bufferMs, excludeId);
    return rows.length > 0;
  };

  return {
    async insertCalendar(companyId, input, at) {
      const scope = requireCompanyId(companyId);
      const rows = await bookingQueries.insertCalendar(db, scope, input, at);
      return toCalendar(rows[0]!);
    },

    async findCalendar(companyId, id) {
      const rows = await bookingQueries.calendarById(db, requireCompanyId(companyId), id);
      return rows[0] ? toCalendar(rows[0]) : null;
    },

    async listCalendars(companyId) {
      const rows = await bookingQueries.calendars(db, requireCompanyId(companyId));
      return rows.map(toCalendar);
    },

    async insertAppointment(companyId, input, guard, at): Promise<InsertAppointmentResult> {
      const scope = requireCompanyId(companyId);
      try {
        return await db.transaction(async (tx): Promise<InsertAppointmentResult> => {
          const calendar = (await bookingQueries.lockCalendar(tx, scope, input.calendarId))[0];
          if (!calendar) return { ok: false, reason: "calendar_not_found" };
          const bufferMs = calendar.bufferMinutes * MINUTE_MS;
          if (guard && (await hasConflict(tx, scope, input.calendarId, guard.startsAt, guard.endsAt, bufferMs, null))) {
            return { ok: false, reason: "overlap" };
          }
          const rows = await bookingQueries.insertAppointment(tx, scope, input, bufferMs, at);
          return { ok: true, record: toAppointment(rows[0]!) };
        });
      } catch (err) {
        if (isOverlapViolation(err)) return { ok: false, reason: "overlap" };
        throw err;
      }
    },

    async findAppointment(companyId, id) {
      const rows = await bookingQueries.appointmentById(db, requireCompanyId(companyId), id);
      return rows[0] ? toAppointment(rows[0]) : null;
    },

    async listAppointments(companyId, calendarId, range) {
      const rows = await bookingQueries.listAppointmentsInRange(db, requireCompanyId(companyId), calendarId, range);
      return rows.map(toAppointment);
    },

    async transitionAppointment(companyId, id, change: TransitionChange, at): Promise<TransitionResult> {
      const scope = requireCompanyId(companyId);
      try {
        return await db.transaction(async (tx): Promise<TransitionResult> => {
          const first = (await bookingQueries.appointmentById(tx, scope, id))[0];
          if (!first) return { ok: false, reason: "not_found" };
          // Lock the calendar, then read the row again. Two confirmations on one calendar run one at a time.
          const calendar = (await bookingQueries.lockCalendar(tx, scope, first.calendarId))[0];
          const current = (await bookingQueries.appointmentById(tx, scope, id))[0];
          if (!current) return { ok: false, reason: "not_found" };
          if (current.status !== change.from) return { ok: false, reason: "stale_status" };
          if (change.to === "confirmed" && change.guard && calendar) {
            const bufferMs = calendar.bufferMinutes * MINUTE_MS;
            if (await hasConflict(tx, scope, current.calendarId, current.startsAt, current.endsAt, bufferMs, id)) {
              return { ok: false, reason: "overlap" };
            }
          }
          const rows = await bookingQueries.updateAppointmentStatus(tx, scope, id, change, at);
          if (rows.length === 0) return { ok: false, reason: "stale_status" };
          return { ok: true, record: toAppointment(rows[0]!) };
        });
      } catch (err) {
        if (isOverlapViolation(err)) return { ok: false, reason: "overlap" };
        throw err;
      }
    },

    async insertReminder(companyId, input, at) {
      const scope = requireCompanyId(companyId);
      const parent = (await bookingQueries.appointmentById(db, scope, input.appointmentId))[0];
      if (!parent) return null;
      const rows = await bookingQueries.insertReminder(db, scope, input, at);
      return toReminder(rows[0]!);
    },

    async listReminders(companyId, appointmentId) {
      const rows = await bookingQueries.remindersFor(db, requireCompanyId(companyId), appointmentId);
      return rows.map(toReminder);
    },

    async getSettings(companyId) {
      const rows = await bookingQueries.settingsRow(db, requireCompanyId(companyId));
      return toSettings(rows[0]);
    },

    async saveSettings(companyId, patch) {
      const scope = requireCompanyId(companyId);
      // Encrypt before any query is built. A missing key throws here and nothing is written.
      let token: TokenColumns | undefined;
      if (patch.calendlyAccessToken === null) {
        token = { calendlyTokenIv: null, calendlyTokenTag: null, calendlyTokenCiphertext: null };
      } else if (typeof patch.calendlyAccessToken === "string") {
        token = sealCalendlyTokenColumns(secretBox(), patch.calendlyAccessToken);
      }
      const rows = await bookingQueries.upsertSettings(
        db,
        scope,
        { token, conditions: patch.bookingAssistantConditions },
        now(),
      );
      return toSettings(rows[0]);
    },

    async readCalendlyToken(companyId) {
      const row = (await bookingQueries.settingsRow(db, requireCompanyId(companyId)))[0];
      // No token stored: return before the key is needed, as before.
      if (!row || row.calendlyTokenCiphertext === null) return null;
      return openCalendlyTokenColumns(secretBox(), row);
    },

    async calendarNumberOf(companyId, calendarId) {
      const rows = await bookingQueries.calendarNumberById(db, requireCompanyId(companyId), calendarId);
      return rows[0]?.calendarNumber ?? null;
    },

    async calendarIdForNumber(companyId, calendarNumber) {
      const rows = await bookingQueries.calendarIdByNumber(db, requireCompanyId(companyId), calendarNumber);
      return rows[0]?.id ?? null;
    },
  };
}
