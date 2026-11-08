# Unified inbox port: decisions

Port of the Chatbot Agent unified inbox (`UnifiedInboxService`, `ChatbotParticipant`, `ChatbotPresence`,
`ParticipantRuntime`, `PresenceRuntime`) and the AI/human handoff rule (`connect_agent_at`).
Tests: `tests/modules/chatbot-inbox.test.mjs`, 24 of 24 pass.

## Top open question: the real-time transport (Ably)

The PHP publishes to Ably in two places. `ChatbotForPanelEventAbly` sends to `panel-conversation-{ownerUserId}`,
and `ChatbotForFrameEventAbly` sends to `conversation-session-{sessionId}`. This port does not reproduce Ably.
It defines an `EventPublisher` port and an in-memory recorder. The owner has to choose the transport:

1. Keep Ably. Add a publisher that maps `InboxEvent` to a company-scoped channel.
2. Server-Sent Events or WebSocket from Express, keyed by company.
3. An outbox table with a poller. The chatbot extension already has an `EventOutbox` service (`chatbot/System/Services/EventOutbox.php`).

Channel naming, auth for subscribers and tenant routing depend on this choice. Nothing else in the port changes.

## Existing Desk code checked

- `server/modules/chatbot/chatbot-scope.ts`: `requireCompanyId` is reused as is. Every method calls it first.
- `server/modules/chatbot/schema.DRAFT.ts`: `chatbotConversations.connectAgentAt` already exists, so handoff state is
  reused and not duplicated. The new tables reference it with composite foreign keys.
- `server/modules/inbox/` (omnichannel email and SMS inbox, not mounted): it has the same status vocabulary
  (`open`, `snoozed`, `closed`) and an `Assignee` type. Nothing is imported from it, because its channel set
  (email, sms, whatsapp, web_chat, phone) and its approval-gated send path do not match this web chat inbox.
  **Owner decision:** should web chat threads move into that module as `web_chat` channel threads?
- `server/modules/booking-agent/`: appointment and booking code. Nothing in the inbox source touches booking, so
  no reuse was needed.
- Feature flags: the chatbot module reads no env (its `generativeUi` is an injected option, and absent means off).
  The inbox follows that pattern. `enabled` is an option, it defaults to `false`, and every method refuses with 503
  while it is off. Nothing reads `process.env`.

## Decisions for owner review

1. **Handler is derived.** `ai` when `connectAgentAt` is null, `human` otherwise. Handback sets it to null. The PHP
   close path (`TwilioConversationService`) does the same.
2. **Handoff and handback are conditional writes.** `transitionHandler` checks and writes in one step, so two concurrent
   takeovers cannot both emit an event. A repeat call returns `changed: false` and emits nothing.
3. **Assignee and priority live in a side table** (`chatbot_inbox_conversation_states`). The Desk conversation table has
   neither column, and `shared/schema.ts` is not edited. The integration agent can fold them into
   `chatbot_conversations` instead.
4. **Priority values are `low`, `normal`, `high`, `urgent`.** These come from the sibling customer-communications
   module. The PHP column is a free `string(32)` with default `normal`.
5. **Ticket status is `new` or `closed`.** `deleted` exists in PHP but is not used by the inbox query, so it is not ported.
6. **Snooze is not ported.** The inbox source has no snoozed state. The existing `server/modules/inbox/` has one, but
   it is not used here.
7. **Message cursor is `(createdAt, id)`.** PHP compares integer history ids. Desk message ids are UUIDs, so ordering
   uses the timestamp, with id as the tie-break.
8. **Unread semantics.** Participant unread counts every message after the cursor, including assistant messages and
   internal notes. That matches PHP. The per-company badge counts (`agent`, `ai`, `all`) count conversations that have
   an unread inbound message, meaning role `user`, not an internal note, with `readAt` null. That matches the PHP list
   filter. **Question:** should a staff participant's own messages and notes stop counting as unread?
9. **Offline is excluded from the active presence list.** PHP included it, which looked wrong, so this is a deliberate
   change.
10. **Presence events fire only on a state change.** A heartbeat with the same state emits nothing. PHP emitted no
    presence events.
11. **Presence window.** Default 120 seconds, with a 15 second floor, both as in PHP. PHP reads `CHATBOT_PRESENCE_TTL`
    from config. Here the value is injected as `presenceTtlSeconds`, and the integration agent decides where it comes from.
12. **LIKE wildcards are escaped.** PHP passed `%` and `_` straight into the LIKE pattern. This port matches the search
    text literally.
13. **Publisher failures do not roll back.** Matches the PHP try/catch around Ably. The error goes to `onPublishError`.
14. **Null references match null.** PHP `updateOrCreate` matches `IS NULL`, so reference-less participants are keyed by
    type. The Drizzle draft is meant to enforce that with `coalesce(reference, '')` in a unique index (UNVERIFIED against Postgres).
15. **Validation.** Bad input returns 422. A conversation or participant that is not in the caller's company returns 404,
    never 403, so one company cannot probe another's ids.
16. **Pagination.** Default 30 per page, maximum 100.

## Not ported

- `ChatbotForPanelEventAbly` and `ChatbotForFrameEventAbly`: Ably is out of scope (see the top question).
- `UnifiedInboxService::note`, `translate` and `draft`: `note` is a simple insert and can be added later. `translate` and
  `draft` call the AI runtime, which is out of scope.
- Label tables from migration `2026_07_21_020001_upgrade_unified_inbox`: `ext_chatbot_inbox_labels` and the join table.
  They were not in the brief, so they are a follow-up.
- Customer tags (`ChatbotCustomerTagController`), `sla_due_at`, `archived_at`, `merged_into_id` and `pinned` ordering.
- `ConversationContext` (chatbot-ecommerce): this is the commerce context stack for product references and approval
  tokens. It is not inbox handoff state, so there was nothing to port here.
- A Drizzle `InboxStorage` adapter. The schema is still a DRAFT, and nothing has been run against a database.

## Verification

- `node --test --experimental-transform-types tests/modules/chatbot-inbox.test.mjs`: 24 of 24 pass.
- The project type check (`npm run check`) was not run, because `node_modules` is empty in this checkout.
  A scratch `tsc` run on the inbox files reports only the missing Node type definitions, which are environmental.
- `schema.DRAFT.ts` has not been type-checked against drizzle-orm. Confirm the `coalesce()` unique index on the installed version.

## Drizzle

Date: 2026-11-08. Files: `server/modules/chatbot/inbox/drizzle-storage.ts`, `server/modules/chatbot/db/inbox.ts`.
Tests: `tests/modules/chatbot-inbox-drizzle.test.mjs`, 27 of 27 pass (the queries are rendered to SQL, never run).

- **Storage.** `createDrizzleInboxStorage(db?)` implements the same `InboxStorage` port. Without an argument it loads `server/db.ts` on first use, so importing never connects. The in-memory store is unchanged.
- **Builders.** Each query is an exported builder. Methods run the builders. The tests render them with `PgDialect`.
- **Tables** (`db/inbox.ts`, not in `shared/schema.ts`, no migration): `chatbot_inbox_conversation_states` (assignee, priority, handler staff), `chatbot_inbox_participants`, `chatbot_inbox_presence`, `chatbot_inbox_message_staff`. The parent tables come from `shared/schema.ts`.
- **Handler staff id** is on the states table, not on `chatbot_conversations`, because `shared/schema.ts` has no `handler_staff_id` yet. Message author ids sit in `chatbot_inbox_message_staff` for the same reason. Fold both into the parent tables when the integration pass promotes the columns.
- **Company scope.** Every method calls `requireCompanyId` first (403 when missing). Every statement carries `company_id`. Participant and presence writes use `company_id` in their conflict target or in `setWhere`, so a row from another company is never overwritten (UNVERIFIED against Postgres).
- **Handoff.** The takeover and handback updates are conditional (`connect_agent_at IS NULL` or `IS NOT NULL`), so two concurrent takeovers cannot both report applied, as in the memory store (UNVERIFIED against Postgres).
- **Priority** reads as `normal` when no states row exists.
- **Search (`q`).** `name` and `summary` do not exist on `chatbot_conversations`, so they read as null. The Drizzle `q` filter matches message text instead (`strpos`, case-folded, literal). This is a behaviour difference from the memory store, which matches name and summary. It is the search the staff agent contract describes.
- **Timestamps.** The cursor compares `date_trunc('milliseconds', created_at)` with ISO strings cast to `timestamp`. A cursor taken from a JS `Date` still matches its own row. Assumes the server runs in UTC, as the other chatbot tables do.
- **Cursor order** follows the database collation for message ids. The memory store uses JS string order. Both are stable within one store.
- **Participants** are listed by type, then display name, in SQL. The memory store uses `localeCompare` for the name.
- **Not atomic.** `saveConversationState` runs up to three statements. Only the appendStaffMessage path uses a transaction.

## Verification (Drizzle)

- `node --test --experimental-transform-types tests/modules/chatbot-inbox-drizzle.test.mjs` with `NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs"` (drizzle-orm and pg are not in `builder-test-deps`): 27 of 27 pass.
- Scoped `tsc` on the new files: no errors in them. The only errors shown come from `server/db.ts` (dotenv, pg types) and from `agent-handlers.ts`, which predate this change.
