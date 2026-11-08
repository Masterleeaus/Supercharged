/*
 * DRAFT fragment for the unified inbox. Not wired into shared/schema.ts and not applied to any database.
 * The integration agent merges these tables into the chatbot schema later.
 *
 * Every table carries company_id, and every child table uses a composite foreign key on
 * (company_id, conversation_id). A participant or presence row therefore cannot point at another
 * company's conversation, even when application code has a bug.
 *
 * Handoff state is not stored here. It lives on chatbot_conversations.connect_agent_at (already in
 * ../schema.DRAFT.ts). Assignee and priority are not in the Desk conversation table, so they sit in
 * chatbot_inbox_conversation_states. The integration agent can fold them into chatbot_conversations instead.
 *
 * Verify the coalesce() unique index against the installed drizzle-orm version before promoting.
 * node_modules is empty in this checkout, so this file has not been type-checked against drizzle.
 */
import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations } from "../schema.DRAFT.ts";

export const chatbotInboxConversationStates = pgTable(
  "chatbot_inbox_conversation_states",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    assignedTo: varchar("assigned_to", { length: 191 }), // staff user id, null when unassigned
    priority: varchar("priority", { length: 16 }).notNull().default("normal"), // low | normal | high | urgent
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_inbox_states_company_conversation_uidx").on(table.companyId, table.conversationId),
    foreignKey({
      name: "chatbot_inbox_states_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_inbox_states_company_assignee_idx").on(table.companyId, table.assignedTo),
  ]
);

export const chatbotInboxParticipants = pgTable(
  "chatbot_inbox_participants",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    reference: varchar("reference", { length: 191 }), // null for participants with no external reference
    displayName: varchar("display_name", { length: 191 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    lastReadMessageId: varchar("last_read_message_id"), // cursor: message id, null when nothing has been read
    lastReadMessageCreatedAt: timestamp("last_read_message_created_at"), // cursor: message createdAt, paired with the id
    lastReadAt: timestamp("last_read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // coalesce() makes a null reference compare equal, so a second reference-less row of the same type is refused.
    uniqueIndex("chatbot_inbox_participants_key_uidx").on(
      table.companyId,
      table.conversationId,
      table.type,
      sql`coalesce(${table.reference}, '')`,
    ),
    uniqueIndex("chatbot_inbox_participants_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "chatbot_inbox_participants_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_inbox_participants_company_conversation_idx").on(table.companyId, table.conversationId),
  ]
);

export const chatbotInboxPresence = pgTable(
  "chatbot_inbox_presence",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    participantKey: varchar("participant_key", { length: 191 }).notNull(),
    state: varchar("state", { length: 16 }).notNull().default("online"), // online | away | busy | offline
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    uniqueIndex("chatbot_inbox_presence_key_uidx").on(table.companyId, table.conversationId, table.participantKey),
    foreignKey({
      name: "chatbot_inbox_presence_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_inbox_presence_company_seen_idx").on(table.companyId, table.conversationId, table.lastSeenAt),
  ]
);

export type ChatbotInboxParticipantRow = typeof chatbotInboxParticipants.$inferSelect;
export type ChatbotInboxParticipantInsertRow = typeof chatbotInboxParticipants.$inferInsert;
export type ChatbotInboxPresenceRow = typeof chatbotInboxPresence.$inferSelect;
export type ChatbotInboxConversationStateRow = typeof chatbotInboxConversationStates.$inferSelect;
