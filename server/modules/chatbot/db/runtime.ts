/*
 * Drizzle tables for the conversation and reply runtime: reply turn claims (so one customer message gets one
 * stored reply) and staff drafts (the editable text a staff member saves per conversation). Not applied by any
 * migration. The SQL draft is in db/migrations-draft/0050_runtime.sql.
 *
 * Conventions:
 * - Table names carry the chatbot_ prefix. Columns are snake_case.
 * - Every table has company_id. Primary keys and unique indexes include company_id.
 * - Child rows reference chatbot_conversations with a composite foreign key on (company_id, id).
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations } from "../../../../shared/schema.ts";

export const RUNTIME_CONSTRAINTS = {
  turnPk: "chatbot_reply_turns_pk",
  draftUnique: "chatbot_staff_drafts_company_conversation_staff_uidx",
} as const;

/** One row per (conversation, turn key). A row in state 'pending' is a lease that expires; 'done' is final. */
export const chatbotReplyTurns = pgTable(
  "chatbot_reply_turns",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    turnKey: varchar("turn_key", { length: 191 }).notNull(), // e.g. "msg:<customer message id>"
    state: varchar("state", { length: 16 }).notNull(), // pending | done
    messageId: varchar("message_id", { length: 191 }), // set when state is done
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ name: RUNTIME_CONSTRAINTS.turnPk, columns: [table.companyId, table.conversationId, table.turnKey] }),
    index("chatbot_reply_turns_company_idx").on(table.companyId),
    foreignKey({
      name: "chatbot_reply_turns_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    check("chatbot_reply_turns_state_check", sql`${table.state} IN ('pending', 'done')`),
  ],
);

/**
 * Staff draft: the text one staff member saved for one conversation. staff_id is '' when the caller has no staff id,
 * because a nullable column would let two anonymous drafts coexist under a unique index.
 */
export const chatbotStaffDrafts = pgTable(
  "chatbot_staff_drafts",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    staffId: varchar("staff_id", { length: 191 }).notNull().default(""),
    content: text("content"),
    attachments: jsonb("attachments").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_staff_drafts_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(RUNTIME_CONSTRAINTS.draftUnique).on(table.companyId, table.conversationId, table.staffId),
    foreignKey({
      name: "chatbot_staff_drafts_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
  ],
);
