/*
 * DRAFT - not wired into shared/schema.ts and not applied to any database. No migration has been run or written.
 * The integration agent merges this fragment. Review it with ../schema.DRAFT.ts (the chatbot fragment) first.
 *
 * Every table carries company_id, and child tables use composite foreign keys on (company_id, id), in the same
 * style as the chatbot fragment. A booking cannot point at another company's calendar or conversation.
 *
 * Double booking is prevented in the database as well as in storage. Once the migration is written, add this
 * exclusion constraint by hand (it needs the btree_gist extension, which the migration must create):
 *
 *   ALTER TABLE chatbot_appointments ADD CONSTRAINT chatbot_appointments_no_overlap
 *     EXCLUDE USING gist (company_id WITH =, calendar_id WITH =, blocked_range WITH &&)
 *     WHERE (status = 'confirmed');
 *
 * blocked_range = tstzrange(starts_at, ends_at + buffer_minutes * interval '1 minute'), written on insert. This
 * matches intervalsConflict() in availability.ts, which requires a gap of at least the calendar buffer.
 * Drizzle cannot express the EXCLUDE constraint, so it stays in the migration SQL.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { chatbotConversations } from "../schema.DRAFT.ts";

export const chatbotBookingCalendars = pgTable(
  "chatbot_booking_calendars",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    // Same shape as appointment_settings.working_hours in shared/schema.ts. Null means no bookable hours.
    availability: jsonb("availability").$type<Record<string, { enabled: boolean; start: string; end: string }>>(),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_booking_calendars_company_id_uidx").on(table.companyId, table.id),
    check("chatbot_booking_calendars_buffer_chk", sql`${table.bufferMinutes} >= 0 AND ${table.bufferMinutes} <= 240`),
  ]
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
    // Range including the buffer after the appointment. Written on insert and read by the exclusion constraint.
    blockedRange: text("blocked_range"),
    status: varchar("status", { length: 16 }).notNull().default("confirmed"), // confirmed | waitlisted | cancelled
    statusReason: varchar("status_reason", { length: 500 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_appointments_company_id_uidx").on(table.companyId, table.id),
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
  ]
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
  ]
);

/*
 * Booking-assistant columns for the chatbots table. They belong on chatbots in ../schema.DRAFT.ts, which the
 * chatbot slice owns. Spread these into that table definition when the fragments are merged. They mirror
 * 2026_03_04_110258_add_booking_assistant_conditions_to_ext_chatbots.php.
 */
export const bookingAssistantChatbotColumns = {
  isBookingAssistant: boolean("is_booking_assistant").notNull().default(false),
  bookingAssistantConditions: jsonb("booking_assistant_conditions").$type<string[]>(),
  bookingAssistantIframe: text("booking_assistant_iframe"),
};

export type ChatbotCalendarRow = typeof chatbotBookingCalendars.$inferSelect;
export type ChatbotCalendarInsertRow = typeof chatbotBookingCalendars.$inferInsert;
export type ChatbotAppointmentRow = typeof chatbotAppointments.$inferSelect;
export type ChatbotAppointmentInsertRow = typeof chatbotAppointments.$inferInsert;
export type ChatbotBookingReminderRow = typeof chatbotBookingReminders.$inferSelect;
export type ChatbotBookingReminderInsertRow = typeof chatbotBookingReminders.$inferInsert;
