/*
 * Drizzle tables shared by every channel kind: encrypted account credentials, the outbound send ledger used by the
 * providers, and the channel outbox that holds every outbound message until a worker sends it.
 *
 * Moved here from channels/db-table.ts and db/channels-telegram-messenger.ts. Not applied to any database and not
 * added to shared/schema.ts. The SQL draft is db/migrations-draft/0105_channels_core.sql.
 *
 * Every table carries company_id, and every unique key includes it. Credentials are stored only as a SealedSecret
 * (JSON from SecretBox, with the company id bound), never as plaintext.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const CHANNEL_CORE_CONSTRAINTS = {
  accountsUnique: "chatbot_channel_accounts_company_kind_account_uidx",
  sendKeysUnique: "chatbot_channel_send_keys_company_key_uq",
  outboxUnique: "chatbot_channel_outbox_company_key_uq",
} as const;

/** One row per channel account (a WhatsApp number, a Telegram bot, a Messenger page, an Instagram account). */
export const chatbotChannelAccounts = pgTable(
  "chatbot_channel_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(), // whatsapp | telegram | messenger | instagram | voice | web
    accountId: varchar("account_id", { length: 191 }).notNull(), // the channel's own id for the account
    displayName: varchar("display_name", { length: 191 }),
    sealed: jsonb("sealed").notNull(), // SealedSecret from the SecretBox contract
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | disabled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex(CHANNEL_CORE_CONSTRAINTS.accountsUnique).on(table.companyId, table.kind, table.accountId),
    index("chatbot_channel_accounts_company_idx").on(table.companyId),
    check("chatbot_channel_accounts_kind_check", sql`${table.kind} IN ('whatsapp', 'telegram', 'messenger', 'instagram', 'voice', 'web')`),
    check("chatbot_channel_accounts_status_check", sql`${table.status} IN ('active', 'disabled')`),
  ],
);

/** Provider-level send ledger. A row is claimed before the provider call and marked done on success. */
export const chatbotChannelSendKeys = pgTable(
  "chatbot_channel_send_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    accountId: varchar("account_id", { length: 191 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(), // pending | done
    externalMessageId: varchar("external_message_id", { length: 256 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex(CHANNEL_CORE_CONSTRAINTS.sendKeysUnique).on(
      table.companyId,
      table.channel,
      table.accountId,
      table.idempotencyKey,
    ),
    index("chatbot_channel_send_keys_company_idx").on(table.companyId),
  ],
);

/**
 * Outbound messages. A row is written in the same transaction as the staff or AI reply it belongs to. A worker
 * claims due rows, sends them through the channel provider, and records the outcome.
 */
export const chatbotChannelOutbox = pgTable(
  "chatbot_channel_outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    accountId: varchar("account_id", { length: 191 }).notNull(),
    recipient: varchar("recipient", { length: 256 }).notNull(),
    contentKind: varchar("content_kind", { length: 16 }).notNull(),
    text: text("text"),
    attachmentUrl: text("attachment_url"),
    templateName: varchar("template_name", { length: 191 }),
    templateParams: jsonb("template_params"),
    replyToExternalMessageId: varchar("reply_to_external_message_id", { length: 256 }),
    idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | sending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    externalMessageId: varchar("external_message_id", { length: 256 }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorMessage: varchar("last_error_message", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex(CHANNEL_CORE_CONSTRAINTS.outboxUnique).on(table.companyId, table.idempotencyKey),
    index("chatbot_channel_outbox_due_idx").on(table.companyId, table.status, table.nextAttemptAt),
    check("chatbot_channel_outbox_status_check", sql`${table.status} IN ('pending', 'sending', 'sent', 'failed')`),
    check("chatbot_channel_outbox_attempts_check", sql`${table.attempts} >= 0`),
  ],
);
