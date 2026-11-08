# Verification 2: chatbot Drizzle integration (Desk)

Verifier: second independent pass, 2026-11-08. The verifier did not write this code and did not edit any source file. The only file written is this one. Scratch scripts are in `/tmp/verify-scratch/` (outside the repo).

Rules followed: `desk-review/CLAUDE.md` read first. No full `tsc` run. No questions asked. Line numbers are from the files as they stood at the time of this pass.

Inputs read: `INTEGRATION.md` (section "Drizzle integration"), `VERIFICATION.md` (first pass, with its "Fix pass" section), and the code paths below.

## 1. Result

Critical: 0. High: 4. Medium: 7. Low: 9. New regressions: 1 (M-B).

Nothing was found that leaks one company's rows. Every SQL statement rendered from the Drizzle storages carries a `company_id` predicate with the company id as a bound parameter. The Calendly token is sealed before any query and is not logged. But the Drizzle pass is not ready for Postgres. The main problems are a refund path with no transaction or lock, a double-booking guard that exists only in comments, builder SQL that names columns no migration creates, and a core chatbot route that is still ungated.

Verdict per area:

- Tenancy in Drizzle storages: PASS WITH ISSUES. All 44 rendered statements are scoped. Issues: global `id` primary keys on 20 tables (M-A), and no live Postgres run.
- Money and time: PASS WITH ISSUES. Integer minor units everywhere, no float. Refund ceiling race is in the transactions area (H-1).
- Secrets (Calendly): PASS WITH ISSUES. Encrypted at rest on the Drizzle path, never returned, never logged. Issues: no key version (M-E), stale doc (M-F).
- Plan gate: PASS WITH ISSUES. Refuses unless `hasHumanAgents` returns exactly `true`, with real tests. Production lookup not supplied, and the mount is not called (M-H).
- Refund guard: FAIL. `transitionOrder` now guards `refunded` (fixed). But `partially_refunded` has no guard (M-C), and `recordRefund` writes two rows with no transaction (H-1).
- Transactions and locks: FAIL. Cart and checkout are correct (verified). Orders refund path has no transaction or lock (H-1). Cart first-create race is a new regression (M-B).
- Flags: PASS WITH ISSUES. Every flag reads exactly `"true"`. Routers are off by default. Core route still ungated (H-4).
- Frontend: PASS WITH ISSUES. Train and channel steps hidden. Uploads answer 501. API calls match mounted routes. Not browser-tested.
- Tests: PASS WITH ISSUES. 19 files, 496 of 496 pass with the hook. Several tests check SQL shape only (see section 6).
- Unverified claims: FAIL. Three code comments and one decision note say protection exists that has no migration or runtime path (section 5).

## 2. First-pass items re-checked

- H1 (train step calls missing routes): FIXED. Train entry has `enabled: false` (`client/src/pages/chatbot-builder/steps.ts:32`). The wizard filters it out (`wizard-shell.tsx:42`), and `?step=train` falls back to the first visible step (`wizard-shell.tsx:159`). The `/sources` calls remain in `steps/train.tsx` and would 404 if the step were enabled.
- H2 (`booked` wire status): FIXED. No `"booked"` left in `booking-routes/`. New bookings use `confirmed`.
- H3 (Calendly token returned over HTTP): FIXED. Router strips the token from whatever the service returns (`booking-routes/router.ts:68-74`). Adapter returns presence only (`booking-routes/bookings-adapter.ts:176-190`). Drizzle storage seals the token (`bookings/drizzle-booking-storage.ts:468-476`). The leak test uses a service that does return the token, so it is a real test. The stale plaintext note remains (M-F).
- H4 (core chatbot route ungated): STILL OPEN. `server/routes.ts:1743`. Owner decision.
- M1 (`transitionOrder` allows `refunded` without a record): FIXED for `refunded`. Service check at `orders/order-service.ts:435-437`, storage check at `db/orders-storage.ts:206-222`. The `partially_refunded` path is still open (M-C).
- M2 (`approved` to `refunded` edge): STILL OPEN. `orders/lifecycle.ts:54`. Owner decision.
- M3 (agent plan gate not ported): FIXED in code. Gate at `agent-routes/agent-handlers.ts:87-95` and `:153`. Tested over HTTP (`tests/modules/chatbot-integration-mount.test.mjs:90-125`). No production lookup is supplied yet (M-H).
- M4 (builder create validation weaker than PHP): STILL OPEN. `builder-routes/builder-schemas.ts` unchanged. Owner decision.
- M5 (booking router defaults to allow-all): FIXED. Both routers refuse with 403 when `requireRole` is missing (`booking-routes/router.ts:100`, `builder-routes/builder-router.ts:81`).
- M6 (wizard route not flag-gated): FIXED. `client/src/App.tsx:358` and `:828`. Client flag is a build-time Vite variable, so it must match the server flag.
- M7 (locks in one process only): FIXED for the Drizzle path, with a new issue (M-B). Cart and checkout run `FOR UPDATE` in `storage.transaction`.
- M8 (SQL tenancy unverified): PARTLY. Rendered 44 statements and ran a schema scan. No live Postgres run, so still UNVERIFIED.
- M9 (router tests use hand-written services): STILL OPEN. The new leak test is an improvement but the pattern remains.
- M10 (internal-note rule only in handler): PARTLY FIXED. The Drizzle customer read drops notes in SQL (`agent-routes/drizzle-services.ts`, `buildSelectMessages` with `customerOnly`). New readers still need to use it.
- L1 (quantity rejected, not clamped): STILL OPEN. Recorded decision.
- L2 (duplicate-id check spans all companies): STILL OPEN, test helper only (`agent-routes/memory-services.ts:79`).
- L3 (flag value rules differ by slice): FIXED. All flags now exact `"true"`. See L-J for the behaviour change this causes.
- L4 (uploads answer 501): UNCHANGED, and still 501 (`builder-routes/builder-router.ts:120`, `:203`).
- L5 (conversation export in UTC): UNCHANGED.
- L6 (inbox has no real-time transport): UNCHANGED.
- L7 (`/home/claude/CLAUDE.md` missing): not a code item.

## 3. Findings

### Critical

None found. Reason: every chatbot-table statement rendered in this pass carries `company_id` and the scope id (see section 4). Some storage methods were read by pattern, not line by line (noted in section 7).

### High

**H-1. Recording a refund is not atomic and not locked. Concurrent refunds can exceed the ceiling.**
- File: `server/modules/chatbot/orders/order-service.ts`, `recordRefund`, lines 608-649.
- Reads the return and order (lines 611-621), then checks the ceiling against that stale read (lines 623-631). Then it writes the return (line 641) and the order (line 647) as two separate statements. There is no `transaction(` and no lock in `order-service.ts` (grep confirms).
- Effect: two refunds at the same time can both pass the ceiling check. A failure between the two writes leaves the return marked refunded and the order not updated.
- The decision file admits this (`orders/DECISIONS.md:79`). It is not fixed.

**H-2. The double-booking "last line of defence" does not exist.**
- Files: `server/modules/chatbot/db/bookings.ts:10-21` (header describes an `EXCLUDE` constraint), `bookings/drizzle-booking-storage.ts:9` (says the EXCLUDE "in the migration" stops double booking).
- No migration in `migrations/` contains an EXCLUDE on `chatbot_appointments`. The `btree_gist` extension is not created anywhere. The `blocked_range` column is written but nothing reads it as a constraint.
- Only the application check protects against double booking: a calendar row lock (`bookings/drizzle-booking-storage.ts:124-131`, `FOR UPDATE`, confirmed by render) plus a conflict read inside the same transaction (`:396-404`, `:425-438`). That is sound under READ COMMITTED, but any writer that bypasses the storage can double-book.
- Also `bookings/drizzle-booking-storage.ts:433`: `transitionAppointment` skips the overlap check when `calendar` is missing (`&& calendar`). Low risk because the FK makes it unlikely, but it fails open.
- Status: UNVERIFIED against Postgres. Claim is false until the migration exists.

**H-3. Builder storage writes columns that no schema or migration defines.**
- File: `server/modules/chatbot/builder-routes/builder-storage.ts`. Raw column names at line 188 (`builder_settings`, `public_uuid` read) and line 210 (`builder_settings` merge, raw `update`).
- `shared/schema.ts` has no `builder_settings` or `public_uuid`. `migrations/` has none either (grep returns nothing).
- Effect: the first builder save against a real database fails with an unknown-column error. The integration doc says this (INTEGRATION.md, item 7), but the code does not block it.

**H-4. The core chatbot route is registered with no flag.**
- File: `server/routes.ts:1743`. Carried from the first pass. Still open. Owner decision.

### Medium

**M-A. Twenty tables use a global `id` primary key, not `(company_id, id)`.**
- Headers say primary keys are `(company_id, id)`. That is false for these tables:
  - Bookings: `db/bookings.ts:57, 79, 122, 148`.
  - Customers: `db/customers.ts:19, 52, 107, 125`.
  - Orders: `db/orders.ts:21, 70, 106, 132, 169, 199, 235`.
  - Inbox: `db/inbox.ts:46`.
  - Fulfilment: `db/fulfilment.ts:53, 224`.
  - Builder: `db/builder.ts:30`.
  - Cart: `db/cart.ts:103`.
- Composite FKs still work, because each parent has a unique `(company_id, id)` index. But one upsert keys on `id` alone (`inbox/drizzle-storage.ts:355-374`), and it is safe only because of `setWhere` on line 373.
- Four tables have no primary key at all: `chatbot_customer_conversations` (`db/customers.ts:80`), `chatbot_inbox_conversation_states` (`db/inbox.ts:22`), `chatbot_inbox_message_staff` (`db/inbox.ts:100`), `chatbot_inbox_presence` (`db/inbox.ts:78`). They have unique indexes, so the upserts work.

**M-B. NEW REGRESSION. Concurrent first requests for one conversation can fail instead of sharing a cart.**
- Files: `server/modules/chatbot/cart/cart-storage.ts:596-598` (`findActiveCart` reads without a lock), `cart/cart-service.ts:224-226` (`getOrCreateCart`), `cart/index.ts:45` and `cart/keyed-lock.ts:36` (`passThroughLock`).
- Before the Drizzle pass, the in-process keyed lock serialized this. With `passThroughLock` (the documented database setting), two first requests both see no active cart. Both insert. The partial unique index rejects the second, and `mapCartDatabaseError` turns it into a `conflict` error (`cart-storage.ts:233-238`).
- Effect: a visible error on first contact under concurrency, instead of the same cart returned. Not a data leak.

**M-C. `partially_refunded` can be set with no refund record.**
- File: `orders/order-service.ts:425-437`. The guard only covers `refunded`. `orders/lifecycle.ts:39` allows `confirmed` to `partially_refunded` directly.
- Same class as M1. The decision file asks the owner (`orders/DECISIONS.md:49`), and the decision note is stale because it still says M1 is open.

**M-D. Order event sequence collides under concurrency, with no retry.**
- File: `db/orders-storage.ts:337-340`. Sequence is `max + 1` in a subquery, guarded by the unique `(company_id, sequence)` index (`db/orders.ts:119`).
- Concurrent appends raise a raw 23505. Nothing maps it or retries. Events are also not written in the same transaction as the change they record.

**M-E. Calendly token key rotation needs a re-save of every token.**
- Files: `bookings/secret-box.ts` header, `db/bookings.ts:150-152`. No key version is stored. Carried from DZ4/DZ5. Owner decision.

**M-F. Stale or wrong documentation.**
- `booking-routes/DECISIONS.md:57` says the token is stored in plaintext. The Drizzle storage seals it.
- `orders/DECISIONS.md:49` says M1 is open. It is fixed for `refunded`.
- `db/fulfilment.ts` header says primary keys are `(company_id, id)`. Stock and items use global ids (M-A).
- `db/bookings.ts:10` says double booking is stopped in two layers. Layer two does not exist (H-2).

**M-G. Mount is not called anywhere.**
- `mountChatbotSlices` (`integration/mount.ts`) is not called from `server/routes.ts` or any other server file (grep). So the three new routers, the agent plan gate and their flags are unreachable. This is a state, not a defect, but the owner must decide where it is called. Owner decision.

### Low

- **L-A.** `bookings/drizzle-booking-storage.ts:351-355`: `isOverlapViolation` maps every 23505 to "overlap", including other unique violations.
- **L-B.** `bookings/drizzle-booking-storage.ts:433`: overlap check skipped when calendar row missing (see H-2).
- **L-C.** `inbox/drizzle-storage.ts:355-374`: a participant id that belongs to another company returns zero rows. Caller must treat zero rows as "not found". Not checked in the service.
- **L-D.** `cart/index.ts:11` and `:30`: "passThroughLock only with a database" is documented but not enforced in code. `passThroughLock` is exported and unused by any caller today.
- **L-E.** `db/orders.ts` and `db/cart.ts`: money columns are `bigint` read as JS `number`. Values above 2^53 lose precision. Not reachable at current limits.
- **L-F.** Cart quantity rejects instead of clamping (L1, still open).
- **L-G.** Duplicate-id check across tenants in test helper (L2, still open).
- **L-H.** Bookings flag is now exact `"true"`. Any environment that still sets `CHATBOT_BOOKINGS_ENABLED=1` silently turns the feature off (`bookings/flags.ts:11`). Behaviour change; owner should know.
- **L-I.** Client flag `VITE_ENABLE_CHATBOT_BUILDER_ROUTES` is build-time and must match the server flag (`client/src/App.tsx:828`). Nothing checks they agree.

## 4. Tenancy check, method and result

Scratch script `/tmp/verify-scratch/render.mjs` runs the real storage classes (`DrizzleOrderStorage`, `DrizzleCartStorage`, `DrizzleFulfilmentStorage`, `DrizzleCustomerStorage`, `createDrizzleBookingStorage`, `DrizzleBuilderStorage`, and inbox query builders) against a fake pg client. It records each SQL text and its parameters. No database is contacted.

- Statements rendered: 44 across orders, cart, fulfilment, customers, bookings, builder and inbox.
- Statements with a `company_id` predicate and the scope id as a parameter: 44 of 44.
- Calendly plaintext found in any SQL text or parameter: none. The insert carries only the three ciphertext columns.
- `FOR UPDATE` confirmed in rendered SQL for: cart reads in a transaction (`cart-storage.ts` `selectCartQuery`), fulfilment stock read in a transaction, and bookings calendar lock.
- `FOR UPDATE` not confirmed for `transitionAppointment`. The fake client returned no rows, so the function returned before reaching the lock. Read from source instead: it does lock the calendar (`drizzle-booking-storage.ts:429`).
- Refund guard in `updateOrder` renders as `status = refunded OR EXISTS (refund return in same company)`, with the company predicate inside the subquery.

Schema scan (`/tmp/verify-scratch/schema-check.mjs`): all 34 Drizzle tables carry `company_id`, NOT NULL, except `chatbot_avatars` (nullable by design, for presets). Every composite FK starts with `company_id`. Every `ON CONFLICT` target matches a primary key or unique index that exists in the table file.

Limits: the Drizzle storage bodies in fulfilment (`fulfilment-storage.ts` lines 300-620, query builders) and customers were read by pattern and sampled. Every method in orders, cart and bookings was read.

## 5. Unverified claims

Everything below needs a live Postgres run. No test in the repo has run against a database. The integration report says so (Drizzle integration, "Open issues").

- Row locks (`FOR UPDATE`), partial unique indexes, and `ON CONFLICT` behaviour. Rendered SQL only.
- Calendly sealing in a real row round trip. The seal/open functions are tested, but `readCalendlyToken` over a stored row is not.
- EXCLUDE overlap guard (H-2). Claimed in `db/bookings.ts` and `bookings/drizzle-booking-storage.ts:9`. No migration. False until written.
- Builder raw SQL against real columns (H-3). Claimed to work. Columns do not exist.
- Composite FKs enforced by Postgres. Only shape checked.
- Stock non-negative CHECKs in `db/fulfilment.ts:79-80`. Present in the table file. Enforcement UNVERIFIED.
- Event log append-only: application-level only (`db/orders.ts` header says a trigger is recommended). No trigger.

## 6. Tests

Command: `/home/claude/integration-scratch/run-chatbot-tests.sh`, which runs each `tests/modules/chatbot*.test.mjs` with `/home/claude/integration-scratch/hook/register.mjs`.

- 19 files. 496 tests. 496 pass. 0 fail. Matches the integration report.

Test quality notes:
- Strong: `chatbot-integration-mount.test.mjs:90-125` (plan gate, real Express listen, HTTP 403 with the gate's own error text). `chatbot-booking-routes.test.mjs:442-470` (service returns the token, router must not leak it). `chatbot-bookings-drizzle.test.mjs:193-218` and `:263-330` (no plaintext in SQL, key errors).
- Shape only: most Drizzle tests assert SQL text and parameters through a recording client. They prove predicates are present, not that Postgres enforces them.
- Mock-based: `chatbot-cart.test.mjs:451-476` counts `transaction()` calls on the in-memory storage. It proves the call shape, not the lock.
- Not tested: primary key composition (M-A), EXCLUDE (H-2), the positive plan-gate path over HTTP, and the Drizzle `readCalendlyToken` round trip.
- Router tests still use hand-written services (M9).

## 7. Frontend

- Train step hidden (`steps.ts:32`). Channel step hidden (`steps.ts:48`, `steps/channel.tsx:25`, `:291`).
- Uploads answer 501 (`builder-router.ts:120`, `:203`).
- API calls in `api.ts` match the routes mounted in `builder-router.ts`. Route order is correct: `/builder/avatars` is registered before `/builder/:id` (`:123` before `:141`).
- No browser run. The client `*.test.md` files are manual checklists and were not run.

## 8. Owner decisions still needed

Each one is a decision, not a question about how to proceed.

1. Gate the core chatbot route at `server/routes.ts:1743`, or keep it always on (H-4).
2. Refund rule: block `partially_refunded` and `refunded` moves with no refund record (M-C, money). Proposed: block both.
3. Keep or remove the `approved` to `refunded` return edge (`orders/lifecycle.ts:54`, M2).
4. Approve a transaction and row locks for `recordRefund` (H-1). Needed before any Postgres run.
5. Who writes the migrations, and which ones: EXCLUDE overlap guard (H-2), builder columns (H-3), composite primary keys (M-A). Also confirm storage ownership (Prisma or Drizzle), as the integration doc asks.
6. Cart first-create race: lock the conversation row, or retry on conflict (M-B).
7. Primary keys: change 20 global-id tables to `(company_id, id)` before promotion (M-A).
8. Calendly token: add a key version now, or accept re-save on rotation (M-E).
9. Where `mountChatbotSlices` is called, and how the agent plan lookup is supplied (M-G, M3).
10. Builder create validation: match PHP (M4, decision 10).
11. Bookings flag: keep exact `"true"` and tell operators, or accept `"1"` again (L-H).

## Fix pass 2

Fixer: 2026-11-08, after this verification. Scope: H-1, M-B, H-2 and item 4 only. Full detail is in `INTEGRATION.md`, "Fix pass 2".

- H-1 refund guard: FIXED (unverified against Postgres). Files: `orders/order-service.ts`, `orders/order-storage.ts`, `db/orders-storage.ts`. Test: four "H-1" tests in `tests/modules/chatbot-orders-drizzle.test.mjs`, including `FOR UPDATE` in the rendered SQL on the return and the order.
- M-B cart race: FIXED (unverified against Postgres). Files: `cart/cart-storage.ts`, `cart/cart-service.ts`. The existing partial unique index `(company_id, conversation_id) WHERE status = 'active'` is the conflict target. Test: three "M-B" tests in `tests/modules/chatbot-cart-drizzle.test.mjs`, including `ON CONFLICT` and a company-scoped `SELECT` in the SQL.
- H-2 double booking: FIXED as a draft only. The file `db/migrations-draft/0001_bookings_exclusion.sql` is not applied and is unverified against Postgres. Test: three "H-2" tests in `tests/modules/chatbot-bookings-drizzle.test.mjs`, which read the file and check the constraint text.
- Item 4 unverified claims: FIXED. Every database claim in the chatbot `DECISIONS.md` files and `INTEGRATION.md` now says UNVERIFIED against Postgres. Test: the "item 4" scan in `tests/modules/chatbot-bookings-drizzle.test.mjs`.
- Totals: 507 of 507 chatbot tests pass.

Owner decisions still open: H-4 (gate the core route), the plan lookup for `hasHumanAgents`, and the M2 return edge.
