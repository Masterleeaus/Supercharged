/*
 * Drizzle implementation of the ConversationStore port (conversation-store.ts). Every query filters on company_id,
 * and every write that changes state writes its outbox row in the same transaction.
 *
 * Tables: chatbot_conversations and chatbot_messages come from shared/schema.ts, which carries the status, handler,
 * merged_into_id, summary, summary_updated_at, customer_id and external_thread_id columns (migrations-draft/0055).
 * Nothing here runs a migration.
 *
 * Builders are exported so tests can render them with PgDialect, without a database.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ChannelKind } from "../contracts/channels.ts";
import type { ConversationRecord, ConversationStatus, MessageRole } from "../contracts/runtime.ts";
import type { Handler } from "../inbox/types.ts";
import { chatbotEventOutbox } from "../db/events.ts";
import { chatbotConversations, chatbots, chatbotMessages } from "../../../../shared/schema.ts";
import type {
  ConversationSearchQuery,
  ConversationStore,
  MergeOutcome,
  NewStoredMessage,
  OutboxAppend,
  StoredMessage,
} from "./conversation-store.ts";
import type { OutboxTx } from "../channels/outbox.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConversationDb = PgDatabase<any, any, any>;

const c = chatbotConversations;
const m = chatbotMessages;
const outbox = chatbotEventOutbox;
type ConversationRow = typeof c.$inferSelect;
type MessageRow = typeof m.$inferSelect;

/** Contract role to the stored role. The stored check allows user, assistant, staff and system. */
function storedRole(role: MessageRole): string {
  return role === "customer" ? "user" : role;
}

export function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    channel: row.channel as ChannelKind,
    externalThreadId: row.externalThreadId,
    customerId: row.customerId,
    status: row.status as ConversationStatus,
    handler: row.handler as Handler,
    summary: row.summary,
    summaryUpdatedAt: row.summaryUpdatedAt,
    mergedIntoId: row.mergedIntoId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    conversationId: row.conversationId,
    role: row.role === "user" ? "customer" : (row.role as MessageRole),
    text: row.contentType === "text" ? row.message : null,
    isInternalNote: row.isInternalNote,
    createdAt: row.createdAt,
  };
}

// ---------- builders (rendered by tests, executed by the store) ----------

export function buildChatbotBelongs(db: ConversationDb, companyId: string, chatbotId: string) {
  return db
    .select({ id: chatbots.id })
    .from(chatbots)
    .where(and(eq(chatbots.companyId, companyId), eq(chatbots.id, chatbotId)))
    .limit(1);
}

export function buildConversationOfMessage(db: ConversationDb, companyId: string, messageId: string) {
  return db
    .select({ conversationId: m.conversationId })
    .from(m)
    .where(and(eq(m.companyId, companyId), eq(m.id, messageId)))
    .limit(1);
}

export function buildFindConversation(db: ConversationDb, companyId: string, id: string) {
  return db.select().from(c).where(and(eq(c.companyId, companyId), eq(c.id, id))).limit(1);
}

export function buildListMessages(db: ConversationDb, companyId: string, conversationId: string) {
  return db
    .select()
    .from(m)
    .where(and(eq(m.companyId, companyId), eq(m.conversationId, conversationId)))
    .orderBy(asc(m.createdAt), asc(m.id));
}

export function buildInsertMessage(db: ConversationDb, companyId: string, conversationId: string, message: NewStoredMessage) {
  return db
    .insert(m)
    .values({
      id: message.id,
      companyId,
      conversationId,
      role: storedRole(message.role),
      message: message.text ?? "",
      contentType: "text",
      isInternalNote: message.isInternalNote,
      createdAt: message.createdAt,
    })
    .returning();
}

export function buildSetStatus(db: ConversationDb, companyId: string, id: string, status: ConversationStatus, now: Date) {
  return db
    .update(c)
    .set({ status, updatedAt: now })
    .where(and(eq(c.companyId, companyId), eq(c.id, id)))
    .returning();
}

export function buildSetSummary(db: ConversationDb, companyId: string, id: string, summary: string, now: Date) {
  return db
    .update(c)
    .set({ summary, summaryUpdatedAt: now })
    .where(and(eq(c.companyId, companyId), eq(c.id, id)))
    .returning();
}

/** Moves every message of the source conversation to the target. Both ids must be in the company. */
export function buildMoveMessages(db: ConversationDb, companyId: string, sourceId: string, targetId: string) {
  return db
    .update(m)
    .set({ conversationId: targetId })
    .where(and(eq(m.companyId, companyId), eq(m.conversationId, sourceId)))
    .returning({ id: m.id });
}

export function buildMarkMerged(db: ConversationDb, companyId: string, sourceId: string, targetId: string, now: Date) {
  return db
    .update(c)
    .set({ status: "merged", mergedIntoId: targetId, updatedAt: now })
    .where(and(eq(c.companyId, companyId), eq(c.id, sourceId)))
    .returning();
}

export function buildInsertOutboxRow(db: ConversationDb, companyId: string, event: OutboxAppend) {
  return db
    .insert(outbox)
    .values({
      companyId,
      id: randomUUID(),
      topic: event.topic,
      aggregateId: event.aggregateId,
      payload: event.payload,
      dedupeKey: event.dedupeKey,
      status: "pending",
      attempts: 0,
      availableAt: event.availableAt,
    })
    .onConflictDoNothing();
}

/**
 * Search. Status defaults to open, as in the memory store. Free text matches the summary or any text message of the
 * conversation, case-insensitively, through strpos (no LIKE escaping needed).
 */
export function buildSearchConversations(db: ConversationDb, companyId: string, query: ConversationSearchQuery) {
  const conditions: SQL[] = [
    eq(c.companyId, companyId),
    eq(c.status, query.status ?? "open"),
  ];
  if (query.chatbotId !== undefined) conditions.push(eq(c.chatbotId, query.chatbotId));
  if (query.channel !== undefined) conditions.push(eq(c.channel, query.channel));
  if (query.customerId !== undefined) conditions.push(eq(c.customerId, query.customerId));
  if (query.updatedAfter !== undefined) conditions.push(sql`${c.updatedAt} > ${query.updatedAfter}`);
  if (query.after) {
    conditions.push(
      or(
        lt(c.updatedAt, query.after.updatedAt),
        and(eq(c.updatedAt, query.after.updatedAt), lt(c.id, query.after.id)),
      ) as SQL,
    );
  }

  const needle = query.query?.trim().toLowerCase() ?? "";
  if (needle !== "") {
    const msg = alias(m, "search_msg");
    const inMessages = exists(
      db
        .select({ one: sql`1` })
        .from(msg)
        .where(and(
          eq(msg.companyId, companyId),
          eq(msg.conversationId, c.id),
          eq(msg.contentType, "text"),
          sql`strpos(lower(${msg.message}), ${needle}) > 0`,
        )),
    );
    conditions.push(or(sql`strpos(lower(coalesce(${c.summary}, '')), ${needle}) > 0`, inMessages) as SQL);
  }

  return db
    .select()
    .from(c)
    .where(and(...conditions))
    .orderBy(desc(c.updatedAt), desc(c.id))
    .limit(query.limit);
}

// ---------- store ----------

export function createDrizzleConversationStore(db: ConversationDb): ConversationStore {
  const insertOutboxRow = async (tx: ConversationDb, companyId: string, event: OutboxAppend) => {
    await buildInsertOutboxRow(tx, companyId, event);
  };

  return {
    async chatbotBelongsTo(companyId, chatbotId) {
      const rows = await buildChatbotBelongs(db, companyId, chatbotId);
      return rows.length === 1;
    },

    async conversationOfMessage(companyId, messageId) {
      const [row] = await buildConversationOfMessage(db, companyId, messageId);
      return row?.conversationId ?? null;
    },

    async insertConversation(companyId, record, event) {
      return db.transaction(async (raw) => {
        const tx = raw as unknown as ConversationDb;
        const [row] = await tx
          .insert(c)
          .values({
            id: record.id,
            companyId,
            chatbotId: record.chatbotId,
            sessionId: record.externalThreadId ?? `rt-${record.id}`,
            channel: record.channel,
            externalThreadId: record.externalThreadId,
            customerId: record.customerId,
            status: record.status,
            handler: record.handler,
            summary: record.summary,
            summaryUpdatedAt: record.summaryUpdatedAt,
            mergedIntoId: record.mergedIntoId,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })
          .returning();
        await insertOutboxRow(tx, companyId, event);
        return toConversationRecord(row as ConversationRow);
      });
    },

    async findConversation(companyId, id) {
      const [row] = await buildFindConversation(db, companyId, id);
      return row ? toConversationRecord(row) : null;
    },

    async insertMessage(companyId, conversationId, message) {
      return db.transaction(async (raw) => {
        const tx = raw as unknown as ConversationDb;
        const [owner] = await buildFindConversation(tx, companyId, conversationId);
        if (!owner) return null;
        const [row] = await buildInsertMessage(tx, companyId, conversationId, message);
        return toStoredMessage(row as MessageRow);
      });
    },

    async insertReply(companyId, conversationId, reply, enqueueSend) {
      // One unit: the message row, the conversation timestamp and the channel send row commit or roll back together.
      return db.transaction(async (raw) => {
        const tx = raw as unknown as ConversationDb;
        const [owner] = await buildFindConversation(tx, companyId, conversationId);
        if (!owner) return null;
        const [row] = await tx
          .insert(m)
          .values({
            id: reply.id,
            companyId,
            conversationId,
            role: "assistant",
            message: reply.text ?? "",
            contentType: "text",
            isInternalNote: false,
            createdAt: reply.createdAt,
          })
          .returning();
        await tx
          .update(c)
          .set({ updatedAt: reply.createdAt })
          .where(and(eq(c.companyId, companyId), eq(c.id, conversationId)));
        if (enqueueSend) await enqueueSend(tx as unknown as OutboxTx);
        return toStoredMessage(row as MessageRow);
      });
    },

    async listMessages(companyId, conversationId) {
      const rows = await buildListMessages(db, companyId, conversationId);
      return rows.map(toStoredMessage);
    },

    async setStatus(companyId, id, status, now, event) {
      return db.transaction(async (raw) => {
        const tx = raw as unknown as ConversationDb;
        const [row] = await buildSetStatus(tx, companyId, id, status, now);
        if (!row) return null;
        if (event) await insertOutboxRow(tx, companyId, event);
        return toConversationRecord(row as ConversationRow);
      });
    },

    async mergeConversations(companyId, targetId, sourceId, now, event): Promise<MergeOutcome> {
      return db.transaction(async (raw): Promise<MergeOutcome> => {
        const tx = raw as unknown as ConversationDb;
        if (targetId === sourceId) return { kind: "conflict" };

        // Row locks in id order, so two merges that touch the same pair cannot deadlock.
        const pair = await tx
          .select()
          .from(c)
          .where(and(eq(c.companyId, companyId), inArray(c.id, [targetId, sourceId])))
          .orderBy(asc(c.id))
          .for("update");
        const target = pair.find((row) => row.id === targetId);
        const source = pair.find((row) => row.id === sourceId);
        if (!target || !source) return { kind: "conflict" };

        if (source.status === "merged" && source.mergedIntoId === targetId) {
          return {
            kind: "already_merged",
            target: toConversationRecord(target),
            source: toConversationRecord(source),
          };
        }
        if (target.status !== "open" || source.status === "merged") return { kind: "conflict" };

        const moved = await buildMoveMessages(tx, companyId, sourceId, targetId);
        const [nextSource] = await buildMarkMerged(tx, companyId, sourceId, targetId, now);
        const [nextTarget] = await tx
          .update(c)
          .set({ updatedAt: now })
          .where(and(eq(c.companyId, companyId), eq(c.id, targetId)))
          .returning();
        await insertOutboxRow(tx, companyId, event);
        return {
          kind: "merged",
          movedMessages: moved.length,
          target: toConversationRecord(nextTarget as ConversationRow),
          source: toConversationRecord(nextSource as ConversationRow),
        };
      });
    },

    async setSummary(companyId, id, summary, now) {
      const [row] = await buildSetSummary(db, companyId, id, summary, now);
      return row ? toConversationRecord(row) : null;
    },

    async searchConversations(companyId, query) {
      const rows = await buildSearchConversations(db, companyId, query);
      return rows.map((row) => toConversationRecord(row));
    },
  };
}
