/*
 * Drizzle table for attachment metadata (attachments, analytics, export and health slice). Not applied to any
 * database and not added to shared/schema.ts. Bytes live in an injected blob store, never in this table.
 *
 * Conventions (see ../contracts/CONVENTIONS.md, section 7):
 * - company_id is on the row and in the primary key (company_id, id), so an upsert cannot overwrite another tenant.
 * - storage_key is the blob-store key. It is random and carries no original filename.
 * - filename is the sanitised display name only. It is never used in a path.
 * - Analytics and export read chatbot_conversations and chatbot_messages from shared/schema.ts. They add no table.
 */
import { sql } from "drizzle-orm";
import { char, check, index, integer, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const chatbotAttachments = pgTable(
  "chatbot_attachments",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    filename: varchar("filename", { length: 255 }).notNull(), // sanitised display name, never part of storage_key
    contentType: varchar("content_type", { length: 127 }).notNull(), // normalised: lower-case, no parameters
    sizeBytes: integer("size_bytes").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"), // soft delete; reads filter it out
  },
  (table) => [
    primaryKey({ name: "chatbot_attachments_pkey", columns: [table.companyId, table.id] }),
    uniqueIndex("chatbot_attachments_company_storage_key_uidx").on(table.companyId, table.storageKey),
    index("chatbot_attachments_company_created_idx").on(table.companyId, table.createdAt),
    index("chatbot_attachments_company_sha256_idx").on(table.companyId, table.sha256),
    check("chatbot_attachments_size_check", sql`${table.sizeBytes} > 0`),
  ],
);
