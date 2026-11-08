/*
 * Staff drafts: the editable text a staff member saved for a conversation (port of PHP DraftRuntime save/get/delete).
 * One draft per (company, conversation, staff). A null staff id is stored as '' so the unique key holds.
 * Saving a draft never sends it. Sending is a staff action in the message runtime.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { chatbotStaffDrafts } from "../db/runtime.ts";
import type { StaffDraft, StaffDraftAttributes, StaffDraftStore } from "./types.ts";

const NO_STAFF = "";

export function createMemoryStaffDraftStore(): StaffDraftStore {
  const rows = new Map<string, StaffDraft>();
  const keyOf = (companyId: string, conversationId: string, staffId: string | null) =>
    JSON.stringify([companyId, conversationId, staffId ?? NO_STAFF]);

  return {
    async save(companyId, conversationId, staffId, attributes: StaffDraftAttributes, now) {
      const key = keyOf(companyId, conversationId, staffId);
      const next: StaffDraft = {
        companyId,
        conversationId,
        staffId: staffId ?? NO_STAFF,
        content: attributes.content ?? null,
        attachments: attributes.attachments ?? [],
        metadata: attributes.metadata ?? {},
        updatedAt: now,
      };
      rows.set(key, next);
      return structuredClone(rows.get(key) as StaffDraft);
    },

    async get(companyId, conversationId, staffId) {
      const row = rows.get(keyOf(companyId, conversationId, staffId));
      return row ? structuredClone(row) : null;
    },

    async delete(companyId, conversationId, staffId) {
      return rows.delete(keyOf(companyId, conversationId, staffId));
    },
  };
}

export function createDrizzleStaffDraftStore(db: PgDatabase<any, any, any>, newId: () => string = randomUUID): StaffDraftStore {
  return {
    async save(companyId, conversationId, staffId, attributes, now) {
      const staff = staffId ?? NO_STAFF;
      const [row] = await db
        .insert(chatbotStaffDrafts)
        .values({
          companyId,
          id: newId(),
          conversationId,
          staffId: staff,
          content: attributes.content ?? null,
          attachments: attributes.attachments ?? [],
          metadata: attributes.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [chatbotStaffDrafts.companyId, chatbotStaffDrafts.conversationId, chatbotStaffDrafts.staffId],
          set: {
            content: attributes.content ?? null,
            attachments: attributes.attachments ?? [],
            metadata: attributes.metadata ?? {},
            updatedAt: now,
          },
        })
        .returning();
      return toDraft(row);
    },

    async get(companyId, conversationId, staffId) {
      const [row] = await db
        .select()
        .from(chatbotStaffDrafts)
        .where(and(
          eq(chatbotStaffDrafts.companyId, companyId),
          eq(chatbotStaffDrafts.conversationId, conversationId),
          eq(chatbotStaffDrafts.staffId, staffId ?? NO_STAFF),
        ))
        .limit(1);
      return row ? toDraft(row) : null;
    },

    async delete(companyId, conversationId, staffId) {
      const removed = await db
        .delete(chatbotStaffDrafts)
        .where(and(
          eq(chatbotStaffDrafts.companyId, companyId),
          eq(chatbotStaffDrafts.conversationId, conversationId),
          eq(chatbotStaffDrafts.staffId, staffId ?? NO_STAFF),
        ))
        .returning({ id: chatbotStaffDrafts.id });
      return removed.length > 0;
    },
  };
}

function toDraft(row: typeof chatbotStaffDrafts.$inferSelect): StaffDraft {
  return {
    companyId: row.companyId,
    conversationId: row.conversationId,
    staffId: row.staffId,
    content: row.content,
    attachments: row.attachments,
    metadata: row.metadata,
    updatedAt: row.updatedAt,
  };
}
