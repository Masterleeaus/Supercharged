# Messenger channel: decisions

Port of extensions/chatbot-messenger (PHP) to server/modules/chatbot/channels/messenger. Recorded 2026-11-08.

## Deviations from the PHP

1. Every POST is checked against `X-Hub-Signature-256` (HMAC-SHA256 of the exact raw body with `app_secret`, constant-time compare).
   PHP `verifyWebhook` returned true for every request.
2. The subscription challenge reads `hub.mode`, `hub.verify_token` and `hub.challenge`, which is Meta's format. PHP read
   `hub_verify_token` and `hub_challenge` (underscores), which Meta does not send, and it did not check the mode.
   The challenge is returned only when mode is `subscribe` and the token matches `verify_token` in constant time.
3. The challenge is a separate function, `answerMessengerChallenge`. It is not part of ChannelProvider (see change requests).
4. Account = Page id (`entry[].id`). PHP chose the account from the URL path. Events for another page are ignored.
5. Echoes (`message.is_echo`) are ignored. PHP answered its own echoes.
6. Delivery receipts become `delivered` status updates, one per mid. Read receipts (watermark only) are ignored. PHP ignored both.
7. Postbacks are `interactive` messages, with the title as text. PHP did not handle them.
8. Attachments (image, audio, video, file, location) are classified. The URL is the external ref.
9. Send goes to `POST /me/messages` with `messaging_type: RESPONSE`. Token in `Authorization: Bearer`, as in the PHP. Timeout 10 s.
   PHP used curl and returned a boolean (200 only), discarding the Graph error body.
10. Graph version kept at v18.0 from the PHP. Newer versions exist. Not changed here: the owner should confirm the version
    before go-live, since this sandbox has no network access to check the current version.
11. Graph error codes: 4, 17, 32, 613 and HTTP 429 are rate limits (retryable). 190 is an auth failure. 10 is "not allowed"
    (outside the window or not permitted), mapped to `messaging_not_allowed`, not retryable. 5xx is retryable. Other 4xx is not retryable.
    These code meanings come from Meta's published error reference as recalled while writing. They are not checked against live docs.
12. Text limit 2000 characters (Messenger's published text limit, as recalled). Over-length text fails; it is not split.
13. Outbound idempotency: same claim-then-send design as the Telegram channel (see telegram/DECISIONS.md, item 12).
14. Messaging window: `sessionWindowHours: 24`. The provider cannot see the last inbound time. The runtime must check
    the window before send. Outside the window, Graph returns code 10, which is mapped above.
15. The PHP `verify_token` and `access_token` credential names are kept. `app_secret` is new (needed for signatures).

## Expectations of the channel framework (framework.ts not present when written)

- For POST: the framework calls `resolveAccount` (Page id from the body), loads credentials, calls `verifyWebhook`, then `parseInbound`.
- For GET: the framework's `answerChallenge` calls this provider's `answerChallenge` hook (integration pass), which calls `answerMessengerChallenge`. A null result is answered 403.
- The route layer must pass the query keys with their dots intact.

## Change requests against contracts/

- `contracts/channels.ts`: ChannelProvider has no method for the GET subscription challenge. Request an optional
  `answerVerification?(query, credentials)` on ChannelProvider so the framework can route GET requests through the provider.
- `contracts/channels.ts`: `resolveAccount` for Messenger reads the body, which is fine, but the GET challenge has no body. Same request as above.
- `contracts/flags.ts`: no channel flag. See telegram/DECISIONS.md.
- `contracts/channels.ts`: the send ledger is a port in this folder, not in contracts. See telegram/DECISIONS.md, change requests.

## Not done

- No live Graph calls. Page subscription and token exchange are not implemented.
- Profile lookup (`displayName`) is not done. It needs a separate Graph call and is left null.
- Storage: the accounts and send-key tables are in `db/channels-core.ts`. The draft `db/migrations-draft/0101_channels_telegram_messenger.sql` applies on the local harness. Not promoted.
- Account connect and admin routes are not written.
