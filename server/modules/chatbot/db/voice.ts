/**
 * Drizzle tables for the voice chat pipeline: voice sessions and their turns. Not applied by any migration and not
 * added to shared/schema.ts. Draft SQL is in db/migrations-draft/0002_voice.sql.
 *
 * Conventions:
 * - Table names carry the chatbot_voice_ prefix. Columns are snake_case.
 * - Every table has company_id. Primary keys start with company_id, so a lookup by id alone cannot cross tenants.
 * - Parent rows (chatbots, chatbot_conversations) come from shared/schema.ts. Child rows use composite foreign keys.
 * - Durations are integer milliseconds. The plan limit (plans.voice_call_seconds_limit, -1 for unlimited) is
 *   converted to milliseconds when a session starts and stored on the session as limit_ms (null = unlimited).
 *
 * Audio is never stored here. Transcripts live in chatbot_messages (see voice-service.ts). A turn row keeps only the
 * ids of the customer and assistant messages it produced.
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations, chatbots } from "../../../../shared/schema.ts";

/** Constraint names. Keep them in step with the draft SQL and the storage error mapping. */
export const VOICE_CONSTRAINTS = {
  sessionStatusCheck: "chatbot_voice_sessions_status_check",
  sessionEndReasonCheck: "chatbot_voice_sessions_end_reason_check",
  sessionLimitCheck: "chatbot_voice_sessions_limit_check",
  sessionUsageCheck: "chatbot_voice_sessions_usage_check",
  turnPrimaryKey: "chatbot_voice_turns_pk",
  turnSessionFk: "chatbot_voice_turns_company_session_fk",
} as const;

export const chatbotVoiceSessions = pgTable(
  "chatbot_voice_sessions",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | ended
    endReason: varchar("end_reason", { length: 32 }), // customer | limit_reached | failed, null while active
    limitMs: bigint("limit_ms", { mode: "number" }), // null = unlimited, otherwise the plan limit in milliseconds
    usedMs: bigint("used_ms", { mode: "number" }).notNull().default(0),
    turnCount: integer("turn_count").notNull().default(0), // also the sequence number of the last reserved turn
    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_voice_sessions_pk", columns: [table.companyId, table.id] }),
    foreignKey({
      name: "chatbot_voice_sessions_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
    foreignKey({
      name: "chatbot_voice_sessions_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    check(VOICE_CONSTRAINTS.sessionStatusCheck, sql`${table.status} IN ('active', 'ended')`),
    check(VOICE_CONSTRAINTS.sessionEndReasonCheck, sql`${table.endReason} IS NULL OR ${table.endReason} IN ('customer', 'limit_reached', 'failed', 'idle')`),
    check(VOICE_CONSTRAINTS.sessionLimitCheck, sql`${table.limitMs} IS NULL OR ${table.limitMs} >= 0`),
    check(VOICE_CONSTRAINTS.sessionUsageCheck, sql`${table.usedMs} >= 0`),
    index("chatbot_voice_sessions_company_idx").on(table.companyId, table.startedAt),
    index("chatbot_voice_sessions_company_chatbot_idx").on(table.companyId, table.chatbotId),
  ],
);

export const chatbotVoiceTurns = pgTable(
  "chatbot_voice_turns",
  {
    companyId: uuid("company_id").notNull(),
    sessionId: varchar("session_id", { length: 191 }).notNull(),
    seq: integer("seq").notNull(), // 1-based, unique within the session
    durationMs: integer("duration_ms"), // customer audio length as the caller reported it, null when unknown
    customerMessageId: varchar("customer_message_id", { length: 191 }).notNull(),
    assistantMessageId: varchar("assistant_message_id", { length: 191 }), // null when the reply failed after the transcript was stored
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: VOICE_CONSTRAINTS.turnPrimaryKey, columns: [table.companyId, table.sessionId, table.seq] }),
    foreignKey({
      name: VOICE_CONSTRAINTS.turnSessionFk,
      columns: [table.companyId, table.sessionId],
      foreignColumns: [chatbotVoiceSessions.companyId, chatbotVoiceSessions.id],
    }),
    index("chatbot_voice_turns_company_idx").on(table.companyId),
  ],
);
