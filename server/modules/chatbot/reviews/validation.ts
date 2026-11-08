/**
 * Input checks for review submissions. Strict on purpose: a rating must already be a JS number. Form values
 * that arrive as strings are converted by the route layer, not here.
 */
import { REVIEW_COMMENT_MAX_LENGTH, REVIEW_RATING_MAX, REVIEW_RATING_MIN } from "./types.ts";

export type RatingCheck = { ok: true; rating: number } | { ok: false; reason: "rating_invalid" };
export type CommentCheck =
  | { ok: true; comment: string | null }
  | { ok: false; reason: "comment_invalid" | "comment_too_long" };

export function validateRating(value: unknown): RatingCheck {
  if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, reason: "rating_invalid" };
  if (value < REVIEW_RATING_MIN || value > REVIEW_RATING_MAX) return { ok: false, reason: "rating_invalid" };
  return { ok: true, rating: value };
}

/** Optional comment. Empty or whitespace-only becomes null. Length is counted after trimming. */
export function validateComment(value: unknown): CommentCheck {
  if (value === undefined || value === null) return { ok: true, comment: null };
  if (typeof value !== "string") return { ok: false, reason: "comment_invalid" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, comment: null };
  if (trimmed.length > REVIEW_COMMENT_MAX_LENGTH) return { ok: false, reason: "comment_too_long" };
  return { ok: true, comment: trimmed };
}
