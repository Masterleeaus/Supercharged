/*
 * Drizzle tables for the chatbot customers slice: customers, contact identities, conversation-customer
 * links, customer tags and conversation-tag assignments.
 *
 * DRAFT. Not added to shared/schema.ts and no migration is applied. The parent tables (chatbots,
 * chatbot_conversations) are imported from shared/schema.ts.
 *
 * Every table carries company_id (NOT NULL). Child tables use composite foreign keys on (company_id, id),
 * so a row cannot point at another company's parent, even when application code has a bug.
 * Decisions behind these tables are in ../customers/DECISIONS.md, section "Drizzle".
 */
import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations, chatbots } from "../../../../shared/schema.ts";

export const chatbotCustomers = pgTable(
  "chatbot_customers",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    userId: varchar("user_id", { length: 64 }), // linked Desk user; data only, never used for authorization
    avatar: text("avatar"),
    name: varchar("name", { length: 255 }),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 255 }),
    chatbotId: varchar("chatbot_id"),
    sessionId: varchar("session_id", { length: 128 }),
    countryCode: varchar("country_code", { length: 32 }),
    ipAddress: varchar("ip_address", { length: 64 }), // personal data: never logged
    chatbotChannel: varchar("chatbot_channel", { length: 32 }),
    enabledSound: boolean("enabled_sound").notNull().default(true),
    preferredLanguage: varchar("preferred_language", { length: 16 }),
    communicationPreferences: jsonb("communication_preferences").$type<Record<string, unknown>>(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_customers_company_id_uidx").on(table.companyId, table.id),
    index("chatbot_customers_company_email_idx").on(table.companyId, table.email),
    foreignKey({
      name: "chatbot_customers_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
  ],
);

export const chatbotContactIdentities = pgTable(
  "chatbot_contact_identities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    customerId: varchar("customer_id").notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    normalizedIdentifier: varchar("normalized_identifier", { length: 255 }).notNull(),
    verifiedAt: timestamp("verified_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Unique per company. The source index is global, which would let one tenant match another's contacts.
    uniqueIndex("chatbot_contact_identities_company_value_uidx").on(
      table.companyId,
      table.channel,
      table.normalizedIdentifier,
    ),
    index("chatbot_contact_identities_company_customer_idx").on(table.companyId, table.customerId),
    foreignKey({
      name: "chatbot_contact_identities_company_customer_fk",
      columns: [table.companyId, table.customerId],
      foreignColumns: [chatbotCustomers.companyId, chatbotCustomers.id],
    }),
  ],
);

/** One row per conversation. Replaces the chatbot_customer_id column the source adds to conversations. */
export const chatbotCustomerConversations = pgTable(
  "chatbot_customer_conversations",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    customerId: varchar("customer_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_customer_conversations_company_conversation_uidx").on(table.companyId, table.conversationId),
    index("chatbot_customer_conversations_company_customer_idx").on(table.companyId, table.customerId),
    foreignKey({
      name: "chatbot_customer_conversations_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    foreignKey({
      name: "chatbot_customer_conversations_company_customer_fk",
      columns: [table.companyId, table.customerId],
      foreignColumns: [chatbotCustomers.companyId, chatbotCustomers.id],
    }),
  ],
);

export const chatbotCustomerTags = pgTable(
  "chatbot_customer_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    tag: varchar("tag", { length: 255 }).notNull(),
    tagColor: varchar("tag_color", { length: 50 }),
    backgroundColor: varchar("background_color", { length: 50 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_customer_tags_company_id_uidx").on(table.companyId, table.id),
    // Not unique: the source allows two tags with the same name. See DECISIONS.md.
    index("chatbot_customer_tags_company_tag_idx").on(table.companyId, table.tag),
  ],
);

export const chatbotConversationCustomerTags = pgTable(
  "chatbot_conversation_customer_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    customerTagId: varchar("customer_tag_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The pair is unique, so a tag can be assigned to a conversation only once.
    uniqueIndex("chatbot_conversation_customer_tags_pair_uidx").on(
      table.companyId,
      table.conversationId,
      table.customerTagId,
    ),
    index("chatbot_conversation_customer_tags_company_tag_idx").on(table.companyId, table.customerTagId),
    foreignKey({
      name: "chatbot_conversation_customer_tags_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    foreignKey({
      name: "chatbot_conversation_customer_tags_company_tag_fk",
      columns: [table.companyId, table.customerTagId],
      foreignColumns: [chatbotCustomerTags.companyId, chatbotCustomerTags.id],
    }),
  ],
);

export type ChatbotCustomerRow = typeof chatbotCustomers.$inferSelect;
export type ChatbotContactIdentityRow = typeof chatbotContactIdentities.$inferSelect;
export type ChatbotCustomerConversationRow = typeof chatbotCustomerConversations.$inferSelect;
export type ChatbotCustomerTagRow = typeof chatbotCustomerTags.$inferSelect;
export type ChatbotConversationCustomerTagRow = typeof chatbotConversationCustomerTags.$inferSelect;
