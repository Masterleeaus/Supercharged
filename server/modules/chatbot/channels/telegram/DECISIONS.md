# Telegram channel: decisions

Port of extensions/chatbot-telegram (PHP) to server/modules/chatbot/channels/telegram. Recorded 2026-11-08.

## Deviations from the PHP

1. Webhook verification. PHP `verifyWebhook` returned true for every request. Now Telegram's secret-token header
   (`X-Telegram-Bot-Api-Secret-Token`) is compared in constant time against `webhook_secret`. Missing secret: rejected.
2. setWebhook sends `secret_token` (PHP sent no secret). Built as a JSON POST, not a GET with the URL in the query.
3. sendMessage is a JSON POST through the injected HttpClient with a 10 s timeout. PHP used `Http::get` with the token
   and text in the query string, which leaks both into access logs. The token stays in the URL path, which Telegram requires.
4. Error text is redacted (bot token pattern and any credential value removed) and capped at 300 characters.
5. Telegram message ids repeat across chats, so `externalMessageId` is `"<chat.id>:<message_id>"`.
6. Bot senders (`from.is_bot`) are ignored. PHP would have answered them, which can loop.
7. Edited messages and non-message updates are ignored. PHP read only `message`, so the result is the same, but the reason is now recorded.
8. Non-text content is classified (image, audio, video, file, location, unknown) and sent to the runtime. PHP only
   answered "unsupported type" and did not store the attachment.
9. Text limit 4096 characters (Telegram's published sendMessage limit). Over-length text fails; it is not split.
10. Attachments are not sent. `send` returns `unsupported_content` for non-text (PHP sent text only).
11. Rate limit (429) and 5xx are retryable. 401, 403 and other 4xx are not.
12. Outbound idempotency: a claim row is written before the send. A duplicate key returns the stored result, or `queued`
    while the first send is still pending. A failed send releases the claim, so a runtime retry can send again.
    A crash between a successful send and `complete` leaves the key pending. That blocks a re-send, which is the safer failure.

## Expectations of the channel framework (framework.ts not present when written)

- The framework calls `resolveAccount`, then loads credentials, then `verifyWebhook`, then `parseInbound`. Parsing before
  verification is not done here.
- The route layer sets header `x-chatbot-account-id` from the URL path segment, because a Telegram update does not name its bot.
  Verification still uses that account's own secret, so a forged header fails.
- The framework calls `send` with a decrypted credential set for one call only, and does not persist it.

## Change requests against contracts/

- `contracts/channels.ts`: none required. Telegram cannot name its account from the body. The route-layer header above is the workaround.
- Send idempotency is a `SendLedger` port defined in this folder, not in contracts. The runtime (OutboxStorage) should
  either reuse it or confirm it does not also deduplicate, so a key is not double-counted.
- `contracts/flags.ts`: no channel flag exists in CONTRACT_FLAGS. The PHP had only generic extension flags. This provider is
  not gated by a flag. If Jason wants a per-channel kill switch, add `TELEGRAM_CHANNEL_ENABLED` to CONTRACT_FLAGS and gate it in the route layer.

## Not done

- No live Telegram calls. No setWebhook against the real API.
- Media download (`getFile`) is not implemented. The attachment carries the `file_id` only.
- Storage: the accounts and send-key tables are in `db/channels-core.ts`. The draft `db/migrations-draft/0101_channels_telegram_messenger.sql` applies on the local harness. Not promoted.
- Account connect and admin routes are not written. The PHP store controller has no port here.
