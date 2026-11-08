# Staff reply and handoff HTTP layer: decisions

Slice: `server/modules/chatbot/agent-routes/`. Source: Commerce Crew `ChatbotAgentController.php` (store, closed, conversations, history), plus the `connect_agent_at` toggle in `chatbot-whatsapp/.../TwilioConversationService.php`.

## Files

| File | Role |
| --- | --- |
| `contracts.ts` | Interfaces: `AgentInboxService`, `AgentConversationService`, `CustomerDelivery`. Types for conversation, message, and page. |
| `agent-handlers.ts` | Route logic (no Express). Auth, role, company scope, validation, status mapping. |
| `agent-router.ts` | `createAgentRouter`: Express wiring over the handlers, and the flag gate. |
| `route-table.ts` | Mounted paths. Kept free of Express so tests can read it. |
| `validation.ts` | Strict, hand-written validators for bodies, queries, and ids. |
| `customer-view.ts` | `customerVisibleMessages`: drops internal notes. |
| `memory-services.ts` | In-memory implementation of both services. Tests and local runs only. |
| `flags.ts` | `isAgentRoutesEnabled`, reading `DESK_CHATBOT_AGENT_ROUTES`. |
| `schema.DRAFT.ts` | Two column fragments: `staff_id` on messages, `handler_staff_id` on conversations. |

## Routes

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| GET | `/inbox` | admin, manager, agent | Filters: `handler`, `status`, `search`, `page`, `per_page`. |
| GET | `/conversations/:id` | admin, manager, agent | Staff view. Internal notes are included and flagged. |
| POST | `/conversations/:id/messages` | admin, agent | Body `{ message, isInternalNote? }`. Notes are never delivered. |
| POST | `/conversations/:id/takeover` | admin, agent | Sets handler to `human` and records the staff id. |
| POST | `/conversations/:id/handback` | admin, agent | Sets handler to `ai` and clears the staff id. |
| POST | `/conversations/:id/close` | admin, agent | Sets ticket status to `closed`. |

## Service contracts assumed

The inbox domain is written by another agent. This slice imports nothing from `inbox/`. The integration must adapt its implementation to these interfaces.

- Every method takes `companyId` first. Every implementation must call `requireCompanyId` and filter on it. A conversation outside the company returns `null`, never another tenant's row.
- `AgentInboxService.listInbox(companyId, query) -> { items, page, perPage, total }`.
- `AgentConversationService.getConversation(companyId, id) -> { conversation, messages } | null`.
- `appendStaffMessage(companyId, { conversationId, staffId, message, isInternalNote }) -> AgentMessage | null`. Staff messages are stored with role `assistant` and a `staffId`, as the PHP does.
- `setHandler(companyId, id, "ai" | "human", staffId) -> AgentConversation | null`. The production mapping is `handler = connect_agent_at != null ? "human" : "ai"`.
- `setTicketStatus(companyId, id, "closed", staffId) -> AgentConversation | null`.
- `CustomerDelivery.deliver({ companyId, conversationId, message })`. Out of scope. The default is `NOOP_CUSTOMER_DELIVERY`.

## Decisions for the owner to review

1. **Feature flag.** `DESK_CHATBOT_AGENT_ROUTES` must equal `"true"`. With it off, every path returns 404. The chatbot module reads no env today, so this follows the `DEMO_MODE` / `ENABLE_BULLMQ` pattern in `server/index.ts` and `infrastructure/bullmq`.
2. **Roles.** The PHP has no role split. This slice assumes `admin`, `manager` and `agent` from the auth function. Managers read only. Confirm this matches the Desk role model.
3. **Plan gate not ported.** The PHP middleware calls `ChatbotHelper::planAllowsHumanAgent()` and returns 403 when the plan lacks human agents. The Desk equivalent is not in this slice. Should the flag be joined by a plan check?
4. **Read receipts not ported.** PHP `history` sets `read_at` on every message it returns. This slice's GET does not write read state. Should the staff GET mark messages read, or should a separate endpoint do it?
5. **Takeover and handback are not owner-checked.** Any agent can take over a chat that another agent holds, or hand back a chat they did not take. The PHP does the same. Confirm.
6. **Message text is trimmed before storage.** PHP stores the raw string. Empty and whitespace-only replies are rejected with 400.
7. **Strict input.** Unknown keys in bodies and queries are rejected with 400. This includes `companyId` and `staffId`. The tenancy rule depends on it.
8. **Delivery failure does not roll back.** As in the PHP `try/catch`, the message is saved and the response reports `deliveryFailed: true`. The PHP swallows the error silently. This version also reports it to `onError`.
9. **Close is one-way.** The PHP has no reopen, and this slice does not add one. The PHP also calls the chatbot-review request on close when that extension is installed. That hook is not ported.
10. **Validation without zod.** The Desk routes use zod. This slice uses hand-written validators because `node_modules` is absent, which keeps the tests runnable. Swapping to zod is mechanical if the owner wants one style.

## Not ported

- **Express wiring is not executed in tests.** `express` is in `package.json` but not installed here. `agent-router.ts` has been reviewed by reading only, not executed or type-checked. The tests cover the handlers, and the router is a thin adapter.
- **Transports.** WhatsApp (Twilio), Telegram, and Ably frame events are out of scope. They sit behind `CustomerDelivery`.
- **Demo-mode guard** (`Helper::appIsDemo`). No Desk equivalent.
- **Media upload** on store (multipart, `chatbot-media` disk). Out of scope here.
- **Other controller actions:** `rewriteMessage` (AI rewrite), `notification` and unread counts, canned responses, `pinned`, `name`, `update` (rename and colour), `conversationsHistorySession`, `searchConversation`, and `destroy`. These belong to other slices or are not part of the handoff layer.
- **Migrations.** `migrations/DRAFT_chatbot.sql` is not edited. The schema fragment needs matching SQL for `staff_id` and `handler_staff_id`.

## Verification

`node --test --experimental-transform-types tests/modules/chatbot-agent-routes.test.mjs`: 22 tests, 22 passing. Coverage: internal notes excluded from customer output and never delivered; takeover and handback state changes; company isolation on reads and writes; unauthenticated, malformed-identity, and role rejection; input validation; generic 500 without leaked detail; the flag default.

Note (2026-11-08, Drizzle pass): the plan gate below is now in place, so these 22 tests need `hasHumanAgents: () => true` in their handler deps. Until that edit lands, 6 reply-path tests fail (see the Drizzle section).

## Drizzle

Date: 2026-11-08. Files: `drizzle-services.ts` (store and adapter), `agent-handlers.ts` and `agent-router.ts` (plan gate).

### Plan gate (decision 3 is now implemented)

- `hasHumanAgents(companyId)` is injected through `createAgentHandlers` and `createAgentRouter`. It must return exactly `true` to allow a staff reply or note.
- With no function supplied, every reply is refused with 403. A function that throws, or returns anything other than `true`, also refuses, and the error goes to `onError`.
- The gate runs first inside `postStaffReply`, after authentication and the role check, before the id and body are read. Nothing is stored or delivered on refusal.
- The gate is asked about the authenticated company only.
- Effect on the existing suite: 6 tests in `tests/modules/chatbot-agent-routes.test.mjs` that send replies now get 403. That file is outside this slice, so it was not edited. Supplying `hasHumanAgents: () => true` in its handler deps restores them.

### Adapter: inbox service to agent router

- `createInboxAgentServices({ inbox, store })` builds the two services the router takes.
- `listInbox` calls `inbox.query`. `search` maps to the inbox `q` filter, which matches message text in the Drizzle store. The page keeps its shape.
- `setHandler` calls `handoffToHuman` or `handBackToAi`, then records the staff member. `setTicketStatus` calls the inbox close path. Both keep the inbox rules and events.
- A conversation outside the company, or an unknown one, resolves to `null`, which the router maps to 404. Other inbox errors propagate, and the router maps them as before (for example 503 while the inbox is off).
- The adapter imports only types from `../inbox`. The contract still says the agent slice has no runtime import of the inbox.

### Store

- `createDrizzleAgentStore(db?)` reads and writes the parent tables from `shared/schema.ts` and the side tables in `db/inbox.ts`.
- `appendStaffMessage` runs one transaction: the message (role `assistant`), its author row in `chatbot_inbox_message_staff`, and the conversation activity time (UNVERIFIED against Postgres).
- Customer reads use `buildSelectMessages(..., customerOnly = true)`, which filters `is_internal_note = false` in SQL. `mapCustomerRows` then runs `customerVisibleMessages` again. The staff read keeps notes and flags them.

### Differences and gaps

- **Non-atomic handler change.** The inbox service records the handoff. The staff id is written to the states table afterwards. A crash between the two leaves the handoff without its staff id. The fix is to pass the staff id into the inbox transition. It is not done here because the inbox port would change.
- **`updatedAt` in lists.** The adapter uses the inbox `lastActivityAt` as `updatedAt`, because the inbox row has no `updatedAt`.
- **Search.** Message-text search is kept (the agent contract's meaning). The inbox memory store matches name and summary instead. The two stores differ until the inbox search is aligned.

## Verification (Drizzle)

- `node --test --experimental-transform-types tests/modules/chatbot-inbox-drizzle.test.mjs`: 27 of 27 pass. Covers the plan gate (missing, false, truthy, throwing, true), internal notes on the customer read path, company scope in every generated statement, and the adapter.
- `node --test --experimental-transform-types tests/modules/chatbot-agent-routes.test.mjs`: 16 of 22 pass. The 6 failures are the reply tests described above.
