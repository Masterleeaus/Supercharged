/**
 * Drizzle tables for review requests and submitted reviews. Not applied by any migration.
 * Every table has company_id. Primary keys are (company_id, id). A unique index on (company_id, conversation_id)
 * makes "one review per conversation" a database rule, not only an application check.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const REVIEW_CONSTRAINTS = {
  requestsPk: "chatbot_review_requests_pk",
  requestOnePerConversation: "chatbot_review_requests_one_per_conversation_uidx",
  requestTokenUnique: "chatbot_review_requests_token_uidx",
  reviewsPk: "chatbot_reviews_pk",
  reviewOnePerConversation: "chatbot_reviews_one_per_conversation_uidx",
  ratingRange: "chatbot_reviews_rating_range_check",
  requestStatus: "chatbot_review_requests_status_check",
} as const;

export const chatbotReviewRequests = pgTable(
  "chatbot_review_requests",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("scheduled"),
    reason: varchar("reason", { length: 64 }).notNull(),
    dueAt: timestamp("due_at").notNull(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: REVIEW_CONSTRAINTS.requestsPk, columns: [table.companyId, table.id] }),
    uniqueIndex(REVIEW_CONSTRAINTS.requestOnePerConversation).on(table.companyId, table.conversationId),
    uniqueIndex(REVIEW_CONSTRAINTS.requestTokenUnique).on(table.companyId, table.tokenHash),
    index("chatbot_review_requests_due_idx").on(table.companyId, table.status, table.dueAt),
    check(REVIEW_CONSTRAINTS.requestStatus, sql`${table.status} IN ('scheduled', 'cancelled')`),
  ],
);

export const chatbotReviews = pgTable(
  "chatbot_reviews",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    requestId: varchar("request_id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: REVIEW_CONSTRAINTS.reviewsPk, columns: [table.companyId, table.id] }),
    uniqueIndex(REVIEW_CONSTRAINTS.reviewOnePerConversation).on(table.companyId, table.conversationId),
    index("chatbot_reviews_chatbot_idx").on(table.companyId, table.chatbotId, table.submittedAt),
    check(REVIEW_CONSTRAINTS.ratingRange, sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);
