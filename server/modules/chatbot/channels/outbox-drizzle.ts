/**
 * Drizzle store for the channel outbox. Every query filters on company_id. The build functions return query
 * builders that tests render with PgDialect, without a database.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ChannelKind } from "../contracts/index.ts";
import { chatbotChannelOutbox } from "../db/channels-core.ts";
import type { ChannelOutboxRow, ChannelOutboxStore, OutboxTx } from "./outbox.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OutboxDb = PgDatabase<any, any, any>;

const t = chatbotChannelOutbox;

export function toOutboxRow(row: typeof t.$inferSelect): ChannelOutboxRow {
  return {
    id: row.id,
    companyId: row.companyId,
    channel: row.channel as ChannelKind,
    accountId: row.accountId,
    recipient: row.recipient,
    contentKind: row.contentKind as ChannelOutboxRow["contentKind"],
    text: row.text,
    attachmentUrl: row.attachmentUrl,
    templateName: row.templateName,
    templateParams: (row.templateParams as Record<string, string> | null) ?? null,
    replyToExternalMessageId: row.replyToExternalMessageId,
    idempotencyKey: row.idempotencyKey,
    status: row.status as ChannelOutboxRow["status"],
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    leaseUntil: row.leaseUntil,
    externalMessageId: row.externalMessageId,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

export function buildEnqueueQuery(db: OutboxDb, row: ChannelOutboxRow) {
  return db
    .insert(t)
    .values({
      id: row.id,
      companyId: row.companyId,
      channel: row.channel,
      accountId: row.accountId,
      recipient: row.recipient,
      contentKind: row.contentKind,
      text: row.text,
      attachmentUrl: row.attachmentUrl,
      templateName: row.templateName,
      templateParams: row.templateParams,
      replyToExternalMessageId: row.replyToExternalMessageId,
      idempotencyKey: row.idempotencyKey,
      status: "pending",
      attempts: 0,
      nextAttemptAt: row.nextAttemptAt,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing({ target: [t.companyId, t.idempotencyKey] })
    .returning();
}

/** Due rows for one company, oldest first, locked so a concurrent worker skips them. */
export function buildClaimPickQuery(db: OutboxDb, companyId: string, now: Date, limit: number) {
  return db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.status, "pending"), lte(t.nextAttemptAt, now)))
    .orderBy(asc(t.nextAttemptAt))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export function buildExpireQuery(db: OutboxDb, companyId: string, now: Date) {
  return db
    .update(t)
    .set({
      status: "failed",
      leaseUntil: null,
      lastErrorCode: "lease_expired",
      lastErrorMessage: "Send lease expired before the outcome was recorded. Not resent.",
    })
    .where(and(eq(t.companyId, companyId), eq(t.status, "sending"), lte(t.leaseUntil, now)))
    .returning({ id: t.id });
}

export function createDrizzleChannelOutboxStore(db: OutboxDb): ChannelOutboxStore {
  return {
    async enqueue(tx: OutboxTx, row) {
      const writer = (tx ?? db) as OutboxDb;
      const inserted = await buildEnqueueQuery(writer, row);
      if (inserted.length > 0) return toOutboxRow(inserted[0] as typeof t.$inferSelect);
      const rows = await writer
        .select()
        .from(t)
        .where(and(eq(t.companyId, row.companyId), eq(t.idempotencyKey, row.idempotencyKey)))
        .limit(1);
      return toOutboxRow(rows[0] as typeof t.$inferSelect);
    },

    async expireStaleLeases(companyId, now) {
      const rows = await buildExpireQuery(db, companyId, now);
      return rows.length;
    },

    async claimDue(companyId, now, limit, leaseUntil) {
      return db.transaction(async (tx) => {
        const picked = await buildClaimPickQuery(tx as unknown as OutboxDb, companyId, now, limit);
        if (picked.length === 0) return [];
        const claimed = await tx
          .update(t)
          .set({ status: "sending", attempts: sql`${t.attempts} + 1`, leaseUntil })
          .where(and(eq(t.companyId, companyId), inArray(t.id, picked.map((item) => item.id))))
          .returning();
        return claimed.map(toOutboxRow);
      });
    },

    async markSent(companyId, id, at, externalMessageId) {
      const rows = await db
        .update(t)
        .set({ status: "sent", sentAt: at, externalMessageId, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null })
        .where(and(eq(t.companyId, companyId), eq(t.id, id), eq(t.status, "sending")))
        .returning({ id: t.id });
      return rows.length === 1;
    },

    async markRetry(companyId, id, nextAttemptAt, errorCode, errorMessage) {
      const rows = await db
        .update(t)
        .set({ status: "pending", nextAttemptAt, leaseUntil: null, lastErrorCode: errorCode, lastErrorMessage: errorMessage })
        .where(and(eq(t.companyId, companyId), eq(t.id, id), eq(t.status, "sending")))
        .returning({ id: t.id });
      return rows.length === 1;
    },

    async markFailed(companyId, id, _at, errorCode, errorMessage) {
      const rows = await db
        .update(t)
        .set({ status: "failed", leaseUntil: null, lastErrorCode: errorCode, lastErrorMessage: errorMessage })
        .where(and(eq(t.companyId, companyId), eq(t.id, id), eq(t.status, "sending")))
        .returning({ id: t.id });
      return rows.length === 1;
    },

    async findByKey(companyId, idempotencyKey) {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.idempotencyKey, idempotencyKey)))
        .limit(1);
      return rows[0] ? toOutboxRow(rows[0]) : null;
    },
  };
}
