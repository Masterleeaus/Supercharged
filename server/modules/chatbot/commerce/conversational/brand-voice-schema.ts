/**
 * Drizzle table for the brand voice profile: one row per company and chatbot.
 *
 * Placed in this folder, not in db/, because this area may only write its own folder. The CONVENTIONS ask for
 * tables in db/<area>.ts. Change request logged in DECISIONS.md: move this table to
 * db/commerce-conversational-brand-voice.ts at integration. Not applied by any migration.
 *
 * Every row carries company_id. The primary key starts with company_id, so an upsert cannot overwrite another
 * tenant's profile.
 */
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const BRAND_VOICE_CONSTRAINTS = {
  pk: "chatbot_commerce_brand_voice_pk",
  companyIndex: "chatbot_commerce_brand_voice_company_idx",
} as const;

export const chatbotCommerceBrandVoice = pgTable(
  "chatbot_commerce_brand_voice",
  {
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    tone: text("tone").notNull().default(""),
    locale: varchar("locale", { length: 35 }).notNull(),
    preferredTerms: jsonb("preferred_terms").notNull().default([]),
    forbiddenTerms: jsonb("forbidden_terms").notNull().default([]),
    updatedBy: varchar("updated_by", { length: 191 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: BRAND_VOICE_CONSTRAINTS.pk, columns: [t.companyId, t.chatbotId] }),
    index(BRAND_VOICE_CONSTRAINTS.companyIndex).on(t.companyId),
  ],
);
