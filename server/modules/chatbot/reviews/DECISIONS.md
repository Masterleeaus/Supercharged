# Reviews: decisions

Source: `extensions/chatbot-review/` (PHP). Date of port: 2026-11-08.

## Behaviour changes from the PHP

1. One review per conversation. The PHP `submitReview` overwrote the previous review. Now a second submission is refused (`already_reviewed`) and the first is kept. Enforced by a unique index on `(company_id, conversation_id)` and by the in-memory twin. (UNVERIFIED against Postgres.)
2. Rating is an integer 1 to 5. The PHP `ext_chatbot_feedback.score` was an unsigned tinyint with no range rule. Strings are refused. The route layer converts form values.
3. Review requests have a delay after close. Default 60 minutes (`DEFAULT_REVIEW_DELAY_MINUTES`), range 0 to 7 days. The PHP requested the review immediately.
4. The review form is public and needs a token. The raw token (32 random bytes, base64url) is returned once to the caller and never stored. Only its SHA-256 is stored. The form is closed until the request is due.
5. One review request per conversation. The PHP guard was the same, kept.
6. A review is refused until the request is due, and refused once the request is cancelled.
7. Review submission writes the review and its outbox event in one transaction. The outbox event carries ids and the rating, not the comment. (UNVERIFIED against Postgres.)
8. Comments are trimmed. Blank becomes null. Maximum 2000 characters, refused above that rather than truncated.
9. The `review_requested_at` guard in the PHP `requestReview` only checked the chatbot flag and that a date was set. Now the scheduler checks `reviewEnabled`, that the conversation is closed, and that no request exists.

## Not ported

- NPS scoring (`FeedbackRuntime::nps`), complaints, and testimonials. The task brief covered scheduling, the form, storage, and the once-only rule. These can be added as separate kinds later.
- The review config Blade partials and the widget. UI is out of scope.
- Outbound webhooks (`WebhookDispatcher`) and health checks. Owned by the runtime.
- The `ext_chatbot_feedback` table. Replaced by `chatbot_reviews` and `chatbot_review_requests`, which are split by concern.

## Placement and scope

- Drizzle tables are in `server/modules/chatbot/db/reviews.ts` (moved in the integration pass; the old `reviews/db.ts` is removed).
- No SQL migration draft. Owner writes it from `db.ts`.
- Feature flag: `CONTRACT_FLAGS` now has `REVIEWS_ENABLED` set to `CHATBOT_REVIEWS_ENABLED` in `contracts/flags.ts`, so the global switch exists (updated 2026-11-09). The per-chatbot `is_review_enabled` setting already gates scheduling.
- Public form lookup needs the company id in the URL alongside the token. Lookup is by hash inside the company, so a token from one company does not resolve for another.
- `scheduleReviewRequest` does not send the link. The runtime sends it through the channel and uses the returned token.
- `framework.ts` did not exist. This module has no channel dependency.
- Tests: `tests/modules/chatbot-reviews.test.mjs`, 7 pass. (2026-11-09: re-run, 7 of 7 pass, 0 fail. The count is unchanged.) Covers one review per conversation, one request per conversation, company scope, and the unique indexes on the Drizzle tables. (UNVERIFIED against Postgres.)
