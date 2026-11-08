# Chatbot integration: what was joined, what was not

Date: 2026-11-08. Integration pass over the twelve isolated parts (9 server slices and the client builder wizard).

## Summary

- The parts fit at the file and test level. All 11 chatbot test files pass: 277 tests, 0 failing.
- The parts do not yet work end to end. The three HTTP routers (booking, builder, agent) need adapters and a real storage before they can be turned on. No slice has a Drizzle storage. No migration exists.
- Nothing is turned on. Every flag is off by default, and nothing calls the new mount code yet.

## Project rules followed

- `/home/claude/CLAUDE.md` does not exist. The project file `desk-review/CLAUDE.md` was used instead.
- Questions were not asked; sensible defaults were chosen and listed below for review.
- Decisions were recorded in `/home/claude/supercharged-fixes-checklist.md`.
- No full `tsc` was run. Only a scoped check, in a scratch folder.

## 1. Inventory

### Server slices (`server/modules/chatbot/`)

- `bookings/` (has `schema.DRAFT.ts`, test: `chatbot-bookings.test.mjs`). No HTTP router.
- `booking-routes/` (test: `chatbot-booking-routes.test.mjs`). HTTP router. No schema.
- `builder-routes/` (has `schema.DRAFT.ts` and `endpoint-map.md`, test: `chatbot-builder-routes.test.mjs`). HTTP router.
- `agent-routes/` (has `schema.DRAFT.ts`, test: `chatbot-agent-routes.test.mjs`). HTTP router.
- `inbox/` (has `schema.DRAFT.ts`, test: `chatbot-inbox.test.mjs`). No HTTP router.
- `customers/` (has `schema.DRAFT.ts`, test: `chatbot-customers.test.mjs`). No HTTP router.
- `orders/` (has `schema.DRAFT.ts`, test: `chatbot-orders.test.mjs`). No HTTP router.
- `fulfilment/` (has `schema.DRAFT.ts`, test: `chatbot-fulfilment.test.mjs`). No HTTP router.
- `cart/` (has `schema.DRAFT.ts`, test: `chatbot-cart.test.mjs`). No HTTP router.
- Each folder has a `DECISIONS.md`. The builder and agent folders also have their own `flags.ts` or router file.
- Core, already live before this pass: `index.ts`, `chatbot-routes.ts`, `chatbot-service.ts`, `chatbot-storage.ts`, `chatbot-scope.ts`, `conversation-export.ts`, `generative-ui/`, and the root `schema.DRAFT.ts`.

### Other test files

- `tests/modules/chatbot.test.mjs` (core, 33 tests).
- `tests/modules/chatbot-mount.test.mjs` (core mount, 4 tests).
- The 9 slice tests listed above.

### Schema fragments

Nine `schema.DRAFT.ts` files in the slices: bookings (3 tables), builder-routes (1), cart (6), customers (5), fulfilment (8), inbox (3), orders (7). The agent-routes fragment adds two columns, not tables. The bookings fragment also exports booking-assistant columns for `chatbots`. The builder fragment exports builder columns for `chatbots`.

### Client (`client/src/pages/chatbot-builder/`)

- `types.ts`, `api.ts`, `steps.ts`, `wizard-shell.tsx`, `DECISIONS.md`.
- `steps/`: `configure.tsx`, `customize.tsx`, `train.tsx`, `embed.tsx`, `channel.tsx`, and one `.test.md` browser checklist per step.

### Items the slice DECISIONS files say integration must do

- Schema: merge fragments; repoint the parent imports from the old draft to `shared/schema.ts`; promote the staff columns, booking-assistant columns and builder columns onto the parent tables; write the SQL (including the booking `EXCLUDE` constraint on `tstzrange`, and a trigger that blocks edits to `commerce_order_events`).
- Adapters: `agent-routes` needs `AgentInboxService` and `AgentConversationService`. `booking-routes` needs `BookingService`. Neither exists yet (see open issues).
- Storage: a Drizzle version of `BuilderStorage`, `BookingStorage`, `CartStorage`, `CustomerStorage`, `FulfilmentStorage`, `InboxStorage` and `OrderStorage`. Only in-memory versions exist.
- Flags: one consistent rule (see section 6).
- Routes: wire `mount.ts` into the app (owner).
- Transport: the inbox needs a real-time transport chosen by the owner (Ably, SSE, or an outbox).
- Client: the channel step needs two switches changed together; the train step needs its source routes added to `endpoint-map.md`; the embed step needs a Vite env declaration (added, see section 2).

## 2. Changes to shared files

Only these files were changed outside the new integration folder:

- `client/src/App.tsx`. Added an import of `ChatbotWizard` and the route `/app/chatbot-builder/wizard/:id?`, placed after the existing `/app/chatbot-builder` route. The old route is kept.
- `server/modules/chatbot/builder-routes/endpoint-map.md`. Section 3 now lists the storage method names the backend implements. Reason: the contract named methods that were never built (see section 4).
- `client/src/vite-env.d.ts` (new file). One line: `/// <reference types="vite/client" />`. Reason: `steps/embed.tsx` reads `import.meta.env`, and nothing in the client declared it. The embed step's notes asked for this.
- `/home/claude/supercharged-fixes-checklist.md` (outside the repo). Appended a section for this pass.

New files:

- `server/modules/chatbot/integration/schema.DRAFT.ts`
- `server/modules/chatbot/integration/mount.ts`
- `server/modules/chatbot/integration/INTEGRATION.md` (this file)

Not changed: `shared/schema.ts`, `server/routes.ts`, `server/index.ts`, `server/modules/chatbot/index.ts`, `chatbot-routes.ts`, `chatbot-storage.ts`, `client/src/pages/ChatbotBuilder.tsx`, `client/src/pages/chatbot-builder/api.ts`, `migrations/`, `tsconfig.json`.

## 3. Schema (task 2)

- Merged file: `server/modules/chatbot/integration/schema.DRAFT.ts`. It holds 33 new tables, each with `company_id`. It was built by a script that joins the fragments and removes their import lines. The script is in scratch, not the repo.
- Parent tables (`chatbots`, `chatbot_conversations`, `chatbot_messages`) now come from `shared/schema.ts`. The fragments had pointed at the older `server/modules/chatbot/schema.DRAFT.ts`. The shared copies are the ones `chatbot-storage.ts` uses.
- Table-name clashes: none found. No SQL name in the fragments exists in `shared/schema.ts` or anywhere else in the repo.
- Pricing slice: the brief said `commerce_coupons` and `commerce_coupon_usages` might clash with a pricing slice. No pricing fragment exists in this tree. Nothing was renamed. Owner should confirm there is no pricing draft elsewhere.
- Checks: the file loads under drizzle-orm 0.45.2 and lists 33 tables. Every table has a `company_id` column. The scoped type check reports no errors in it.
- Not applied: no migration, no SQL, no change to `shared/schema.ts`.

Columns that still must be added to the promoted parent tables (the merged file exports them as column maps and does not spread them, because `shared/schema.ts` is not edited):

- `chatbot_messages.staff_id` (varchar 64).
- `chatbot_conversations.handler_staff_id` (varchar 64).
- `chatbots`: `is_booking_assistant`, `booking_assistant_conditions`, `booking_assistant_iframe`.
- `chatbots`: the builder fields (about 40), a `builder_settings` JSON column, and `public_uuid`.

## 4. Contract check (task 3)

- Routes: compared `client/src/pages/chatbot-builder/api.ts` with `builder-router.ts`. All five builder paths match: `GET /api/chatbot/builder/:id`, `PATCH /api/chatbot/builder/:id`, `GET` and `POST /api/chatbot/builder/avatars`, `POST /api/chatbot/builder/:id/uploads`. Classic `GET` and `POST /api/chatbot/chatbots` also match.
- Fields: the strict patch schema (`builder-schemas.ts`) has the same keys as `types.ts`. Configure: 15 keys (5 classic plus 10 settings). Customize: 28 keys. Embed: `trustedDomains` only, with `uuid` read-only.
- Create body: the wizard's first-save body (title, language, welcome message, instructions, plus optional `generativeUiEnabled` and `active`) fits the existing strict `createChatbotBody`.
- The only real difference was the storage names. `endpoint-map.md` section 3 named `findChatbot`, `findBuilderSettings`, `updateChatbot`, `updateBuilderSettings` and `insertChatbotAvatar`. The backend implements `findBuilderState`, `updateBuilderState` and `listChatbotAvatars`. The frontend never calls storage, so this was a documentation fix. Section 3 now matches the code. `insertChatbotAvatar` is listed as not yet built.
- `api.ts`: no change needed, so none was made.
- Known 501 responses: `POST /builder/avatars` and `POST /builder/:id/uploads` answer 501 with `{ error: "not_implemented", reason }`. The configure step shows a note for the promo upload. The other 501 cases reach the shell's error alert.

## 5. Promo fields (task 4)

- Promo banner (image, title, description, button label, button link) and suggested prompts (switch and list) are in `ConfigureState`, and only the configure step renders them.
- `CustomizeState` has none of them. `customize.tsx` writes none (its header says so, and a search finds no write).
- The shell's `buildPatch` sends the configure group and the customize group whole. Neither group carries a promo key, so nothing is written twice.
- The backend agrees: the promo keys are in `CONFIGURE_SETTING_KEYS`, and the customize schema is strict, so a promo key sent under customize would get a 400.

## 6. Flags (task 5, full list)

Routers, mounted by `mount.ts` (each router also checks its own flag):

- `ENABLE_CHATBOT_BOOKING_ROUTES`, exact value `"true"`, default off. Read in `booking-routes/router.ts`.
- `ENABLE_CHATBOT_BUILDER_ROUTES`, exact value `"true"`, default off. Read in `builder-routes/builder-router.ts`.
- `DESK_CHATBOT_AGENT_ROUTES`, exact value `"true"`, default off. Read in `agent-routes/flags.ts`.

Services without an HTTP router (flags are read where the service is built; nothing mounts them yet):

- `CHATBOT_BOOKINGS_ENABLED`, exact value `"1"`, default off. `bookings/flags.ts`.
- `CHATBOT_CUSTOMERS_ENABLED`, default off. Accepts `1`, `true`, `yes`, `on`. `customers/customer-service.ts`, through `server/lib/feature-flags.ts`.
- `CHATBOT_CUSTOMER_TAGS_ENABLED`, default off, same rule.
- `CHATBOT_CUSTOMER_MERGE_ENABLED`, default off, same rule. Also needs the customers flag.
- `CHATBOT_FULFILMENT_ENABLED`, exact value `"true"`, default off. `createFulfilmentModule` throws 404 when off.
- `CHATBOT_NATIVE_ORDERS_ENABLED`, exact value `"true"`, default off. `nativeOrdersEnabled` in `orders/index.ts`. `createOrderService` also needs `enabled: true`.
- Cart: `enabled` option, default false, no environment read.
- Inbox: `enabled` option, default false, no environment read.
- Chatbot generative UI: an injected option. Absent means off.

Client:

- `CHANNEL_STEP_ENABLED` in `steps/channel.tsx` (false), and `enabled: false` on the channel entry in `steps.ts`. Both must change together.
- `VITE_CHATBOT_WIDGET_BASE_URL` (optional). Used by the embed snippet.

Existing live path, not gated by any flag:

- `server/routes.ts` line ~1743 calls `registerChatbotModule` with no flag. See open issues.

Inconsistency: the bookings flag accepts only `"1"`. The router flags accept only `"true"`. The customer flags accept four values. Owner should pick one rule.

## 7. Route (task 6)

- `client/src/App.tsx`: `/app/chatbot-builder/wizard/:id?` renders `ChatbotWizard` from `@/pages/chatbot-builder/wizard-shell`.
- The old `/app/chatbot-builder` route is kept.
- Not run in a browser. The optional segment (`:id?`) uses the wouter syntax the builder agent named. Check it on first run.

## 8. Checklist (task 7)

Appended to `/home/claude/supercharged-fixes-checklist.md` under "Added 2026-11-08 (chatbot integration pass)":

- Configure C3, C4, C5, C7, C8.
- Train T1 (source routes missing from the endpoint map).
- Integration decisions: schema source, storage names, mount and flags, route, promo placement.
- Open items: flag rule, `routes.ts` boot path, adapters.

The wizard-contract entries from the builder pass were already present. They were not duplicated.

## 9. Tests (task 8)

Command, per file:

`node --test --experimental-transform-types <file>`

with `NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs"`. The hook resolves `express`, `zod`, `drizzle-orm`, `drizzle-zod` and `pg` from `/home/claude/integration-scratch/deps`. That folder is pinned to the lockfile versions: express 4.22.2, zod 3.25.76, drizzle-orm 0.45.2, drizzle-zod 0.7.1, pg 8.21.0.

Results with the hook:

- `chatbot-agent-routes.test.mjs`: 22 pass, 0 fail.
- `chatbot-booking-routes.test.mjs`: 21 pass, 0 fail.
- `chatbot-bookings.test.mjs`: 38 pass, 0 fail.
- `chatbot-builder-routes.test.mjs`: 26 pass, 0 fail.
- `chatbot-cart.test.mjs`: 19 pass, 0 fail.
- `chatbot-customers.test.mjs`: 27 pass, 0 fail.
- `chatbot-fulfilment.test.mjs`: 20 pass, 0 fail.
- `chatbot-inbox.test.mjs`: 24 pass, 0 fail.
- `chatbot-mount.test.mjs`: 4 pass, 0 fail.
- `chatbot-orders.test.mjs`: 43 pass, 0 fail.
- `chatbot.test.mjs`: 33 pass, 0 fail.
- Total: 277 pass, 0 fail.

Without the hook, the first run failed on import in four files: booking-routes and builder-routes (express or zod missing), mount and core (drizzle-orm missing). The failure was environmental, not code. With the hook and the pinned deps, all four pass.

Scratch checks, not repo files:

- `mount-smoke.mjs`: 4 pass. Flags off mount nothing; wrong flag values stay off; a flag on with no dependency throws; a flag on with a dependency serves `GET /api/chatbot/bookings`.
- `schema-smoke.mjs`: 1 pass. The merged schema loads and lists 33 tables.

Not run: the client `*.test.md` files. They are manual browser checklists.

Environment note: I added packages to `/home/claude/builder-test-deps` with `npm install --no-save` (drizzle-orm, pg, drizzle-zod, `@types/node`). That folder is the builder's hook folder. Its hook still maps only express and zod, so the builder's own runs are unchanged. The pinned deps were then moved to the new scratch folder.

## 10. Type check (task 9)

- Full `tsc`: not run (CLAUDE.md).
- Scoped check: `/home/claude/integration-scratch/tc/tsconfig.json`, TypeScript 5.6.3 (the lockfile version), with `mount.ts` and `schema.DRAFT.ts` as roots. Their imports are checked too.
- `mount.ts`: 0 errors.
- `integration/schema.DRAFT.ts`: 0 errors.
- Slice code, 7 errors:
  - `agent-routes/agent-handlers.ts` lines 114, 135, 172, 184, 196: `.issues` read on the `ParseResult` union from `validation.ts`, which does not narrow under `strict: false`.
  - `booking-routes/router.ts` line 157: `calendarId` is optional in the spread, but `NewBookingInput` requires it.
  - `builder-routes/builder-router.ts` line 161: `splitPatch` returns `Partial<Record<..., unknown>>`, which is not assignable to `BuilderChatbotPatch`.
- `shared/schema.ts`: 311 errors of the form "boolean is not assignable to never", from `createInsertSchema` typing. The file was not changed in this pass. I could not tell whether this comes from the scratch install or from the repo, so it is recorded here and not counted against the slices.
- Not checked: `App.tsx` and the client wizard files. The step agents ran their own scoped checks.

Slice errors were recorded, not fixed, as the brief asked. They are listed under open issues.

## 11. Decisions made for review

1. No rename of `commerce_coupons` or `commerce_coupon_usages`. No clash exists in this tree.
2. The merged schema imports parent tables from `shared/schema.ts`, not from the older draft.
3. Builder and booking routers mount at `/api/chatbot`. The agent router mounts at `/api/chatbot/agent`. The agent path is my choice; the agent DECISIONS did not name one.
4. `mount.ts` fails closed. A flag on with no service or storage throws. There is no in-memory fallback.
5. Booking and builder mounts run the mount's own `authenticate` and `requireCompanyScope` in front of the router, as core does. Mount must run after `registerChatbotModule`, or unmatched `/api/chatbot` paths get a 401 instead of a 404 for anonymous callers.
6. `mount.ts` is not called from `routes.ts` or `server/index.ts`. The owner adds the call. This keeps the flag-off path a no-op.
7. Adapters are not written. Writing them maps different models (see open issues) and needs owner choices.
8. `endpoint-map.md` section 3 follows the code's storage names.
9. `client/src/vite-env.d.ts` added so `embed.tsx` can type-check.
10. Train T1 is logged as a checklist item: the source routes must be added to the endpoint map before the backend is built.

## 12. Open issues for the owner

Blocking:

- The agent router needs `AgentInboxService` and `AgentConversationService`. The inbox module has `query`, `handoffToHuman`, `handBackToAi` and similar methods. It has no `appendStaffMessage`, and it does not expose `getConversation`. The method shapes differ too. An adapter is needed.
- The booking router needs `BookingService` (`listBookings`, `createBooking`, `updateBooking`, `cancelBooking`, and settings). The bookings module has `createCalendar`, `book`, `waitlist`, `cancel`, `promote` and `listAppointments`, around a calendar model. It has no `listBookings`. Status names now match: the router uses `confirmed` (fix pass 2026-11-08, H2), as the bookings module does. An adapter is still needed.
- No Drizzle storage exists for any slice. Only in-memory versions. The builder and agent routers refuse to mount without a supplied store or service.
- No migration. The 33 tables, the four column additions and the constraints need SQL. The booking `EXCLUDE` constraint needs `btree_gist`.
- Storage ownership is not settled. The checklist entry dated 2026-11-08 (LMS tutor integration) says chatbot storage was ported from Drizzle to Prisma and its DRAFT tables promoted in the LMS database. Desk's slices and `chatbot-storage.ts` use Drizzle. Owner must confirm which applies to Desk.

Slice code (recorded, not fixed):

- The seven type errors in section 10.
- Builder server requires only title on save. The client requires title, bubble message, welcome message and instructions. The builder DECISIONS asks the owner whether the server should match.
- Upload routes answer 501 until a multipart parser and file store exist.

Decisions:

- Flag rule: one value for all chatbot flags, or keep the mix. (Section 6.)
- Core chatbot route at `routes.ts` ~1743 is always on. The checklist says default OFF and not yet applied. Owner to decide whether to gate it.
- Inbox transport: Ably, SSE or an outbox table.
- Booking role sets and the Calendly token encryption at rest.
- Channel step: flip `CHANNEL_STEP_ENABLED` and `steps.ts` together, once channel routes exist.
- Train step: source routes need adding to the endpoint map.
- Configure C3 and C5 (save errors that show a note, and whether client link checks block save).
- Commerce coupon names: confirm no pricing draft exists elsewhere.
- Shared-type checks: 311 errors in `shared/schema.ts` under the scratch check. Confirm in the repo's own install.

## 13. Not done

- No zip packages (brief said packaging comes later).
- No change to `shared/schema.ts`, `routes.ts`, `server/index.ts`, or the core chatbot files.
- No browser run of the wizard.
- No full `tsc`.

## Drizzle integration

Date: 2026-11-08. Integration agent for the Drizzle conversion. Scope: make the five slice Drizzle passes work together, and run every chatbot test file. Nothing is applied to a database, no migration was written, and `shared/schema.ts` was not edited. No full `tsc` was run (CLAUDE.md). Decisions are logged with dates in `/home/claude/supercharged-fixes-checklist.md` under "Added 2026-11-08 (chatbot Drizzle integration pass)".

### Result

- 19 chatbot test files, 496 tests, 496 pass, 0 fail.
- The six agent reply tests that failed on the plan gate now pass. The gate itself was not weakened.
- Every test is either a unit test, an in-process HTTP test, or a SQL-rendering test with a recording client. No test has run against a live Postgres.

### Changes, by brief item

1. **Async storage (orders).** `OrderStorage` is async: all 24 methods return a Promise. The in-memory store's methods are `async`. `DrizzleOrderStorage` implements `OrderStorage` directly. `AsyncOrderStorage` is kept as an alias of `OrderStorage` for existing imports. `order-service.ts` is async throughout, and every storage call is awaited. Service methods return Promises, so callers await them. Files: `orders/order-storage.ts`, `orders/order-service.ts`, `db/orders-storage.ts`.
   - Tests updated for the async API: `tests/modules/chatbot-orders.test.mjs` (now 46) and `tests/modules/chatbot-orders-drizzle.test.mjs` (now 32). Service-level throws became `assert.rejects`.
2. **M1 refund guard in the service.** `transitionOrder` now refuses a move to `refunded` when no return of the order has a refund amount above zero. It throws `REFUND_RECORD_REQUIRED` before any storage write. The storage write path keeps its own check as a second line. Tests: three new in `chatbot-orders.test.mjs`. One runs the service on the in-memory storage. One wraps the storage in a spy and proves `updateOrder` is never reached. One proves the move succeeds once a refund is recorded.
3. **Cart transactions.** `cart-service.ts` and `checkout-service.ts` now run each mutation inside `storage.transaction(companyId, tx => ...)`. Every read and write in the callback uses `tx`. Read-only calls (`getCart`, `getCheckout`) are unchanged. An open checkout found past its TTL is marked `expired`, and that write must survive the refusal. So the refusal is returned from the transaction and thrown after it commits. The in-memory `transaction()` is already a per-company serial queue with snapshot rollback, so it was kept as it stood.
   - The keyed lock stays as the default in-process guard (`createCartModule`). A database deployment passes the new `passThroughLock` export (`cart/keyed-lock.ts`), because row locks hold across processes (UNVERIFIED against Postgres).
   - Tests: `chatbot-cart.test.mjs` now 21 (two new: one counts a transaction per mutation, one proves the expiry write survives the refusal). `chatbot-cart-drizzle.test.mjs` unchanged at 27.
4. **Agent plan gate in tests.** `setup()` in `tests/modules/chatbot-agent-routes.test.mjs` passes `hasHumanAgents: () => true` by default, and the option can be overridden. One new test: a reply is refused with 403, and nothing is saved or delivered, for `null`, a function returning `false`, a function returning the string `"true"`, and a function that throws. The test runs `null` rather than `undefined`, because `undefined` would take the default.
5. **One test hook.** The whole suite uses `/home/claude/integration-scratch/hook/register.mjs`. It maps express, zod, drizzle-orm (and its subpaths), drizzle-zod and pg from the lockfile-pinned folder `/home/claude/integration-scratch/deps`. Chatbot code imports `shared/schema.ts` by relative path, so nothing else is needed. `/home/claude/builder-test-deps/register.mjs` lacks drizzle-orm, pg and drizzle-zod, so it is not used for the suite. It was not edited, because other agents use it. Runner: `/home/claude/integration-scratch/run-chatbot-tests.sh`.
6. **Mount.** `integration/mount.ts` now builds the adapters itself.
   - Bookings: `createBookingRoutesService({ service, storage })`. The caller passes the bookings slice service and storage.
   - Agent: `createInboxAgentServices({ inbox, store })`. The caller passes the inbox service and the agent store (`createDrizzleAgentStore()` in production). The plan gate `hasHumanAgents` is passed through. With no gate, every agent reply is refused with 403, and the report says so.
   - Builder: `demoMode` is passed through (default false, the stricter rule).
   - The report has a new field, `agentPlanGate` (true, false or null).
   - Test: `tests/modules/chatbot-integration-mount.test.mjs`, 7 tests. It covers flags off by default, values other than `"true"` staying off, a missing dependency throwing, bookings and builder mounting, and the gate refusing replies before storage is touched.
7. **Duplicate chatbots table.** `db/builder.ts` no longer defines a second `pgTable("chatbots")`. `chatbotBuilderTable` is removed. `builder-routes/builder-storage.ts` reads `builder_settings` and `public_uuid` as SQL identifiers on the shared `chatbots` table. The settings merge is a raw `update` through `db.execute`, because those columns are not on the shared table until the owner promotes `builderChatbotColumns`. The root `server/modules/chatbot/schema.DRAFT.ts` re-exports the shared `chatbots` table instead of defining it. `tests/modules/chatbot-builder-drizzle.test.mjs` updated (14 pass). `shared/schema.ts` was not edited.
8. **Checklist.** Appended under "Added 2026-11-08 (chatbot Drizzle integration pass)". It holds the decisions of this pass and each slice's "Drizzle" section, copied in full.

### Also done (from the brief's decided rules)

- **Flag rule L3.** A flag is on only when its value is exactly `"true"`.
  - Bookings: `CHATBOT_BOOKINGS_ENABLED` was `"1"`. Now `"true"`. `bookings/flags.ts`, `bookings/index.ts`. Tests in `chatbot-bookings.test.mjs` updated.
  - Customers: the three switches accepted 1, true, yes and on. Now only `"true"`. `customers/customer-service.ts` no longer calls the shared `featureEnabled()` in `server/lib/feature-flags.ts`. That helper is not edited, because live modules use it. Test in `chatbot-customers.test.mjs` updated.
  - Already exact `"true"`: `ENABLE_CHATBOT_BOOKING_ROUTES`, `ENABLE_CHATBOT_BUILDER_ROUTES`, `DESK_CHATBOT_AGENT_ROUTES`, `CHATBOT_FULFILMENT_ENABLED`, `CHATBOT_NATIVE_ORDERS_ENABLED`, `VITE_ENABLE_CHATBOT_BUILDER_ROUTES`.
- **Type fixes in files touched by this pass.** `db/orders-storage.ts` `toReturn` casts `requestedResolution`. `builder-routes/builder-storage.ts` `BuilderOps` includes `execute`. Scoped check (`/home/claude/integration-scratch/tc/tsconfig.fix.json`) shows no errors in any file changed in this pass.

### Flags (final)

Routers, each default off, each exact `"true"`:

- `ENABLE_CHATBOT_BOOKING_ROUTES`: booking router, mounted at `/api/chatbot`. Needs `bookings: { service, storage }`.
- `ENABLE_CHATBOT_BUILDER_ROUTES`: builder router, mounted at `/api/chatbot`. Needs `builder: { storage, demoMode }`.
- `DESK_CHATBOT_AGENT_ROUTES`: agent router, mounted at `/api/chatbot/agent`. Needs `agent: { inbox, store, authenticate, hasHumanAgents }`.

Services without an HTTP router, read where the service is built:

- `CHATBOT_BOOKINGS_ENABLED=true` (was `"1"`).
- `CHATBOT_CUSTOMERS_ENABLED`, `CHATBOT_CUSTOMER_TAGS_ENABLED`, `CHATBOT_CUSTOMER_MERGE_ENABLED`, each `"true"` only.
- `CHATBOT_FULFILMENT_ENABLED=true`, `CHATBOT_NATIVE_ORDERS_ENABLED=true`.
- Cart, inbox: `enabled` option, default false. No environment read.
- Client: `VITE_ENABLE_CHATBOT_BUILDER_ROUTES` must match the server flag. `CHANNEL_STEP_ENABLED` in `steps/channel.tsx` must match `enabled` in `steps.ts`.

### Test table (2026-11-08, one run per file)

Command, for each file:

```
NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/<file>
```

Run from `/home/claude/desk-handoff/desk-review`. Run all of them with `/home/claude/integration-scratch/run-chatbot-tests.sh`.

| File | Tests | Pass | Fail |
|---|---|---|---|
| chatbot-agent-routes.test.mjs | 23 | 23 | 0 |
| chatbot-booking-routes.test.mjs | 23 | 23 | 0 |
| chatbot-bookings-drizzle.test.mjs | 56 | 56 | 0 |
| chatbot-bookings.test.mjs | 38 | 38 | 0 |
| chatbot-builder-drizzle.test.mjs | 14 | 14 | 0 |
| chatbot-builder-routes.test.mjs | 36 | 36 | 0 |
| chatbot-cart-drizzle.test.mjs | 27 | 27 | 0 |
| chatbot-cart.test.mjs | 21 | 21 | 0 |
| chatbot-customers-drizzle.test.mjs | 18 | 18 | 0 |
| chatbot-customers.test.mjs | 27 | 27 | 0 |
| chatbot-fulfilment-drizzle.test.mjs | 20 | 20 | 0 |
| chatbot-fulfilment.test.mjs | 20 | 20 | 0 |
| chatbot-inbox-drizzle.test.mjs | 27 | 27 | 0 |
| chatbot-inbox.test.mjs | 24 | 24 | 0 |
| chatbot-integration-mount.test.mjs | 7 | 7 | 0 |
| chatbot-mount.test.mjs | 4 | 4 | 0 |
| chatbot-orders-drizzle.test.mjs | 32 | 32 | 0 |
| chatbot-orders.test.mjs | 46 | 46 | 0 |
| chatbot.test.mjs | 33 | 33 | 0 |
| **Total** | **496** | **496** | **0** |

Before this pass, the same 18 files (before the new mount test file was added) ran 483 tests: 477 pass, and the 6 failures were the agent reply tests that the plan gate refused.

### Decisions made in this pass (for review)

1. The bookings and customer flags now accept only `"true"`. Reverse this if the owner wants the old values.
2. A database deployment passes `passThroughLock`. The in-process keyed lock is the default.
3. The M1 refusal runs in the service, before storage, with the same error text as the storage check.
4. Builder columns are read and written as SQL on the shared `chatbots` table until the owner promotes them.
5. The agent router mounts with no plan gate when none is supplied. It refuses every reply, and the report says so. It does not throw at mount time.
6. The agent path stays `/api/chatbot/agent`.
7. The integration hook is the one hook for the suite.

### Open issues for the owner

- **No live database run.** All Drizzle tests render SQL or use recording clients. The row locks, the partial unique indexes, the EXCLUDE constraint and the `FOR UPDATE` reads are not proven against Postgres.
- **No migrations.** None are written or applied. The owner decides the migration path. Storage ownership is still open: the LMS checklist entry says Prisma, and Desk's slices use Drizzle.
- **Promotion of duplicates.** Table names are defined in several places: each slice's `schema.DRAFT.ts`, the `db/*.ts` Drizzle files, and the merged `integration/schema.DRAFT.ts`. Each table name has at least two definitions. The root `schema.DRAFT.ts` also defines `chatbot_conversations` and `chatbot_messages`, which duplicate `shared/schema.ts`. Only `chatbots` was in the brief, so the others are unchanged. When promoting, keep one set.
- **Builder columns.** `builder_settings` and `public_uuid` must be spread into the promoted `chatbots` definition. Then the raw SQL in `builder-storage.ts` can be replaced by the column objects.
- **M2.** The `approved -> refunded` return edge is kept, because it matches PHP `recordRefund`. The owner must confirm it.
- **M3.** The plan gate is in place, but `hasHumanAgents` must be a real plan lookup. Until one is supplied, agent replies are refused.
- **M4.** Builder create validation is still weaker than the PHP. Not changed.
- **H4.** The core chatbot route at `server/routes.ts` (~1743) is still registered with no flag. Owner decision.
- **Key rotation.** The Calendly token encryption (DZ4) has no key version column, so rotating the key means re-saving every token (DZ5, review).
- **Pre-existing type errors, not changed.** Outside the files this pass touched: 14 lines (`agent-handlers.ts` `.issues` on the parse union (5), `booking-routes/router.ts:170`, `bookings/booking-service.ts` `reason` (3), `builder-router.ts:189`, `cart-storage.ts:428-429` upsert typing (2), `server/db.ts` dotenv and pg typings (2)). `shared/schema.ts` has 311 "never" errors from `createInsertSchema`, also pre-existing.
- **Old hook.** `/home/claude/builder-test-deps/register.mjs` still cannot run the Drizzle tests. Any agent that uses it will see `Cannot find package 'drizzle-orm'`.
- **Client wizard.** Not browser-tested. Its checklist files are manual.

## Fix pass 2 (2026-11-08)

Scope: the four items from verification 2 (H-1, M-B, H-2, item 4). Nothing else changed. Nothing was run against Postgres, and no migration was applied.

- **H-1, refund guard: FIXED (UNVERIFIED against Postgres).**
  - Files: `orders/order-storage.ts` (`transaction`, `findReturnForUpdate`, `findOrderForUpdate`; the memory store gained a serial transaction with rollback; UNVERIFIED against Postgres for the Drizzle path), `db/orders-storage.ts` (`transaction` and the two `FOR UPDATE` reads), `orders/order-service.ts` (`recordRefund` runs in one transaction: lock the return, then the order, check the refunded total on the locked order, write both, append the event).
  - Test: `tests/modules/chatbot-orders-drizzle.test.mjs`, four "H-1" tests. They assert `FOR UPDATE` in the rendered SQL on both rows, the lock order, that both writes sit between `begin` and `commit`, that a refused refund writes nothing and rolls back, and that the memory store rolls back. UNVERIFIED against Postgres.
- **M-B, cart race: FIXED (unverified against Postgres).**
  - Files: `cart/cart-storage.ts` (`insertActiveCartOrFind`, `insertActiveCartIfAbsentQuery`, and the memory version), `cart/cart-service.ts` (`getOrCreateCart` uses it).
  - The index: `db/cart.ts` already has a unique index on `(company_id, conversation_id) WHERE status = 'active'`. The fix uses it as the conflict target. A full unique index on the same columns was not added, because it would stop a conversation from ever having a second cart after the first expires or converts. UNVERIFIED against Postgres.
  - Test: `tests/modules/chatbot-cart-drizzle.test.mjs`, three "M-B" tests. They assert `ON CONFLICT ... DO NOTHING` with the company predicate, a company-scoped `SELECT` after the insert, and that a request which loses the race gets the winner's cart. UNVERIFIED against Postgres.
- **H-2, double-booking guard: FIXED as a draft only (not applied; unverified against Postgres).**
  - File: `db/migrations-draft/0001_bookings_exclusion.sql`. It creates `btree_gist` and an `EXCLUDE USING gist` on `(company_id, calendar_id, blocked_range)` for `status = 'confirmed'`. The brief named `resource_id` and `start_at`/`end_at`, but those columns do not exist in `db/bookings.ts`, so the draft uses the real names.
  - Docs: `bookings/DECISIONS.md` (D9, D16, D38, DZ3, DZ13).
  - Test: `tests/modules/chatbot-bookings-drizzle.test.mjs`, three "H-2" tests. They read the file and check the draft marking, the `btree_gist` extension, the constraint text (company, calendar, range, status filter), and that every column the draft names exists on the table.
- **Item 4, unverified claims: FIXED.**
  - Files: `bookings`, `cart`, `fulfilment`, `orders`, `inbox`, `customers`, `agent-routes` and `builder-routes` `DECISIONS.md`. Every claim now says UNVERIFIED against Postgres. No decision was deleted. Two stale lines were corrected: the orders note that the memory store is the only implementation, and the bookings D16 and D38 notes about the migration and `blocked_range`.
  - Test: `tests/modules/chatbot-bookings-drizzle.test.mjs`, the "item 4" scan. It finds every paragraph in any chatbot `DECISIONS.md` or `INTEGRATION.md` that names a database feature (`FOR UPDATE`, `ON CONFLICT`, row lock, unique index, and similar), and fails if the paragraph has no UNVERIFIED or status marker. The scan works on keywords, so it is a check, not proof.
- **Test totals.** 19 files, 507 of 507 passing, up from 496. Run with `/home/claude/integration-scratch/run-chatbot-tests.sh`, which uses the single hook. No failing test.

Owner decisions still open:
- H-4: gate the core chatbot route at `server/routes.ts` (about line 1743), or keep it always on.
- Plan lookup for `hasHumanAgents`: a production lookup is not supplied, so agent replies are refused until one is.
- M2: keep or remove the `approved -> refunded` return edge (`orders/lifecycle.ts`).
