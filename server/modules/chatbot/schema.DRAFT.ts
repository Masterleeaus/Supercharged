/*
 * DRAFT - not wired into shared/schema.ts and not applied to any database.
 * Matching SQL is in migrations/DRAFT_chatbot.sql. Review both before promoting either one.
 *
 * Every table carries company_id. The child tables use composite foreign keys on (company_id, id),
 * so a conversation cannot point at another company's chatbot, and a message cannot point at another
 * company's conversation, even when application code has a bug.
 */
import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

// integration fix 7: one definition of chatbots. It is the shared/schema.ts table, not a second pgTable.
export { chatbots } from "../../../shared/schema.ts";

export const chatbotConversations = pgTable(
  "chatbot_conversations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    sessionId: varchar("session_id", { length: 128 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull().default("web"),
    connectAgentAt: timestamp("connect_agent_at"), // null while the bot handles the chat
    isShownOnHistory: boolean("is_shown_on_history").notNull().default(true),
    ticketStatus: varchar("ticket_status", { length: 16 }).notNull().default("new"), // new | closed
    pinned: boolean("pinned").notNull().default(false),
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_conversations_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "chatbot_conversations_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
    index("chatbot_conversations_company_activity_idx").on(table.companyId, table.lastActivityAt),
    index("chatbot_conversations_company_session_idx").on(table.companyId, table.sessionId),
  ]
);

export const chatbotMessages = pgTable(
  "chatbot_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    role: varchar("role", { length: 16 }).notNull(), // user | assistant
    message: text("message").notNull(),
    contentType: varchar("content_type", { length: 16 }).notNull().default("text"), // text | titan-ui
    uiSpec: jsonb("ui_spec").$type<Record<string, unknown>>(), // validated spec, null for plain text
    mediaUrl: text("media_url"),
    mediaName: text("media_name"),
    isInternalNote: boolean("is_internal_note").notNull().default(false),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chatbot_messages_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_messages_company_conversation_idx").on(table.companyId, table.conversationId, table.createdAt),
    index("chatbot_messages_unread_idx").on(table.companyId, table.conversationId, table.role, table.readAt),
  ]
);

export type ChatbotRow = typeof chatbots.$inferSelect;
export type ChatbotInsertRow = typeof chatbots.$inferInsert;
export type ChatbotConversationRow = typeof chatbotConversations.$inferSelect;
export type ChatbotConversationInsertRow = typeof chatbotConversations.$inferInsert;
export type ChatbotMessageRow = typeof chatbotMessages.$inferSelect;
export type ChatbotMessageInsertRow = typeof chatbotMessages.$inferInsert;
