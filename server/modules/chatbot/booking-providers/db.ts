/*
 * Drizzle tables for the booking-providers folder: provider booking links and the reminder ledger.
 *
 * Not added to shared/schema.ts. No migration is written here. The migration draft belongs in
 * db/migrations-draft/, which this folder is not allowed to write (see DECISIONS.md, S1 and S2).
 *
 * Every table carries company_id. Child rows use a composite foreign key on (company_id, id) to the
 * bookings appointments table, so a link cannot point at another company's appointment.
 *
 * Also holds the retry-safety ledger for booking requests (chatbot_booking_attempts) and the sealed Cal.com
 * secrets (chatbot_calendar_secrets). Secrets are stored only as SecretBox output.
 *
 * Draft SQL for the owner to review (not applied):
 *   chatbot_external_bookings: UNIQUE (company_id, provider, external_booking_id)
 *   chatbot_booking_reminder_sends: UNIQUE (company_id, appointment_id, channel)
 *   chatbot_booking_attempts: UNIQUE (company_id, provider, idempotency_key)
 *   chatbot_calendar_secrets: UNIQUE (company_id, provider, purpose)
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotAppointments } from "../db/bookings.ts";

export const CALENDAR_PROVIDER_VALUES = ["calendly", "calcom"] as const;
export const REMINDER_SEND_STATUS_VALUES = ["sending", "sent", "failed", "cancelled"] as const;
export const LINK_STATUS_VALUES = ["active", "cancelled"] as const;
export const BOOKING_ATTEMPT_STATUS_VALUES = ["pending", "booked", "rejected", "unknown"] as const;
export const CALENDAR_SECRET_PURPOSE_VALUES = ["api_key", "webhook_secret"] as const;
export const REMINDER_CHANNEL_VALUES = ["email", "sms", "whatsapp", "telegram", "web"] as const;

export const chatbotExternalBookings = pgTable(
  "chatbot_external_bookings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(), // calendly | calcom
    externalEventTypeId: varchar("external_event_type_id", { length: 512 }).notNull(),
    externalBookingId: varchar("external_booking_id", { length: 512 }).notNull(),
    appointmentId: varchar("appointment_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | cancelled
    manageUrl: text("manage_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_external_bookings_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("chatbot_external_bookings_provider_uidx").on(table.companyId, table.provider, table.externalBookingId),
    index("chatbot_external_bookings_window_idx").on(table.companyId, table.provider, table.startsAt),
    foreignKey({
      name: "chatbot_external_bookings_company_appointment_fk",
      columns: [table.companyId, table.appointmentId],
      foreignColumns: [chatbotAppointments.companyId, chatbotAppointments.id],
    }),
    check("chatbot_external_bookings_provider_chk", sql`${table.provider} IN ('calendly', 'calcom')`),
    check("chatbot_external_bookings_status_chk", sql`${table.status} IN ('active', 'cancelled')`),
    check("chatbot_external_bookings_range_chk", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

export const chatbotBookingReminderSends = pgTable(
  "chatbot_booking_reminder_sends",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    appointmentId: varchar("appointment_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(), // sending | sent | failed | cancelled
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    externalMessageId: varchar("external_message_id", { length: 255 }),
    reason: varchar("reason", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Once per booking per channel. This is the guarantee the dispatcher relies on.
    uniqueIndex("chatbot_booking_reminder_sends_once_uidx").on(table.companyId, table.appointmentId, table.channel),
    foreignKey({
      name: "chatbot_booking_reminder_sends_company_appointment_fk",
      columns: [table.companyId, table.appointmentId],
      foreignColumns: [chatbotAppointments.companyId, chatbotAppointments.id],
    }),
    check("chatbot_booking_reminder_sends_status_chk", sql`${table.status} IN ('sending', 'sent', 'failed', 'cancelled')`),
  ],
);

/** One row per reminder send attempt, including retryable failures. Written by the attempt log, never read by a send. */
export const chatbotBookingReminderAttempts = pgTable(
  "chatbot_booking_reminder_attempts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    appointmentId: varchar("appointment_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    attemptNo: integer("attempt_no").notNull(),
    status: varchar("status", { length: 16 }).notNull(), // sent | failed | error
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    externalMessageId: varchar("external_message_id", { length: 255 }),
    reason: varchar("reason", { length: 255 }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chatbot_booking_reminder_attempts_company_appt_idx").on(table.companyId, table.appointmentId, table.channel),
    check("chatbot_booking_reminder_attempts_status_chk", sql`${table.status} IN ('sent', 'failed', 'error')`),
  ],
);

export const chatbotBookingAttempts = pgTable(
  "chatbot_booking_attempts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(), // calendly | calcom
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(), // pending | booked | rejected | unknown
    externalBookingId: varchar("external_booking_id", { length: 512 }),
    manageUrl: text("manage_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per key. This is what stops a retry from creating a second provider booking.
    uniqueIndex("chatbot_booking_attempts_key_uidx").on(table.companyId, table.provider, table.idempotencyKey),
    index("chatbot_booking_attempts_company_status_idx").on(table.companyId, table.status),
    check("chatbot_booking_attempts_provider_chk", sql`${table.provider} IN ('calendly', 'calcom')`),
    check("chatbot_booking_attempts_status_chk", sql`${table.status} IN ('pending', 'booked', 'rejected', 'unknown')`),
  ],
);

export const chatbotCalendarSecrets = pgTable(
  "chatbot_calendar_secrets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(), // calendly | calcom
    purpose: varchar("purpose", { length: 32 }).notNull(), // api_key | webhook_secret
    sealed: jsonb("sealed").notNull(), // SealedSecret from the SecretBox contract. Never plaintext.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_calendar_secrets_uidx").on(table.companyId, table.provider, table.purpose),
    index("chatbot_calendar_secrets_company_idx").on(table.companyId),
    check("chatbot_calendar_secrets_provider_chk", sql`${table.provider} IN ('calendly', 'calcom')`),
    check("chatbot_calendar_secrets_purpose_chk", sql`${table.purpose} IN ('api_key', 'webhook_secret')`),
  ],
);

export type ChatbotExternalBookingRow = typeof chatbotExternalBookings.$inferSelect;
export type ChatbotBookingReminderSendRow = typeof chatbotBookingReminderSends.$inferSelect;
export type ChatbotBookingAttemptRow = typeof chatbotBookingAttempts.$inferSelect;
export type ChatbotCalendarSecretRow = typeof chatbotCalendarSecrets.$inferSelect;
