/*
 * Drizzle table for voice-call sessions (server/modules/chatbot/voice-call/).
 *
 * DRAFT. Not added to shared/schema.ts and no migration is applied. The draft SQL is in
 * db/migrations-draft/0030_voice_call.sql.
 *
 * company_id is NOT NULL and every unique index includes it. The (company_id, chatbot_id) pair has a composite
 * foreign key to chatbots, so a call cannot point at another company's chatbot even if application code has a bug.
 */
import { sql } from "drizzle-orm";
import { foreignKey, index, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbots } from "../../../../shared/schema.ts";

export const chatbotVoiceCalls = pgTable(
  "chatbot_voice_calls",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    conversationId: varchar("conversation_id"),
    direction: varchar("direction", { length: 16 }).notNull(), // inbound | outbound
    provider: varchar("provider", { length: 32 }).notNull(),
    providerCallId: varchar("provider_call_id", { length: 255 }), // null until the provider returns its id
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    status: varchar("status", { length: 16 }).notNull().default("ringing"), // ringing | in_progress | completed | failed | no_answer
    endReason: varchar("end_reason", { length: 32 }), // completed | limit_reached | provider_error | failed
    fromNumber: varchar("from_number", { length: 32 }).notNull(), // personal data: masked in outputs and logs
    toNumber: varchar("to_number", { length: 32 }).notNull(), // personal data: masked in outputs and logs
    maxSeconds: integer("max_seconds"), // plan cap at start; null means unlimited
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_voice_calls_company_provider_call_uidx").on(table.companyId, table.provider, table.providerCallId),
    uniqueIndex("chatbot_voice_calls_company_chatbot_idem_uidx").on(table.companyId, table.chatbotId, table.idempotencyKey),
    index("chatbot_voice_calls_company_chatbot_status_idx").on(table.companyId, table.chatbotId, table.status),
    index("chatbot_voice_calls_company_chatbot_ended_idx").on(table.companyId, table.chatbotId, table.endedAt),
    foreignKey({
      name: "chatbot_voice_calls_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
  ],
);

export type ChatbotVoiceCallRow = typeof chatbotVoiceCalls.$inferSelect;
export type ChatbotVoiceCallInsert = typeof chatbotVoiceCalls.$inferInsert;
