/*
 * Drizzle tables for the chatbot bookings slice.
 *
 * Not added to shared/schema.ts, and no migration has been applied or written. The integration step decides where
 * these are merged. Parent tables (chatbots, chatbot_conversations) are imported from shared/schema.ts.
 *
 * Every table carries company_id. Child tables use composite foreign keys on (company_id, id), so a row cannot point
 * at another company's calendar, appointment or conversation.
 *
 * Double booking is stopped in two layers:
 *  1. Drizzle (this file): a partial unique index. Two confirmed bookings with the same start on one calendar cannot
 *     both be stored.
 *  2. Migration SQL only. Drizzle 0.45 cannot express EXCLUDE, so the full overlap guard is written by hand:
 *
 *       CREATE EXTENSION IF NOT EXISTS btree_gist;
 *       ALTER TABLE chatbot_appointments ADD CONSTRAINT chatbot_appointments_no_overlap
 *         EXCLUDE USING gist (company_id WITH =, calendar_id WITH =, blocked_range WITH &&)
 *         WHERE (status = 'confirmed');
 *
 *     blocked_range = tstzrange(starts_at, ends_at + buffer_minutes minutes, '[)'). The storage writes it on every
 *     insert. Two ranges overlap exactly when intervalsConflict() in bookings/availability.ts says they conflict.
 *     The storage also locks the calendar row (SELECT ... FOR UPDATE) before its own overlap check, so the app check
 *     and the constraint agree. If the constraint fires anyway, the storage maps SQLSTATE 23P01 to "overlap".
 *
 * Calendar buffer is fixed once a calendar exists (the bookings service has no calendar update). If that changes,
 * blocked_range must be rewritten for the calendar's appointments.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { chatbotConversations } from "../../../../shared/schema.ts";

/** PostgreSQL tstzrange. Written by the storage through raw SQL, so the TypeScript side only needs a string type. */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tstzrange";
  },
});

export const chatbotBookingCalendars = pgTable(
  "chatbot_booking_calendars",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    // Numeric id for the HTTP layer, which uses numbers in booking-routes/contract.ts. The UUID stays the key.
    calendarNumber: serial("calendar_number").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    // Same weekly shape as bookings/types.ts WeeklyAvailability. Null means no bookable hours (fail closed).
    availability: jsonb("availability").$type<Record<string, { enabled: boolean; start: string; end: string }>>(),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_booking_calendars_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("chatbot_booking_calendars_company_number_uidx").on(table.companyId, table.calendarNumber),
    check("chatbot_booking_calendars_buffer_chk", sql`${table.bufferMinutes} >= 0 AND ${table.bufferMinutes} <= 240`),
  ],
);

export const chatbotAppointments = pgTable(
  "chatbot_appointments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    calendarId: varchar("calendar_id").notNull(),
    conversationId: varchar("conversation_id"),
    customerName: varchar("customer_name", { length: 255 }).notNull(),
    customerEmail: varchar("customer_email", { length: 254 }),
    customerPhone: varchar("customer_phone", { length: 16 }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // Read by the EXCLUDE constraint in the migration (see the header). Written on every insert.
    blockedRange: tstzrange("blocked_range"),
    status: varchar("status", { length: 16 }).notNull().default("confirmed"), // confirmed | waitlisted | cancelled
    statusReason: varchar("status_reason", { length: 500 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_appointments_company_id_uidx").on(table.companyId, table.id),
    // Layer 1 of the double-booking guard. Same start, same calendar, both confirmed: rejected.
    uniqueIndex("chatbot_appointments_confirmed_start_uidx")
      .on(table.companyId, table.calendarId, table.startsAt)
      .where(sql`${table.status} = 'confirmed'`),
    foreignKey({
      name: "chatbot_appointments_company_calendar_fk",
      columns: [table.companyId, table.calendarId],
      foreignColumns: [chatbotBookingCalendars.companyId, chatbotBookingCalendars.id],
    }),
    // Nullable column: MATCH SIMPLE skips this foreign key when conversation_id is null.
    foreignKey({
      name: "chatbot_appointments_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    check("chatbot_appointments_status_chk", sql`${table.status} IN ('confirmed', 'waitlisted', 'cancelled')`),
    check("chatbot_appointments_range_chk", sql`${table.endsAt} > ${table.startsAt}`),
    index("chatbot_appointments_company_calendar_time_idx").on(table.companyId, table.calendarId, table.startsAt),
  ],
);

export const chatbotBookingReminders = pgTable(
  "chatbot_booking_reminders",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    appointmentId: varchar("appointment_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(), // email | sms | whatsapp | telegram | web
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("queued"), // queued | sent | failed | cancelled
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chatbot_booking_reminders_company_appointment_fk",
      columns: [table.companyId, table.appointmentId],
      foreignColumns: [chatbotAppointments.companyId, chatbotAppointments.id],
    }),
    index("chatbot_booking_reminders_due_idx").on(table.companyId, table.status, table.sendAt),
  ],
);

/**
 * One row per company. The Calendly access token is never stored in plaintext. Two layouts are allowed: the legacy
 * three-column form (iv, auth tag and ciphertext all set, each base64) and the current versioned form (iv and tag null,
 * ciphertext holds "<keyVersion>:<iv>:<tag>:<ciphertext>"). All three are null when no token is stored. The CHECK below
 * keeps iv and tag paired and requires a ciphertext whenever iv is set.
 */
export const chatbotBookingSettings = pgTable(
  "chatbot_booking_settings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    calendlyTokenIv: varchar("calendly_token_iv", { length: 32 }),
    calendlyTokenTag: varchar("calendly_token_tag", { length: 32 }),
    calendlyTokenCiphertext: text("calendly_token_ciphertext"),
    bookingAssistantConditions: jsonb("booking_assistant_conditions").$type<string[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_booking_settings_company_uidx").on(table.companyId),
    check(
      "chatbot_booking_settings_token_chk",
      sql`((${table.calendlyTokenIv} IS NULL) = (${table.calendlyTokenTag} IS NULL))
        AND (${table.calendlyTokenCiphertext} IS NOT NULL OR ${table.calendlyTokenIv} IS NULL)`,
    ),
  ],
);

/*
 * Booking-assistant columns for the chatbots table. They belong on chatbots in shared/schema.ts, which the
 * integration step owns. Spread these into that table definition when merging. They mirror
 * 2026_03_04_110258_add_booking_assistant_conditions_to_ext_chatbots.php.
 */
export const bookingAssistantChatbotColumns = {
  isBookingAssistant: boolean("is_booking_assistant").notNull().default(false),
  bookingAssistantConditions: jsonb("booking_assistant_conditions").$type<string[]>(),
  bookingAssistantIframe: text("booking_assistant_iframe"),
};

export type ChatbotCalendarRow = typeof chatbotBookingCalendars.$inferSelect;
export type ChatbotAppointmentRow = typeof chatbotAppointments.$inferSelect;
export type ChatbotBookingReminderRow = typeof chatbotBookingReminders.$inferSelect;
export type ChatbotBookingSettingsRow = typeof chatbotBookingSettings.$inferSelect;
