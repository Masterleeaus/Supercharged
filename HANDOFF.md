# Desk chatbot port: COMPLETE package (2026-11-09-r3)

This zip is the whole Desk working tree (desk-review). Extract it and install dependencies as usual.

## What is in it
- Chatbot port under server/modules/chatbot (wiring, workers, secrets, runtime, channels, bookings, widget, realtime, voice, commerce, and more).
- Promoted migrations: migrations/0010a_inbox.sql, 0010b_approvals.sql, 0010c_chatbot.sql. The DRAFT_ originals remain beside them.
- Draft migrations under server/modules/chatbot/db/migrations-draft/ (including 0000_bookings_tables, 0055_conversation_store_columns, 0400_lifecycle).
- Frontend: inbox and admin routes, flag-gated train and channel steps, widget build config (client/vite.widget.config.ts).
- Verification notes: server/modules/chatbot/integration/VERIFICATION*.md and the chatbot DECISIONS files.

## Flags (all default OFF; only the exact value "true" enables)
Server: CHATBOT_BUILDER_ENABLED, CHATBOT_AGENT_ENABLED, CHATBOT_BOOKINGS_ENABLED, CHATBOT_CONTENT_ENABLED, CHATBOT_WIDGET_ENABLED, CHATBOT_CHANNELS_ENABLED, CHATBOT_WORKERS_ENABLED.
Client: VITE_ENABLE_CHATBOT_INBOX, VITE_ENABLE_CHATBOT_ADMIN, VITE_ENABLE_CHATBOT_BUILDER_TRAIN, VITE_ENABLE_CHATBOT_BUILDER_CHANNEL, VITE_ENABLE_CHATBOT_BUILDER_ROUTES.
Secret: CHATBOT_SECRET_KEY (base64, 32 bytes). Required when bookings tokens are used; fails closed.

## Routes (when flags are on)
- /api/chatbot/builder, /api/chatbot/agent, /api/chatbot/bookings, /api/chatbot/content
- /api/public/chatbot/widget
- /api/chatbot/channels/:companyId/<kind>/webhook (whatsapp) and .../webhook/:accountId (telegram, messenger, instagram)
- The core /api/chatbot route is unchanged and always on.

## Migrations: production runner
scripts/run-safe-migration.mjs lists 17 required files, all of which exist in migrations/: 0001 to 0007, 008 and 009 (voice engine), 0010, 0010a, 0011, 0010b, 0013, 0010c, 0014 and 0015. The 0010 group runs in the order 0010, 0010a, 0011, 0010b, 0013, 0010c (owner decision O-08). The optional list is empty. Fresh installs and upgrades run `npm run db:push` and then `npm run db:migrate` (see INSTALLATION.md, Step 6). The DRAFT_ originals in migrations/ are marked superseded and are not run.
The chatbot draft files under server/modules/chatbot/db/migrations-draft/ are not promoted and are not run by the runner. 0400_lifecycle.sql is superseded and creates nothing.
Bookings token CHECK (chatbot_booking_settings_token_chk) was relaxed on 2026-11-09 so the versioned sealed-string form saves. Legacy three-column rows remain valid.

## Decisions made by the owner (see the checklist decision log, 2026-11-08 and 2026-11-09)
- Core /api/chatbot route stays always on.
- hasHumanAgents: true when the company has an active agent-role user (no plan flag exists yet).
- Realtime transport is SSE.
- Sealed secrets use the versioned string format "v<n>:iv:tag:ciphertext"; the key version is the prefix.
- PaymentStatus widened with 'expired'; events structured actions gain 'expired'; proposals expire after 24 hours and the sweep runs in the events worker.
- Order lifecycle history goes into chatbot_commerce_order_events (0400 draft superseded).
- Channel webhook URLs keep the company id in the path.
- Messenger/Instagram GET challenge design confirmed.
- Marketplace spend caps kept: 20% per price change, 500000 minor units per batch.
- Voice demo timer ported (30 seconds per day); voice credit rate still open.
- Calendly tokens carry a key version (v1); key registry built.

## Tests (2026-11-09 r3 sweep)
- 74 chatbot test files: 1638 tests, 1630 passing, 0 failing, 8 skipped (the skipped ones need Postgres and run in the harness).
- Harness (local Postgres 16): all 16 drafts apply; money-gaps suite 35 of 35 after gap-draft.sql is applied; bookings CHECK probe passes for all three valid states and rejects partial IV/tag.
- Widget build (vite, scratch copy): titan-chat.js builds, 13.6 kB; publicDir is off so only the bundle ships.
- Express smoke (scratch copy, no database): server boots to the point of needing a database; route order confirmed for channels (403 from channel router, not 401 from core).

## Known gaps (not fixed in r3; chatbot flags stay OFF by default)
- Agent surface (CHATBOT_AGENT_ENABLED): no staff identity resolver exists, so agent calls answer 401.
- Channels and widget (CHATBOT_CHANNELS_ENABLED, CHATBOT_WIDGET_ENABLED): the reply runtime and receipt store are not wired; they are stubs that refuse requests. Enabling them starts the server but serves no replies.
- CHATBOT_TELEGRAM_CHANNEL_ENABLED is defined in contracts/flags.ts but the telegram router is still gated only by CHATBOT_CHANNELS_ENABLED.
- Workers: the expiry sweep and voice-limits job run only when services are passed to startChatbotWorkers; nothing in server/ constructs the structuredActions or voiceCallLimits services yet.
- Voice-call service: nothing in server/ constructs it yet; use result.voiceCall from mountChatbotModule.
- Webhook dispatch: no caller in server/ yet; the pinned default applies when http is not passed.
- BNPL (commerce/money/bnpl*): status names, webhook body fields, rejected-webhook storage, replay and cancel idempotency differ from the PHP source. Decisions needed.
- Object-form secret writers converted in r3 (calendar-secrets, retry stores, conversational credentials); the Drizzle paths for those were tested with a stand-in db, not Postgres.

## Open items that need the owner
- O-05: voice credit rate (lives in the external Entity driver, not in this upload).
- O-10: Cal.com list-bookings API version (code 2026-05-01; no official source confirmed it; the P4 create and cancel entries have the same gap).
- O-24: confirm the public webhook URL before any provider is configured (decision W-46 recorded).
- BNPL mismatches listed above.
- Demo-seconds limit value for voice_call_demo_seconds_limit.
- Confirm the human-agent rule and the plan field when one exists.

## Not verified
- Channel webhooks against real providers (Telegram, WhatsApp/Twilio, Messenger, Instagram).
- Full Express boot with a database (needs Postgres and seed data).
- Full repo type check (tsc) — not run on this machine; narrow checks only.
