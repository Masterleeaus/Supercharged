/*
 * Drizzle adapters for the ops slice: attachment metadata, the analytics source and the export reader.
 * Each query is a builder function. The classes only run the builders, so tests can render the builders to SQL
 * with PgDialect without a database. Builders never execute.
 *
 * Every query filters on company_id, and every builder takes companyId second, after the db handle.
 * Parent tables (chatbot_conversations, chatbot_messages, chatbots) come from shared/schema.ts and are only read.
 */
import { and, asc, eq, gte, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../shared/schema.ts";
import type { AttachmentRecord } from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import { chatbotAttachments } from "../db/ops.ts";
import { chatbotAppointments } from "../db/bookings.ts";
import { chatbotCommerceOrders } from "../db/orders.ts";
import type { AttachmentMetaStore } from "./attachments.ts";
import type { AnalyticsSource, AnalyticsWindow } from "./analytics.ts";
import type { ExportConversation, ExportMessage, ExportReader } from "./export.ts";

const { chatbotConversations, chatbotMessages, chatbots } = schema;

type FullDb = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export function buildInsertAttachment(db: FullDb, companyId: string, record: AttachmentRecord) {
  return db.insert(chatbotAttachments).values({
    companyId: requireCompanyId(companyId),
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    storageKey: record.storageKey,
    createdAt: record.createdAt,
  });
}

export function buildFindAttachment(db: FullDb, companyId: string, attachmentId: string) {
  return db
    .select()
    .from(chatbotAttachments)
    .where(
      and(
        eq(chatbotAttachments.companyId, requireCompanyId(companyId)),
        eq(chatbotAttachments.id, attachmentId),
        isNull(chatbotAttachments.deletedAt),
      ),
    )
    .limit(1);
}

export function buildMarkAttachmentDeleted(db: FullDb, companyId: string, attachmentId: string, at: Date) {
  return db
    .update(chatbotAttachments)
    .set({ deletedAt: at })
    .where(
      and(
        eq(chatbotAttachments.companyId, requireCompanyId(companyId)),
        eq(chatbotAttachments.id, attachmentId),
        isNull(chatbotAttachments.deletedAt),
      ),
    )
    .returning({ id: chatbotAttachments.id });
}

export class DrizzleAttachmentMeta implements AttachmentMetaStore {
  private readonly db: FullDb;

  constructor(db: FullDb) {
    this.db = db;
  }

  async insert(record: AttachmentRecord): Promise<void> {
    await buildInsertAttachment(this.db, record.companyId, record);
  }

  async find(companyId: string, attachmentId: string): Promise<AttachmentRecord | null> {
    const rows = await buildFindAttachment(this.db, companyId, attachmentId);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      storageKey: row.storageKey,
      createdAt: row.createdAt,
    };
  }

  async markDeleted(companyId: string, attachmentId: string, at: Date): Promise<boolean> {
    const rows = await buildMarkAttachmentDeleted(this.db, companyId, attachmentId, at);
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Analytics source
// ---------------------------------------------------------------------------

/** Conversations created in the range, or handed to a human in the range. */
export function buildLoadConversationsWindow(db: FullDb, companyId: string, from: Date, to: Date) {
  return db
    .select({
      id: chatbotConversations.id,
      companyId: chatbotConversations.companyId,
      chatbotId: chatbotConversations.chatbotId,
      channel: chatbotConversations.channel,
      createdAt: chatbotConversations.createdAt,
      connectAgentAt: chatbotConversations.connectAgentAt,
      ticketStatus: chatbotConversations.ticketStatus,
    })
    .from(chatbotConversations)
    .where(
      and(
        eq(chatbotConversations.companyId, requireCompanyId(companyId)),
        or(
          and(gte(chatbotConversations.createdAt, from), lt(chatbotConversations.createdAt, to)),
          and(
            isNotNull(chatbotConversations.connectAgentAt),
            gte(chatbotConversations.connectAgentAt, from),
            lt(chatbotConversations.connectAgentAt, to),
          ),
        ),
      ),
    );
}

export function buildLoadMessagesWindow(db: FullDb, companyId: string, from: Date, to: Date) {
  return db
    .select({
      id: chatbotMessages.id,
      companyId: chatbotMessages.companyId,
      conversationId: chatbotMessages.conversationId,
      role: chatbotMessages.role,
      isInternalNote: chatbotMessages.isInternalNote,
      createdAt: chatbotMessages.createdAt,
    })
    .from(chatbotMessages)
    .where(
      and(
        eq(chatbotMessages.companyId, requireCompanyId(companyId)),
        gte(chatbotMessages.createdAt, from),
        lt(chatbotMessages.createdAt, to),
      ),
    );
}

/**
 * Confirmed appointments created in the range. Read-only over the bookings table: the bookings adapter has no
 * company-wide, date-ranged read, so this ops query filters on company_id itself. Cancelled and waitlisted rows
 * are not counted as bookings.
 */
export function buildLoadBookingRows(db: FullDb, companyId: string, from: Date, to: Date) {
  return db
    .select({ companyId: chatbotAppointments.companyId, createdAt: chatbotAppointments.createdAt })
    .from(chatbotAppointments)
    .where(
      and(
        eq(chatbotAppointments.companyId, requireCompanyId(companyId)),
        eq(chatbotAppointments.status, "confirmed"),
        gte(chatbotAppointments.createdAt, from),
        lt(chatbotAppointments.createdAt, to),
      ),
    );
}

/** Orders placed in the range, excluding cancelled orders. Read-only over the orders table, company_id filtered. */
export function buildLoadOrderRows(db: FullDb, companyId: string, from: Date, to: Date) {
  return db
    .select({ companyId: chatbotCommerceOrders.companyId, placedAt: chatbotCommerceOrders.placedAt })
    .from(chatbotCommerceOrders)
    .where(
      and(
        eq(chatbotCommerceOrders.companyId, requireCompanyId(companyId)),
        ne(chatbotCommerceOrders.status, "cancelled"),
        gte(chatbotCommerceOrders.placedAt, from),
        lt(chatbotCommerceOrders.placedAt, to),
      ),
    );
}

export class DrizzleAnalyticsSource implements AnalyticsSource {
  private readonly db: FullDb;

  constructor(db: FullDb) {
    this.db = db;
  }

  async load(companyId: string, from: Date, to: Date): Promise<AnalyticsWindow> {
    const [conversations, messages, bookingRows, orderRows] = await Promise.all([
      buildLoadConversationsWindow(this.db, companyId, from, to),
      buildLoadMessagesWindow(this.db, companyId, from, to),
      buildLoadBookingRows(this.db, companyId, from, to),
      buildLoadOrderRows(this.db, companyId, from, to),
    ]);
    return { conversations, messages, bookingRows, orderRows };
  }
}

// ---------------------------------------------------------------------------
// Export reader
// ---------------------------------------------------------------------------

export function buildFindExportConversation(db: FullDb, companyId: string, conversationId: string) {
  return db
    .select({
      id: chatbotConversations.id,
      companyId: chatbotConversations.companyId,
      chatbotId: chatbotConversations.chatbotId,
    })
    .from(chatbotConversations)
    .where(
      and(
        eq(chatbotConversations.companyId, requireCompanyId(companyId)),
        eq(chatbotConversations.id, conversationId),
      ),
    )
    .limit(1);
}

export function buildChatbotTitle(db: FullDb, companyId: string, chatbotId: string) {
  return db
    .select({ title: chatbots.title })
    .from(chatbots)
    .where(and(eq(chatbots.companyId, requireCompanyId(companyId)), eq(chatbots.id, chatbotId)))
    .limit(1);
}

/** Internal notes are excluded in the query, not only in code. */
export function buildListExportMessages(db: FullDb, companyId: string, conversationId: string) {
  return db
    .select({
      id: chatbotMessages.id,
      companyId: chatbotMessages.companyId,
      conversationId: chatbotMessages.conversationId,
      role: chatbotMessages.role,
      message: chatbotMessages.message,
      mediaUrl: chatbotMessages.mediaUrl,
      mediaName: chatbotMessages.mediaName,
      isInternalNote: chatbotMessages.isInternalNote,
      createdAt: chatbotMessages.createdAt,
    })
    .from(chatbotMessages)
    .where(
      and(
        eq(chatbotMessages.companyId, requireCompanyId(companyId)),
        eq(chatbotMessages.conversationId, conversationId),
        eq(chatbotMessages.isInternalNote, false),
      ),
    )
    .orderBy(asc(chatbotMessages.createdAt), asc(chatbotMessages.id));
}

export class DrizzleExportReader implements ExportReader {
  private readonly db: FullDb;

  constructor(db: FullDb) {
    this.db = db;
  }

  async findConversation(companyId: string, conversationId: string): Promise<ExportConversation | null> {
    const rows = await buildFindExportConversation(this.db, companyId, conversationId);
    return rows[0] ?? null;
  }

  async chatbotTitle(companyId: string, chatbotId: string): Promise<string | null> {
    const rows = await buildChatbotTitle(this.db, companyId, chatbotId);
    return rows[0]?.title ?? null;
  }

  async listMessages(companyId: string, conversationId: string): Promise<ExportMessage[]> {
    return buildListExportMessages(this.db, companyId, conversationId);
  }
}
