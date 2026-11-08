/**
 * Drizzle tables for the knowledge slice: sources, chunks and embeddings. Not applied by any migration.
 * The SQL draft is db/migrations-draft/0010_knowledge.sql.
 *
 * Conventions (see db/cart.ts):
 * - Table names carry the chatbot_ prefix. Columns are snake_case.
 * - Every table has company_id. Primary keys are (company_id, id), so an upsert cannot overwrite another
 *   tenant's row.
 * - Child tables use composite foreign keys on (company_id, parent id). A chunk or embedding can never point
 *   at a source of another company.
 * - Chunk and embedding rows cascade when their source is deleted. The storage also deletes them explicitly.
 * - Vectors are stored as jsonb number arrays. Similarity is computed in app code (see contracts/knowledge.ts).
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbots } from "../../../../shared/schema.ts";

/** Constraint names the storage maps to KnowledgeError codes. Keep them in step with drizzle-storage.ts. */
export const KNOWLEDGE_CONSTRAINTS = {
  sourceUri: "chatbot_knowledge_sources_company_chatbot_kind_uri_uidx",
  chunkOrdinal: "chatbot_knowledge_chunks_company_source_ordinal_uidx",
} as const;

export const KNOWLEDGE_SOURCE_KIND_SQL = "('url', 'file', 'text', 'product_feed', 'faq')";
export const KNOWLEDGE_SOURCE_STATUS_SQL = "('pending', 'indexing', 'ready', 'failed', 'disabled')";

export const chatbotKnowledgeSources = pgTable(
  "chatbot_knowledge_sources",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    uri: text("uri"), // page URL, attachment id, or article key. Null for text and Q&A sources.
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    contentHash: varchar("content_hash", { length: 64 }),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_knowledge_sources_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(KNOWLEDGE_CONSTRAINTS.sourceUri).on(table.companyId, table.chatbotId, table.kind, table.uri),
    foreignKey({
      name: "chatbot_knowledge_sources_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
    check("chatbot_knowledge_sources_kind_check", sql`${table.kind} IN ${sql.raw(KNOWLEDGE_SOURCE_KIND_SQL)}`),
    check("chatbot_knowledge_sources_status_check", sql`${table.status} IN ${sql.raw(KNOWLEDGE_SOURCE_STATUS_SQL)}`),
    index("chatbot_knowledge_sources_company_chatbot_status_idx").on(table.companyId, table.chatbotId, table.status),
  ],
);

export const chatbotKnowledgeChunks = pgTable(
  "chatbot_knowledge_chunks",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(), // deterministic, see chunkIdFor() in chunking.ts
    sourceId: varchar("source_id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_knowledge_chunks_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(KNOWLEDGE_CONSTRAINTS.chunkOrdinal).on(table.companyId, table.sourceId, table.ordinal),
    foreignKey({
      name: "chatbot_knowledge_chunks_company_source_fk",
      columns: [table.companyId, table.sourceId],
      foreignColumns: [chatbotKnowledgeSources.companyId, chatbotKnowledgeSources.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chatbot_knowledge_chunks_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
    check("chatbot_knowledge_chunks_ordinal_check", sql`${table.ordinal} >= 0`),
    index("chatbot_knowledge_chunks_company_chatbot_idx").on(table.companyId, table.chatbotId),
  ],
);

export const chatbotKnowledgeEmbeddings = pgTable(
  "chatbot_knowledge_embeddings",
  {
    companyId: uuid("company_id").notNull(),
    chunkId: varchar("chunk_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    dimensions: integer("dimensions").notNull(),
    vector: jsonb("vector").$type<number[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_knowledge_embeddings_pk", columns: [table.companyId, table.chunkId, table.provider, table.model] }),
    foreignKey({
      name: "chatbot_knowledge_embeddings_company_chunk_fk",
      columns: [table.companyId, table.chunkId],
      foreignColumns: [chatbotKnowledgeChunks.companyId, chatbotKnowledgeChunks.id],
    }).onDelete("cascade"),
    check("chatbot_knowledge_embeddings_dimensions_check", sql`${table.dimensions} > 0`),
    index("chatbot_knowledge_embeddings_company_model_idx").on(table.companyId, table.provider, table.model, table.dimensions),
  ],
);
