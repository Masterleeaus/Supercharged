# Channel framework and WhatsApp: decisions

Port of the WhatsApp channel from `extensions/chatbot-whatsapp/` and the channel contracts from
`extensions/chatbot/System/Contracts/ChannelProviderInterface.php`, `ChatbotChannel.php` and `ChatbotChannelWebhook.php`.
Tests: `tests/modules/chatbot-channels-whatsapp.test.mjs`, 27 of 27 pass.
Scoped strict type check (TypeScript 5.6.3, 11 files, `/home/claude/integration-scratch/tc-channels/tsconfig.json`): passed.

## Deviations from the PHP (behaviour changes)

1. **Webhook verification fails closed.** The PHP `AbstractHttpMessagingProvider::verifyWebhook` returns `true`, and
   `ChatbotTwilioController` only checks that `SmsSid` is present. The port requires a valid `X-Twilio-Signature`
   (HMAC-SHA1, constant-time compare), and rejects when the secret or the callback URL is missing.
2. **Parsing runs only after verification.** The PHP writes the webhook payload to `ext_chatbot_channel_webhooks`
   before anything else. The port has no storage in the channel layer. The runtime stores the parsed result.
3. **Sends are real Twilio calls.** The PHP `TwilioProvider::send` returns a `queued` stub. The port calls the Twilio
   Messages API through the injected `HttpClient` with a 10 second timeout.
4. **Delivery receipts are read.** The PHP never updates `ext_chatbot_messaging_outbound` from Twilio. The port maps
   `sent`, `delivered`, `read`, `failed` and `undelivered` to status events. It also sets `StatusCallback` on each send
   so Twilio calls back to the same URL.
5. **Idempotency.** Twilio has no idempotency header. The provider keeps a bounded in-memory cache of successful sends
   keyed by company, sender and idempotency key. This stops a duplicate call within one process. The durable dedupe is
   the channel outbox (`channels/outbox.ts`).
6. **Non-text inbound is parsed, not refused.** The PHP answers every non-text message with "not supported". The port
   maps image, audio, video, document (to `file`), location and interactive to the shared content kinds. The runtime
   decides what to reply.
7. **Interactive replies carry no text.** Twilio's button label is not mapped, so `text` is null for `interactive`.
   Keeping the label would need a field the shared shape does not have.
8. **Sent-at time.** Twilio does not send a timestamp in the webhook body. `sentAt` is the server receive time.
9. **Timeouts are not retried.** A timeout is ambiguous (Twilio may have accepted the message), so it returns
   `retryable: false`. A network failure returns `retryable: true`.
10. **Unknown exceptions from the HTTP client are not guessed.** Only the contract shapes `timeout` and `network` are
    mapped. Anything else becomes a non-retryable `provider_exception` with fixed text.
11. **Twilio error 63016 maps to `session_window_closed`.** It is not retryable. The runtime should then send a template.
12. **Template sends need a content SID.** `templateName` must be a Twilio content SID (`HX` plus 32 hex). A name is refused
    with `template_not_registered` before any network call. The PHP has no template support.
13. **Account is our WhatsApp number.** On inbound, that is `To`. On a delivery status callback, Twilio sends the customer as
    `To`, so the port reads `From`. The PHP keyed the channel by its row id in the URL. The contract's `resolveAccount` is a
    pure read of the payload, so the number is used instead.
14. **Sandbox channels send from the sandbox number** (`whatsapp_sandbox_phone` when `whatsapp_environment` is `sandbox`), as the PHP did.
15. **Conversation handling is not ported.** The PHP `TwilioConversationService` (human handoff, the `#humanagent` command,
    the 10 minute inactivity close, the unsupported-type reply) is runtime logic. It belongs to the runtime owner. The
    channel layer only parses and sends.
16. **Credentials are encrypted.** The PHP stored them as plain JSON in `ext_chatbot_channels.credentials`. The port seals
    them with `SecretBox`, bound to the company id, in `chatbot_channel_accounts` (see `db/channels-core.ts`).

## Decisions made without asking (review these)

- Credential keys keep the PHP names (`whatsapp_sid`, `whatsapp_token`, `whatsapp_phone`, `whatsapp_sandbox_phone`,
  `whatsapp_environment`) and add `webhook_url`, the exact public URL Twilio calls. Twilio signs that URL, and the webhook
  request does not carry it.
- `maxTextLength` is 1600, which is the documented body limit for Twilio's Messages resource. The Twilio page checked
  does not state a separate WhatsApp limit.
- `sessionWindowHours` is 24, the WhatsApp customer service window.
- The WhatsApp channel flag is `CHATBOT_WHATSAPP_CHANNEL_ENABLED`, read through `readFlag`, default off. The wiring owner
  must check it before mounting the webhook route. The framework does not check it itself.
- The framework rejects a whole parse batch when one result names another kind or account. A provider that mislabels one
  event cannot be trusted with the others.
- Any credential value of four or more characters is redacted from provider text. Shorter values are skipped, so a
  one-letter setting cannot blank out ordinary words.
- Validation of credentials rejects non-snake_case keys, empty values and values over 4096 characters.
- Decrypted credentials are parsed and validated again on load. Any failure returns null.

## Verified facts

- Twilio's signature algorithm (sorted parameters appended to the URL, HMAC-SHA1, base64) matches the Twilio webhook
  security page, which says "sorts these parameters alphabetically and appends them to the URL". The page does not
  print the delimiters or a token-backed vector.
- The known-answer vector in the test (token `12345`, URL `https://mycompany.com/myapp.php?foo=1&bar=2`, the five
  parameters in the test) is recalled from the Twilio SDK test suite. It was not re-fetched in this session. The
  Twilio docs example that the page does print uses a different URL and token from the environment. Treat the test
  vector as a recalled reference and check it against the SDK when someone has the source.
- Twilio's Messages resource accepts `body` up to 1,600 characters (Twilio error 21605 page).

## Change requests against `contracts/` (not made here)

1. `contracts/flags.ts`: `WHATSAPP_CHANNEL: "CHATBOT_WHATSAPP_CHANNEL_ENABLED"` is now in `CONTRACT_FLAGS` (updated 2026-11-09).
   The WhatsApp module still defines the constant itself (`channels/whatsapp/provider.ts`). Once it is in `CONTRACT_FLAGS`, switch to it.
2. `contracts/channels.ts`: the `RawWebhook` now has an optional `url` field (updated 2026-11-09). Twilio's signature needs the full URL. The port takes it
   from `webhook_url` in the stored credentials. A later channel that signs the URL the same way can follow that pattern.
3. `contracts/channels.ts`: `InboundContentKind` has no button label. Interactive replies lose their text. A
   `buttonText` field on `InboundMessage` would fix that.

## Integration pass (2026-11-09)

Scope: framework consolidation, outbox, inbound routers, Messenger challenge hook, table moves.
Tests: `tests/modules/chatbot-channels.test.mjs` (27 pass, one of them against the local harness database),
`tests/modules/chatbot-channels-whatsapp.test.mjs` (27 pass), `tests/modules/chatbot-channels-telegram-messenger.test.mjs` (37 pass).
Scoped strict type check on 48 files passed.

### Placement (resolved)

- Every Drizzle table from this folder is now in `server/modules/chatbot/db/`: `channels-core.ts` (accounts, send keys,
  outbox) and `channels-instagram.ts`. `channels/db-table.ts`, `channels/instagram/db.ts` and the Telegram/Messenger table
  file are removed.
- The channel SQL draft is `db/migrations-draft/0101_channels_telegram_messenger.sql`. It keeps the name that
  `db/harness/migration-order.json` lists. The owner renumbers it at integration. It applies on the local harness (6 of 6 statements).
  `channels/migration-draft.sql` is removed.

### Decisions (review these)

1. One accounts table for every kind: `chatbot_channel_accounts` with `kind`, `account_id`, `sealed`, `status`, `display_name`.
   Telegram and Messenger used another shape (`channel`, `sealed_credentials`). Their stores and tests now use the shared shape.
2. Framework consolidation. Telegram, Messenger and Instagram use the framework's constant-time compare. The framework owns the
   inbound pipeline (`receiveWebhook`), the outbound path (`sendOutbound`) and the challenge (`answerChallenge`).
3. Messenger challenge hook. `answerChallenge` is an optional extension, `ChallengeCapableProvider`. Messenger and Instagram
   implement it. The framework calls it for GET requests after it loads that account's credentials. A null answer is a 403.
4. Outbox. Each outbound message is one row, written by `enqueue(tx, companyId, message)` inside the caller's transaction.
   The same idempotency key writes one row. `drain(companyId, deps)` is the worker. It is safe to run any number of times.
5. Retry limit. A retryable failure backs off 30 s, 60 s, 120 s and so on, capped at 30 min. Five attempts in all, then `failed`.
   A non-retryable failure is `failed` at once.
6. Lease expiry is never resent. A row stuck in `sending` past its 2 minute lease becomes `failed` with `lease_expired`. The
   provider may already have accepted the message. This is at-most-once for that case, and the row stays visible to ops.
7. A `queued` result (the provider's own ledger holds the send) is recorded as sent with no external id. It is never resent.
8. Route paths for the wiring owner to mount: `/api/chatbot/channels/:companyId/whatsapp/webhook` (POST),
   `/api/chatbot/channels/:companyId/telegram/webhook/:accountId` (POST), and `/webhook/:accountId` for messenger and
   instagram (GET for the challenge, POST for events). Routers use `mergeParams`.
9. A rejected request answers 403 with no body. A bad company id answers 404. A store failure after a verified request answers
   500, so the platform retries. A path account that differs from the payload's account answers 403.
10. Raw body. Each POST route reads the exact text with `express.text` at route level. A global JSON parser in front of these
    paths would break signatures. The wiring owner must not add one.
11. The WhatsApp route answers 404 unless `CHATBOT_WHATSAPP_CHANNEL_ENABLED` is exactly "true". It checks before it reads the body.
12. Telegram takes the bot id from the path and overwrites any `x-chatbot-account-id` header the caller sent.
13. Voice and web channel kinds have no provider or route here. They are not in this brief.

### Change requests against `contracts/` (not made here)

- `contracts/channels.ts`: `answerChallenge` is now an optional member of `ChannelProvider` (updated 2026-11-09).
- `contracts/channels.ts`: `RawWebhook` now has an optional request `url` (updated 2026-11-09). Twilio signs the URL (see the WhatsApp section above).
- `contracts/flags.ts`: `WHATSAPP_CHANNEL` is now in `CONTRACT_FLAGS` (updated 2026-11-09).
- `contracts/runtime.ts`: `OutboxStorage` there is the event outbox. This folder's channel outbox has a similar name. Consider renaming the event one.

### Not done here

- `runtime/reply-writer.ts` now passes `enqueue` into the reply transaction (updated 2026-11-09).
- `workers/run.ts` now calls `drain` per company in the `channel_send_drain` job, when `channelOutbox` is wired (updated 2026-11-09).
- The route tests use their own Express app. The wiring owner mounts the routers and runs the mount checks.
- Instagram tables (`db/channels-instagram.ts`) and review tables (`db/reviews.ts`) have no SQL draft yet.
