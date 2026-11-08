/**
 * Review storage: Drizzle implementation plus an in-memory twin for tests. Every read and write takes companyId and
 * filters on it. A row from another company reads as absent.
 *
 * insertReviewWithOutbox writes the review and its outbox event in one transaction. The database unique index on
 * (company_id, conversation_id) makes a second review fail with false, and then nothing is written.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { OutboxEvent } from "../contracts/index.ts";
import { chatbotReviewRequests, chatbotReviews } from "../db/reviews.ts";
import type { Review, ReviewRequest } from "./types.ts";

export type OutboxAppendInput = Omit<OutboxEvent, "id" | "status" | "attempts" | "publishedAt" | "createdAt">;

export interface ReviewStorage {
  /** Returns false when this conversation already has a request. */
  insertRequestIfAbsent(companyId: string, request: ReviewRequest): Promise<boolean>;
  findRequestByTokenHash(companyId: string, tokenHash: string): Promise<ReviewRequest | null>;
  findRequestForConversation(companyId: string, conversationId: string): Promise<ReviewRequest | null>;
  findReviewForConversation(companyId: string, conversationId: string): Promise<Review | null>;
  /** Returns false when the conversation already has a review. In that case no outbox event is written either. */
  insertReviewWithOutbox(companyId: string, review: Review, outbox: OutboxAppendInput): Promise<boolean>;
}

type Db = PgDatabase<any, any, any>;

/** Writes one outbox event inside the caller's transaction. Supplied by the runtime. */
export type AppendOutboxInTx = (
  tx: Db,
  companyId: string,
  event: OutboxAppendInput,
) => Promise<void>;

function toRequest(row: typeof chatbotReviewRequests.$inferSelect): ReviewRequest {
  return {
    companyId: row.companyId,
    id: row.id,
    chatbotId: row.chatbotId,
    conversationId: row.conversationId,
    channel: row.channel,
    status: row.status === "cancelled" ? "cancelled" : "scheduled",
    reason: row.reason,
    dueAt: row.dueAt,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
  };
}

function toReview(row: typeof chatbotReviews.$inferSelect): Review {
  return {
    companyId: row.companyId,
    id: row.id,
    requestId: row.requestId,
    conversationId: row.conversationId,
    chatbotId: row.chatbotId,
    rating: row.rating,
    comment: row.comment,
    submittedAt: row.submittedAt,
  };
}

export class DrizzleReviewStorage implements ReviewStorage {
  readonly db: Db;
  readonly appendOutbox: AppendOutboxInTx;

  constructor(db: Db, appendOutbox: AppendOutboxInTx) {
    this.db = db;
    this.appendOutbox = appendOutbox;
  }

  async insertRequestIfAbsent(companyId: string, request: ReviewRequest): Promise<boolean> {
    requireCompanyId(companyId);
    if (request.companyId !== companyId) throw new Error("company mismatch");
    const rows = await this.db
      .insert(chatbotReviewRequests)
      .values({
        companyId,
        id: request.id,
        chatbotId: request.chatbotId,
        conversationId: request.conversationId,
        channel: request.channel,
        status: request.status,
        reason: request.reason,
        dueAt: request.dueAt,
        tokenHash: request.tokenHash,
        createdAt: request.createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: chatbotReviewRequests.id });
    return rows.length === 1;
  }

  async findRequestByTokenHash(companyId: string, tokenHash: string): Promise<ReviewRequest | null> {
    requireCompanyId(companyId);
    const rows = await this.db
      .select()
      .from(chatbotReviewRequests)
      .where(and(eq(chatbotReviewRequests.companyId, companyId), eq(chatbotReviewRequests.tokenHash, tokenHash)))
      .limit(1);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async findRequestForConversation(companyId: string, conversationId: string): Promise<ReviewRequest | null> {
    requireCompanyId(companyId);
    const rows = await this.db
      .select()
      .from(chatbotReviewRequests)
      .where(
        and(
          eq(chatbotReviewRequests.companyId, companyId),
          eq(chatbotReviewRequests.conversationId, conversationId),
        ),
      )
      .limit(1);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async findReviewForConversation(companyId: string, conversationId: string): Promise<Review | null> {
    requireCompanyId(companyId);
    const rows = await this.db
      .select()
      .from(chatbotReviews)
      .where(and(eq(chatbotReviews.companyId, companyId), eq(chatbotReviews.conversationId, conversationId)))
      .limit(1);
    return rows[0] ? toReview(rows[0]) : null;
  }

  async insertReviewWithOutbox(companyId: string, review: Review, outbox: OutboxAppendInput): Promise<boolean> {
    requireCompanyId(companyId);
    if (review.companyId !== companyId || outbox.companyId !== companyId) throw new Error("company mismatch");
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(chatbotReviews)
        .values({
          companyId,
          id: review.id,
          requestId: review.requestId,
          conversationId: review.conversationId,
          chatbotId: review.chatbotId,
          rating: review.rating,
          comment: review.comment,
          submittedAt: review.submittedAt,
        })
        .onConflictDoNothing()
        .returning({ id: chatbotReviews.id });
      if (rows.length !== 1) return false;
      await this.appendOutbox(tx as unknown as Db, companyId, outbox);
      return true;
    });
  }
}

/** In-memory twin. Enforces the same one-review and one-request rules as the unique indexes. */
export function createMemoryReviewStorage(): ReviewStorage & {
  outboxFor(companyId: string): OutboxAppendInput[];
} {
  const requests: ReviewRequest[] = [];
  const reviews: Review[] = [];
  const outbox: OutboxAppendInput[] = [];
  return {
    async insertRequestIfAbsent(companyId, request) {
      requireCompanyId(companyId);
      if (request.companyId !== companyId) throw new Error("company mismatch");
      const clash = requests.some(
        (row) =>
          row.companyId === companyId &&
          (row.conversationId === request.conversationId || row.tokenHash === request.tokenHash),
      );
      if (clash) return false;
      requests.push({ ...request });
      return true;
    },
    async findRequestByTokenHash(companyId, tokenHash) {
      requireCompanyId(companyId);
      const row = requests.find((item) => item.companyId === companyId && item.tokenHash === tokenHash);
      return row ? { ...row } : null;
    },
    async findRequestForConversation(companyId, conversationId) {
      requireCompanyId(companyId);
      const row = requests.find((item) => item.companyId === companyId && item.conversationId === conversationId);
      return row ? { ...row } : null;
    },
    async findReviewForConversation(companyId, conversationId) {
      requireCompanyId(companyId);
      const row = reviews.find((item) => item.companyId === companyId && item.conversationId === conversationId);
      return row ? { ...row } : null;
    },
    async insertReviewWithOutbox(companyId, review, event) {
      requireCompanyId(companyId);
      if (review.companyId !== companyId || event.companyId !== companyId) throw new Error("company mismatch");
      const exists = reviews.some((item) => item.companyId === companyId && item.conversationId === review.conversationId);
      if (exists) return false;
      reviews.push({ ...review });
      outbox.push({ ...event, payload: { ...event.payload } });
      return true;
    },
    outboxFor(companyId) {
      return outbox.filter((item) => item.companyId === companyId).map((item) => ({ ...item, payload: { ...item.payload } }));
    },
  };
}
