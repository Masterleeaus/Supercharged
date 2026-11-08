/*
 * Drizzle fragment for the chatbot builder (server/modules/chatbot/builder-routes).
 *
 * Not added to shared/schema.ts, and no migration is applied. Owner merge steps when this is promoted:
 *   1. Spread builderChatbotColumns into the chatbots pgTable definition in shared/schema.ts.
 *   2. Move chatbotAvatars into shared/schema.ts (or keep it here and export it from the schema index).
 *   3. Nothing to delete: the duplicate chatbots pgTable was removed (integration fix 7). Until step 1 is done, the
 *      builder storage reads and writes the two columns as SQL on the shared chatbots table (builder-routes/builder-storage.ts).
 *
 * Both tables carry company_id. chatbot_avatars.company_id is null only for presets shared by every company.
 */
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Two new columns on chatbots:
 *  - builder_settings: one JSON object holding the wire-named builder keys (configure, customize and
 *    embed.trustedDomains). Merged on write with the jsonb || operator, never replaced whole.
 *  - public_uuid: the id shown in the embed snippet (embed.uuid). Unique, read-only from the API.
 */
export const builderChatbotColumns = {
  builderSettings: jsonb("builder_settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  publicUuid: uuid("public_uuid").notNull().default(sql`gen_random_uuid()`).unique(),
};

/** Avatar presets (company_id null) and uploads (company_id set). Paths are unique across both. */
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
