/*
 * Drizzle tables for canned responses and knowledge-base articles (server/modules/chatbot/content-admin).
 * Not applied to any database, and not added to shared/schema.ts. Draft SQL: db/migrations-draft/0002_content_admin.sql.
 *
 * Every table carries company_id. The article-to-chatbot link table uses composite foreign keys on
 * (company_id, id), so a link cannot point at another company's article or chatbot even if application code has a bug.
 */
import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbots } from "../../../../shared/schema.ts";

export const chatbotCannedResponses = pgTable(
  "chatbot_canned_responses",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    userId: varchar("user_id", { length: 191 }), // author, for display only. Never used for authorization.
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_canned_responses_company_id_uidx").on(table.companyId, table.id),
    index("chatbot_canned_responses_company_title_idx").on(table.companyId, table.title),
  ],
);

export const chatbotKnowledgeBaseArticles = pgTable(
  "chatbot_knowledge_base_articles",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    userId: varchar("user_id", { length: 191 }),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    content: text("content"),
    isFeatured: boolean("is_featured").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_kb_articles_company_id_uidx").on(table.companyId, table.id),
    index("chatbot_kb_articles_company_featured_idx").on(table.companyId, table.isFeatured),
  ],
);

export const chatbotKnowledgeBaseArticleLinks = pgTable(
  "chatbot_knowledge_base_article_links",
  {
    companyId: uuid("company_id").notNull(),
    articleId: varchar("article_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_kb_article_links_uidx").on(table.companyId, table.articleId, table.chatbotId),
    index("chatbot_kb_article_links_company_chatbot_idx").on(table.companyId, table.chatbotId),
    foreignKey({
      name: "chatbot_kb_article_links_article_fk",
      columns: [table.companyId, table.articleId],
      foreignColumns: [chatbotKnowledgeBaseArticles.companyId, chatbotKnowledgeBaseArticles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chatbot_kb_article_links_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }).onDelete("cascade"),
  ],
);

export type ChatbotCannedResponseRow = typeof chatbotCannedResponses.$inferSelect;
export type ChatbotKnowledgeBaseArticleRow = typeof chatbotKnowledgeBaseArticles.$inferSelect;
