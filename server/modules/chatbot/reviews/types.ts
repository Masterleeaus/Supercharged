/**
 * Review types. Ratings are integers 1 to 5. One review per conversation, enforced by the database and by the
 * in-memory storage, so a second submission is refused rather than overwritten.
 */
export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;
export const REVIEW_COMMENT_MAX_LENGTH = 2000;
/** Wait after a conversation closes before the review request is due. The PHP extension had no delay. */
export const DEFAULT_REVIEW_DELAY_MINUTES = 60;
export const MAX_REVIEW_DELAY_MINUTES = 7 * 24 * 60;
export const REVIEW_TOKEN_BYTES = 32;

export const REVIEW_TOPICS = {
  requested: "review.requested",
  submitted: "review.submitted",
} as const;

export type ReviewRequestStatus = "scheduled" | "cancelled";

export interface ReviewRequest {
  companyId: string;
  id: string;
  chatbotId: string;
  conversationId: string;
  channel: string;
  status: ReviewRequestStatus;
  reason: string;
  dueAt: Date;
  /** SHA-256 hex of the form token. The raw token is shown to the customer once and never stored. */
  tokenHash: string;
  createdAt: Date;
}

export interface Review {
  companyId: string;
  id: string;
  requestId: string;
  conversationId: string;
  chatbotId: string;
  rating: number;
  comment: string | null;
  submittedAt: Date;
}

export type ReviewRefusal =
  | "review_disabled"
  | "conversation_open"
  | "already_requested"
  | "not_found"
  | "not_due"
  | "cancelled"
  | "rating_invalid"
  | "comment_invalid"
  | "comment_too_long"
  | "already_reviewed";
