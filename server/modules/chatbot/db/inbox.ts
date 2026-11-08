/*
 * Drizzle tables for the unified inbox and the staff reply layer. Not applied to any database, and not
 * added to shared/schema.ts. The parent tables (chatbots, chatbot_conversations, chatbot_messages) come from
 * shared/schema.ts, so the composite foreign keys below point at them.
 *
 * Every table carries company_id. Every child table has a composite foreign key on (company_id, conversation_id),
 * so a row cannot point at another company's conversation even when application code has a bug.
 *
 * Side tables, not parent columns:
 *   chatbot_inbox_conversation_states  assignee, priority, and the staff member who took the chat over
 *   chatbot_inbox_participants         participants and read cursors
 *   chatbot_inbox_presence             presence heartbeats
 *   chatbot_inbox_message_staff        the staff member who wrote an assistant-side message
 *
 * The staff columns are side tables because shared/schema.ts has no staff_id or handler_staff_id yet
 * (see INTEGRATION.md, section 3). When the integration pass promotes them, these tables can fold in.
 */
import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations } from "../../../../shared/schema.ts";

export const chatbotInboxConversationStates = pgTable(
  "chatbot_inbox_conversation_states",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    assignedTo: varchar("assigned_to", { length: 191 }), // staff user id, null when unassigned
    priority: varchar("priority", { length: 16 }).notNull().default("normal"), // low | normal | high | urgent
    handlerStaffId: varchar("handler_staff_id", { length: 191 }), // staff member who took over, null while the AI handles the chat
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
  ],
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
  ],
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
  ],
);

/** Staff member who wrote an assistant-side message. Customer and AI messages have no row here. */
export const chatbotInboxMessageStaff = pgTable(
  "chatbot_inbox_message_staff",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    messageId: varchar("message_id").notNull(),
    staffId: varchar("staff_id", { length: 191 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_inbox_message_staff_key_uidx").on(table.companyId, table.messageId),
    foreignKey({
      name: "chatbot_inbox_message_staff_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
  ],
);

export type ChatbotInboxConversationStateRow = typeof chatbotInboxConversationStates.$inferSelect;
export type ChatbotInboxParticipantRow = typeof chatbotInboxParticipants.$inferSelect;
export type ChatbotInboxParticipantInsertRow = typeof chatbotInboxParticipants.$inferInsert;
export type ChatbotInboxPresenceRow = typeof chatbotInboxPresence.$inferSelect;
export type ChatbotInboxMessageStaffRow = typeof chatbotInboxMessageStaff.$inferSelect;
