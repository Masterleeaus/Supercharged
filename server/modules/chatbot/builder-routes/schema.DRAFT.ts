/*
 * DRAFT fragment for the chatbot builder. Not wired into shared/schema.ts and not applied to any database.
 * It goes with server/modules/chatbot/schema.DRAFT.ts and the matching SQL in migrations/DRAFT_chatbot.sql.
 * Review all of them before promoting any one.
 *
 * Drizzle cannot add columns to a table defined elsewhere, so the chatbots columns are exported as a
 * fragment: spread builderChatbotColumns into the chatbots pgTable definition when promoting.
 */
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Two new columns on chatbots:
 *  - builder_settings: one JSON object holding the wire-named builder keys (configure, customize and
 *    embed.trustedDomains). Merged on write, never replaced.
 *  - public_uuid: the id shown in the embed snippet (embed.uuid). Unique, read-only from the API.
 */
export const builderChatbotColumns = {
  builderSettings: jsonb("builder_settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  publicUuid: uuid("public_uuid").notNull().default(sql`gen_random_uuid()`).unique(),
};

/**
 * Avatars. A null company_id marks a preset shared by every company. Uploads carry the company id and are
 * listed only to that company.
 */
export const chatbotAvatars = pgTable(
  "chatbot_avatars",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id"),
    path: varchar("path", { length: 512 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_avatars_path_uidx").on(table.path),
    index("chatbot_avatars_company_idx").on(table.companyId),
  ],
);

export type ChatbotAvatarRow = typeof chatbotAvatars.$inferSelect;
export type ChatbotAvatarInsertRow = typeof chatbotAvatars.$inferInsert;
