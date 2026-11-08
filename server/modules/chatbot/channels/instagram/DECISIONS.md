# Instagram channel: decisions

Source: `extensions/chatbot-instagram/` (PHP). Date of port: 2026-11-08.

## Behaviour changes from the PHP

1. Webhook POST signature fails closed. The PHP skipped the HMAC check when no app secret was set. Now a missing secret is `credentials_missing`.
2. Channel `verifyWebhook` is real. The PHP `InstagramChannelProvider::verifyWebhook` returned `true` unconditionally. Now it checks the signature and the account id.
3. OAuth state is required and single-use. The PHP callback had no `state` parameter. Now the state is random, stored as a SHA-256 hash with a 10 minute expiry, and consumed once per company.
4. Every entry and every messaging event is parsed. The PHP read only `entry.0.messaging.0`.
5. Outbound echoes (`message.is_echo`) are ignored. The PHP did not check, so the bot could answer its own replies.
6. Tokens are sent in the `Authorization` header or in a form body, never in a URL. The PHP put `access_token` and `client_secret` in query strings.
7. The OAuth exchange uses POST with a form body. Same reason as 6.
8. The stored access token is the Page token from `/me/accounts`, not the user token. Instagram messaging is called with the Page token. Verify this against current Meta docs before go-live.
9. Scopes trimmed to `instagram_basic`, `instagram_manage_messages`, `pages_show_list`, `pages_read_engagement`. Dropped `instagram_content_publish`, `instagram_manage_insights`, `business_management`, which the chatbot does not use.
10. Account lookup searches all pages for one with a connected Instagram account. The PHP took only `data.0`. Only the first page of `/me/accounts` is read; pagination is not followed.
11. Webhook subscription challenge uses constant-time comparison. The PHP used `===`. A missing expected token refuses every request. The PHP default fallback verify token `chatbot-instagram` is removed.
12. Send adds `messaging_type: "RESPONSE"`. Text is refused above 1000 characters, not truncated. Non-text content is refused as unsupported.
13. Credentials (including app secret and verify token) are one JSON object sealed with `SecretBox` under the company id. Only `publicAccountView` leaves the server.
14. Webhook signature and challenge query keys use dotted names (`hub.mode`, `hub.verify_token`, `hub.challenge`), as Meta sends them. The route layer passes the raw query.
15. Token refresh uses `fb_exchange_token` through the injected client. The PHP `refreshAccessToken` had no caller in the audited code, so this is new wiring.

## Not ported here (belongs to the runtime)

- Conversation creation, history rows, human-agent `#humanagent` command, inactivity close, and AI generation (`InstagramConversationService`). The contract says providers do not write storage. The runtime does this from the parsed result.
- Ably panel events. Replaced by the outbox and `EventPublisher` as per CONVENTIONS section 6.
- Outbound customer webhooks (`WebhookDispatcher`). Owned by the runtime.
- Health and metrics services, settings controllers, Blade views, and the channel-store request validator.
- Attachment download. Inbound attachments carry `externalRef` only.

## Placement and scope

- Drizzle tables are in `server/modules/chatbot/db/channels-instagram.ts` (moved in the integration pass).
- No SQL migration draft was written. Same reason. The owner writes it from `db.ts`.
- Feature flag: `CONTRACT_FLAGS` now has `INSTAGRAM_ENABLED` set to `CHATBOT_INSTAGRAM_ENABLED` in `contracts/flags.ts` (updated 2026-11-09). The change request is done (updated 2026-11-09).
- `idempotencyKey` is not forwarded to Meta. Meta has no such header on this endpoint. Dedupe is the runtime's outbox job.
- `framework.ts` did not exist when this was written. The provider implements `ChannelProvider` directly. Expected framework calls: a registry `register(createInstagramProvider())` and a webhook path that calls `resolveAccount`, then `ChannelCredentialSource.load`, then `verifyWebhook`, then `parseInbound`, in that order.
