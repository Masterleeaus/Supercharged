/**
 * Review flow:
 * 1. scheduleReviewRequest runs when a conversation closes. It creates one request per conversation, due after a
 *    delay. The raw form token is returned once, for the caller to put in the link. Only its hash is stored.
 * 2. getReviewForm shows the form once the request is due. It fails for an unknown, cancelled, not-yet-due or
 *    already-reviewed request.
 * 3. submitReview checks the token, the rating (integer 1 to 5), the optional comment, and that the conversation has
 *    no review yet. It writes the review and an outbox event in one transaction.
 * Every refusal is a value with a reason. Nothing throws for bad customer input. A missing company throws.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  DEFAULT_REVIEW_DELAY_MINUTES,
  MAX_REVIEW_DELAY_MINUTES,
  REVIEW_RATING_MAX,
  REVIEW_RATING_MIN,
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_TOPICS,
  type Review,
  type ReviewRefusal,
  type ReviewRequest,
} from "./types.ts";
import { validateComment, validateRating } from "./validation.ts";
import { hashReviewToken, newReviewToken, tokenHashesMatch } from "./tokens.ts";
import type { ReviewStorage } from "./storage.ts";

export interface ReviewServiceDeps {
  storage: ReviewStorage;
  now: () => Date;
  newId: () => string;
  random?: (size: number) => Uint8Array;
}

export interface ClosedConversation {
  id: string;
  chatbotId: string;
  channel: string;
  /** Null while the conversation is open. */
  closedAt: Date | null;
}

export interface ReviewSettings {
  /** The chatbot's is_review_enabled flag. */
  reviewEnabled: boolean;
  delayMinutes?: number;
}

export type ScheduleResult =
  | { status: "scheduled"; request: ReviewRequest; token: string }
  | { status: "skipped"; reason: ReviewRefusal };

export type FormResult =
  | { ok: true; form: { ratings: number[]; commentMaxLength: number; dueAt: Date } }
  | { ok: false; reason: Extract<ReviewRefusal, "not_found" | "not_due" | "cancelled" | "already_reviewed"> };

export type SubmitResult =
  | { ok: true; reviewId: string; rating: number; submittedAt: Date }
  | { ok: false; reason: ReviewRefusal };

export interface ReviewService {
  scheduleReviewRequest(companyId: string, conversation: ClosedConversation, settings: ReviewSettings): Promise<ScheduleResult>;
  getReviewForm(companyId: string, token: string): Promise<FormResult>;
  submitReview(companyId: string, input: { token: string; rating: unknown; comment?: unknown }): Promise<SubmitResult>;
}

function delayOf(value: number | undefined): number {
  const minutes = value ?? DEFAULT_REVIEW_DELAY_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REVIEW_DELAY_MINUTES) {
    throw new RangeError(`review delay must be a whole number of minutes from 0 to ${MAX_REVIEW_DELAY_MINUTES}`);
  }
  return minutes;
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const { storage } = deps;

  /** Loads a request by token and applies the same checks for the form and for submission. */
  async function requestForToken(
    companyId: string,
    token: string,
  ): Promise<ReviewRequest | null> {
    if (typeof token !== "string" || token.length === 0) return null;
    const tokenHash = hashReviewToken(token);
    const request = await storage.findRequestByTokenHash(companyId, tokenHash);
    if (!request || !tokenHashesMatch(request.tokenHash, tokenHash)) return null;
    return request;
  }

  return {
    async scheduleReviewRequest(companyId, conversation, settings) {
      requireCompanyId(companyId);
      if (!settings.reviewEnabled) return { status: "skipped", reason: "review_disabled" };
      if (conversation.closedAt === null) return { status: "skipped", reason: "conversation_open" };

      const existing = await storage.findRequestForConversation(companyId, conversation.id);
      if (existing) return { status: "skipped", reason: "already_requested" };

      const delay = delayOf(settings.delayMinutes);
      const { token, tokenHash } = newReviewToken(deps.random);
      const now = deps.now();
      const request: ReviewRequest = {
        companyId,
        id: deps.newId(),
        chatbotId: conversation.chatbotId,
        conversationId: conversation.id,
        channel: conversation.channel,
        status: "scheduled",
        reason: "conversation_closed",
        dueAt: new Date(conversation.closedAt.getTime() + delay * 60_000),
        tokenHash,
        createdAt: now,
      };
      const inserted = await storage.insertRequestIfAbsent(companyId, request);
      if (!inserted) return { status: "skipped", reason: "already_requested" };
      return { status: "scheduled", request, token };
    },

    async getReviewForm(companyId, token) {
      requireCompanyId(companyId);
      const request = await requestForToken(companyId, token);
      if (!request) return { ok: false, reason: "not_found" };
      if (request.status === "cancelled") return { ok: false, reason: "cancelled" };
      if (deps.now().getTime() < request.dueAt.getTime()) return { ok: false, reason: "not_due" };
      const review = await storage.findReviewForConversation(companyId, request.conversationId);
      if (review) return { ok: false, reason: "already_reviewed" };
      const ratings: number[] = [];
      for (let value = REVIEW_RATING_MIN; value <= REVIEW_RATING_MAX; value += 1) ratings.push(value);
      return { ok: true, form: { ratings, commentMaxLength: REVIEW_COMMENT_MAX_LENGTH, dueAt: request.dueAt } };
    },

    async submitReview(companyId, input) {
      requireCompanyId(companyId);
      const request = await requestForToken(companyId, input.token);
      if (!request) return { ok: false, reason: "not_found" };
      if (request.status === "cancelled") return { ok: false, reason: "cancelled" };

      const now = deps.now();
      if (now.getTime() < request.dueAt.getTime()) return { ok: false, reason: "not_due" };

      const rating = validateRating(input.rating);
      if (!rating.ok) return { ok: false, reason: rating.reason };
      const comment = validateComment(input.comment);
      if (!comment.ok) return { ok: false, reason: comment.reason };

      // Fast path for a clear message. The unique index is the real guard against two submissions at once.
      const existing = await storage.findReviewForConversation(companyId, request.conversationId);
      if (existing) return { ok: false, reason: "already_reviewed" };

      const review: Review = {
        companyId,
        id: deps.newId(),
        requestId: request.id,
        conversationId: request.conversationId,
        chatbotId: request.chatbotId,
        rating: rating.rating,
        comment: comment.comment,
        submittedAt: now,
      };
      const written = await storage.insertReviewWithOutbox(companyId, review, {
        companyId,
        topic: REVIEW_TOPICS.submitted,
        aggregateId: review.id,
        payload: { conversationId: review.conversationId, chatbotId: review.chatbotId, rating: review.rating },
        dedupeKey: `${REVIEW_TOPICS.submitted}:${companyId}:${review.conversationId}`,
        availableAt: now,
      });
      if (!written) return { ok: false, reason: "already_reviewed" };
      return { ok: true, reviewId: review.id, rating: review.rating, submittedAt: now };
    },
  };
}
