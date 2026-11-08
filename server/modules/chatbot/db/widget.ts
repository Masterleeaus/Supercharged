/**
 * Drizzle tables for the public widget: the per-chatbot public configuration and the per-company embed
 * signing keys. Not added to shared/schema.ts and not applied by any migration (see db/migrations-draft/0201_widget.sql).
 *
 * Conventions:
 * - Table names carry the widget_ prefix. Columns are snake_case.
 * - Every table has company_id with an index. Every unique constraint includes company_id.
 * - The signing key is stored only as a SealedSecret (SecretBox). No plaintext key is ever a column.
 * - widget_chatbot_configs holds only fields that the browser may read. Tokens, provider keys and
 *   commerce credentials live elsewhere and are never copied here.
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const WIDGET_CONSTRAINTS = {
  configPerCompanyPublicId: "widget_chatbot_configs_company_public_uidx",
  configPublicIdLookup: "widget_chatbot_configs_public_id_idx",
  signingKeyPerCompanyKeyId: "widget_embed_keys_company_key_uidx",
} as const;

/** Public widget settings for one chatbot. One row per chatbot. */
export const widgetChatbotConfigs = pgTable(
  "widget_chatbot_configs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    /** Internal chatbot id. Never sent to the browser. */
    chatbotId: uuid("chatbot_id").notNull(),
    /** Public id shown in the embed snippet. Random, so it is hard to guess. */
    publicId: uuid("public_id").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    welcomeMessage: text("welcome_message").notNull().default(""),
    launcherText: varchar("launcher_text", { length: 120 }),
    primaryColor: varchar("primary_color", { length: 7 }).notNull().default("#763ed1"),
    launcherPosition: varchar("launcher_position", { length: 16 }).notNull().default("bottom-right"),
    language: varchar("language", { length: 16 }).notNull().default("en"),
    voiceEnabled: boolean("voice_enabled").notNull().default(false),
    generativeUiEnabled: boolean("generative_ui_enabled").notNull().default(false),
    /** Hostnames, optionally with a port. Lower-case. Checked against the Origin header on every request. */
    allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex(WIDGET_CONSTRAINTS.configPerCompanyPublicId).on(table.companyId, table.publicId),
    index(WIDGET_CONSTRAINTS.configPublicIdLookup).on(table.publicId),
    index("widget_chatbot_configs_company_idx").on(table.companyId),
    check("widget_chatbot_configs_position_chk", sql`${table.launcherPosition} in ('bottom-left', 'bottom-right')`),
  ],
);

/** Per-company HMAC signing keys for embed tokens. Only the SealedSecret form is stored. */
export const widgetEmbedKeys = pgTable(
  "widget_embed_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    keyId: varchar("key_id", { length: 64 }).notNull(),
    /**
     * Sealed key from SecretBox, with companyId bound as associated data. Current writes store the versioned string
     * (secrets/sealed-form.ts). Rows written earlier hold the contract object, which is still read.
     */
    sealed: jsonb("sealed").$type<string | Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex(WIDGET_CONSTRAINTS.signingKeyPerCompanyKeyId).on(table.companyId, table.keyId),
    index("widget_embed_keys_company_idx").on(table.companyId),
  ],
);

export type WidgetChatbotConfigRow = typeof widgetChatbotConfigs.$inferSelect;
export type WidgetEmbedKeyRow = typeof widgetEmbedKeys.$inferSelect;
