# Verification: chatbot integration (Desk)

Verifier: independent pass, 2026-11-08. The verifier did not write this code. No source file was edited. Scratch scripts live in `/tmp/verify-scratch/` and are not part of the repo.

Rules followed: `/home/claude/CLAUDE.md` does not exist, so `desk-review/CLAUDE.md` was used. No full `tsc` was run. No questions were asked.

## Overall result

- Verdicts: 0 slices PASS cleanly. 8 slices PASS WITH ISSUES, 1 slice FAIL (`booking-routes`). The client wizard is FAIL (train step). The mount file is PASS WITH ISSUES.
- Findings: 0 critical, 4 high, 10 medium, 7 low.
- The in-memory storages keep every method scoped to `companyId`. No cross-tenant read or write was found.
- Money is integer minor units everywhere it was checked. No floating point on amounts.
- All 11 chatbot test files pass (277 tests). Several of those tests pass for reasons that do not prove the real path (see H3 and M9).
- Nothing in the slices is wired to a live database yet. The tenancy check on SQL cannot be done until the Drizzle storages exist.

## Verdicts per slice

- `bookings/`: PASS WITH ISSUES. Rules match the PHP intent. Open: overlap buffer is a review item (D8), flag value rule (L3).
- `booking-routes/`: FAIL. Wire status does not match the bookings slice (H2). Calendly token path relies on a mock (H3). Default role check is allow-all (M5).
- `builder-routes/`: PASS WITH ISSUES. Tenancy, strict bodies and role sets are correct. Create validation is weaker than PHP (M4). Uploads answer 501 (L4).
- `agent-routes/`: PASS WITH ISSUES. Internal notes are never delivered, and the message is saved before delivery. Plan gate missing (M3). Blocked until adapters exist.
- `inbox/`: PASS WITH ISSUES. Handoff rules and presence rules match the PHP, with differences recorded. Real-time transport not chosen.
- `customers/`: PASS WITH ISSUES. Identifier normalisation, duplicate matching and merge match the PHP, with differences recorded. Flag rule differs from the bookings flag (L3).
- `orders/`: PASS WITH ISSUES. Order transition table matches `OrderLifecycle.php` exactly. Direct move to `refunded` is allowed (M1). Return lifecycle inconsistency (M2).
- `fulfilment/`: PASS WITH ISSUES. Availability formula matches PHP. Flag and TTL clamp correct. In-memory only.
- `cart/`: PASS WITH ISSUES. Totals, TTL and idempotency match intent. Locks are per process only (M7).
- `integration/mount.ts`: PASS WITH ISSUES. Fails closed when a flag is on with no dependency. Relies on mount order and on a `requireRole` the caller must supply (M5 note).
- Client `chatbot-builder/`: FAIL. The train step calls routes that the backend does not have (H1). The wizard route is not flag-gated (M6). API calls for the configure and customize steps match the mounted routes. Channel secrets stay in component memory and never reach the localStorage draft.

## Findings

### Critical

None found in the checks run. Coverage caveat: the in-memory storage bodies were checked method by method for cart, orders, customers, inbox, bookings, fulfilment, builder and agent memory. The fulfilment and customers storage bodies were checked by pattern and by sampling, not line by line.

### High

**H1. The train step calls routes that do not exist.**
- Client: `client/src/pages/chatbot-builder/steps/train.tsx:119` (`SOURCES_BASE`), used at lines 134, 140, 146, 158, 174 and 180. The calls are GET and POST `/sources`, POST `/sources/website`, POST `/sources/file`, POST `/sources/train` and DELETE `/sources/:id`.
- Backend: `server/modules/chatbot/builder-routes/builder-router.ts` registers only `/builder/avatars`, `/builder/:id` and `/builder/:id/uploads` (lines 111, 119, 129, 140, 169). No `sources` route exists anywhere under `server/modules/chatbot` (grep finds none).
- The step is visible. `client/src/pages/chatbot-builder/steps.ts` gives the train entry `external: true` but no `enabled: false`.
- Effect: every train action returns 404 once the builder flag is on. The integration report lists this as checklist item T1, not as a blocker.

**H2. The booking router uses a status the bookings slice does not use, and the source note misstates PHP.**
- `server/modules/chatbot/booking-routes/contract.ts:12-13` and `:48-56` use `booked` and `waitlisted` as wire statuses. The comment says they come from the PHP model.
- The PHP does not show `booked`. The migration `extensions/chatbot-booking/database/migrations/2026_07_21_040001_upgrade_generic_booking_runtime.php` sets the appointment status default to `'confirmed'`. `BookingRuntime.php` writes `waitlisted` only.
- `server/modules/chatbot/booking-routes/DECISIONS.md:8` claims PHP uses `booked`/`waitlisted`. That is not what the source shows.
- The bookings slice (`bookings/DECISIONS.md` D5) uses `confirmed`, which matches the PHP.
- Effect: the two slices disagree on the status a new booking gets. Any adapter must translate it, and a wrong translation would silently change booking state.

**H3. The "Calendly token is never returned" guarantee is proved only by a mock.**
- `server/modules/chatbot/booking-routes/router.ts:217-219` returns whatever `service.getAssistantSettings(companyId)` returns, with no filter.
- The storage contract at `booking-routes/contract.ts:92` returns `calendlyAccessToken` in plaintext. `booking-routes/DECISIONS.md:57` confirms the token is stored in plaintext.
- The test `tests/modules/chatbot-booking-routes.test.mjs:421-435` passes. Its mock service at lines 137-143 builds a new object that leaves the token out. The router is never tested against a service that returns the token.
- No real `BookingService` exists yet. When one is written from the storage shape, the token would be sent to the browser on every `GET /booking-settings`.
- The token is also kept in plaintext (`booking-routes/DECISIONS.md:57`).

**H4. The core chatbot route is live with no flag, which contradicts the integration report.**
- `server/routes.ts:1743` calls `registerChatbotModule(...)` with no flag. Core routes are already served.
- `INTEGRATION.md` section 11 and the open-issues list say the path is ungated and "owner to decide". Section 1 summary says "Nothing is turned on". That sentence is not accurate for the core route.
- Effect: the new flags protect only the new routers. The existing chatbot API is on for every environment.

### Medium

**M1. An order can be moved to `refunded` without a refund record.**
- `server/modules/chatbot/orders/order-service.ts:399-411` (`transitionOrder`) checks only `assertOrderTransition`. The refund guard exists only in `transitionReturn` (line 535).
- `orders/DECISIONS.md:49` (decision 2) says the safer option is to block this. It is still open.

**M2. Refund recording moves an approved return straight to `refunded`, which the return table forbids.**
- `server/modules/chatbot/orders/lifecycle.ts:53` gives `approved` the edges `in_transit`, `received`, `cancelled` only.
- `orders/DECISIONS.md:48` (decision 1) keeps PHP's behaviour. The port's own table disagrees with it. Owner must decide which one is right.

**M3. The agent plan gate is not ported.**
- The PHP middleware returns 403 when the plan has no human agents (`agent-routes/DECISIONS.md:46`, decision 3).
- The TS router has no equivalent. The decision is written as a question, so nothing enforces it. Once the agent routes are mounted, any staff member on any plan can reply.

**M4. Builder create validation is weaker than the PHP.**
- `server/modules/chatbot/builder-routes/builder-schemas.ts:233-236` requires only a non-empty title on save.
- PHP `extensions/chatbot/System/Http/Requests/ChatbotStoreRequest.php:22-25` requires `welcome_message`, `instructions` and `bubble_message` (instructions only outside demo).
- `builder-routes/DECISIONS.md` decision 10 records this and asks the owner. Left open.

**M5. The booking router defaults to allow-all for roles.**
- `server/modules/chatbot/booking-routes/router.ts:62` and `:87`: `const roles = deps.requireRole ?? allowAll`.
- The mount always passes a real `requireRole` (`integration/mount.ts:86`), so the mount is safe. Any direct use of `createBookingRouter` without the option opens every booking route to any authenticated caller.
- The builder router has no such default. The two routers should match.

**M6. The client wizard page is not flag-gated.**
- `client/src/App.tsx:356` mounts `/app/chatbot-builder/wizard/:id?` with no flag check. With the builder flag off, the page loads and each call returns 404.

**M7. Cart and checkout locks work only inside one process.**
- `server/modules/chatbot/cart/keyed-lock.ts:8` and `cart/index.ts:38-39`. `cart/DECISIONS.md` decision 16 records it.
- Two server instances would break the spend-limit and idempotency guarantees. Not a problem today because no database storage exists, but it must be fixed before a Drizzle storage ships.

**M8. No slice has a database storage, so SQL tenancy is unverified.**
- Only in-memory storages exist. No migration exists. The integration report records this.
- The tenancy rule (every read and write filters by `company_id`) must be re-checked on each Drizzle storage when it is written. Nothing here can confirm it.

**M9. Router tests run against hand-written services, so the real contract is untested.**
- `chatbot-booking-routes.test.mjs`, `chatbot-builder-routes.test.mjs` and `chatbot-agent-routes.test.mjs` all supply their own service objects. The shapes can drift from the real adapters with no test failing.
- Combined with H3, this is why the token guarantee passes today.

**M10. The internal-note rule is enforced only in the handler.**
- `agent-routes/agent-handlers.ts:147-155` skips delivery for `isInternalNote`. The storage write at lines 139-143 happens first and stores the note with its flag. Reads go through `customer-view.ts`. This is correct today, but it depends on every future reader using `customerVisibleMessages`. No test covers a new reader.

### Low

**L1. Cart quantity rejects values instead of clamping them.** `cart/cart-types.ts:19-20` and `cart/money.ts`. PHP clamps silently to 0 to 999 (`CartLineQuantity.php`). Recorded in `cart/DECISIONS.md` decisions 1-2.

**L2. The agent memory store checks duplicate ids across all companies.** `server/modules/chatbot/agent-routes/memory-services.ts:79` throws when an id exists in any company. The error reveals another tenant's id, but only in this test helper, not in a route.

**L3. The "flag on" rule differs by slice.** Bookings accept only `"1"` (`bookings/flags.ts:11`). The routers accept only `"true"` (`booking-routes/router.ts:35-37`, `builder-router.ts:31-33`). Customers accept `1`, `true`, `yes` and `on` (`customer-service.ts:40`). Owner should pick one rule.

**L4. Upload routes answer 501.** `builder-router.ts` `POST /builder/:id/uploads` and `POST /builder/avatars`. Recorded in `builder-routes/DECISIONS.md`.

**L5. Conversation export is UTC, not the app timezone.** `conversation-export.ts:25`. Recorded in the code comment.

**L6. The inbox has no real-time transport.** Recorded in `inbox/DECISIONS.md` (top open question). Staff views will not update live until one is chosen.

**L7. The `/home/claude/CLAUDE.md` path in the brief does not exist.** Not a code defect. Noted for the owner.

## Per-slice rule checks (five PHP rules each)

PASS (recorded) means the TypeScript differs from the PHP and the difference is written in that slice's DECISIONS.md.

**cart**
1. Line quantity 0 to 999, clamped (PHP `CartLineQuantity.php`). TS rejects outside 1 to 999 (`cart-types.ts:19-20`). PASS (recorded, decisions 1-2).
2. Cart expires 7 days after last activity (PHP `CartRuntime.php` `addDays(7)`). TS `DEFAULT_CART_TTL_DAYS = 7` (`cart-service.ts:28`). PASS.
3. Cart operations serialised with row locks (PHP `lockForUpdate`). TS uses a keyed lock in one process (`cart/index.ts:39`). PASS (recorded, decision 16). See M7.
4. Spend limit picks the most specific limit (PHP `BudgetLock`). TS checks all matching limits (`checkout-service.ts` `enforceSpend`). PASS (recorded, decision 5).
5. Expiry sweep and abandon/recover/merge (PHP `ExpireCarts`, `CartRuntime::abandon`). Not ported and not built. PASS (recorded, scope list).

**orders**
1. Order transition table (PHP `OrderLifecycle::TRANSITIONS`). TS `ORDER_TRANSITIONS` (`lifecycle.ts`) is identical. PASS.
2. Return transition table (PHP `ReturnLifecycle`). TS table matches, but `recordRefund` bypasses it. PASS (recorded, decision 1). See M2.
3. Percentage and proration rounding half up (PHP `MoneyMath::percentage`, `intdiv(a*bp + 5000, 10000)`). TS `prorateHalfUp` and `percentageOf` (`money.ts`) use BigInt and the same rounding. PASS.
4. Refund ceiling (PHP checks return outstanding only). TS adds an order-level ceiling (`orders/DECISIONS.md` deviation 2). PASS (recorded).
5. Event log append-only (PHP trigger in DB). TS is application-level only. PASS (recorded, decision 5). Database trigger not built.

**bookings**
1. Busy windows exclude cancelled rows (PHP `available()` `whereNotIn('status', ['cancelled'])`). TS conflict check uses confirmed rows only (`bookings/booking-storage.ts` `conflictsWithConfirmed`). PASS.
2. Overlap is half-open `[start, end)` (PHP `starts_at < to`, `ends_at > from`). TS adds a buffer (D8). PASS (recorded, review item).
3. Waitlist does not hold a slot (PHP `waitlist()` writes without a check). TS waitlist holds nothing (D4). PASS (recorded).
4. Default status `confirmed` (PHP migration default). TS default `confirmed` (D5). PASS.
5. Wall-clock times in the calendar timezone with DST. Checked with a scratch script: Melbourne on 2026-10-04 09:00 (DST start), Melbourne on 2026-04-05 09:00 (DST end), and New York on 2026-11-01 09:00 all convert correctly. PASS.

**booking-routes**
1. Statuses match the PHP and the bookings slice. FAIL (H2).
2. Calendly token write-only. FAIL in the real path (H3). PASS only through the mock.
3. Role sets enforced on every route. PARTIAL. Default is allow-all (M5). PASS for the mounted path.
4. Overlap returns 409 "Slot already booked" (`booking-routes/DECISIONS.md:33`). Service layer does not exist, so not testable against real code. PASS (contract only).
5. Company id only from `res.locals`, body strict (`router.ts:96`, `schemas.ts` `.strict()` x6). PASS.

**builder-routes**
1. Images restricted to the company's own upload prefix (`builder-schemas.ts:157-158`, `:240-261`). PASS.
2. Create requires welcome message and instructions (PHP `ChatbotStoreRequest.php:22-25`). TS requires title only. PASS (recorded, decision 10). See M4.
3. Reads admin, manager, agent; writes admin, manager (`builder-router.ts:49-55`). Matches the decision record. PASS (recorded, decision 14).
4. Strict body rejects `companyId` anywhere (`builder-schemas.ts:8`). PASS.
5. Uploads (PHP upload handling). Answer 501. PASS (recorded, L4).

**agent-routes**
1. Internal notes never reach the customer (PHP controller). TS skips delivery (`agent-handlers.ts:147-155`). PASS.
2. Message saved before delivery (PHP comment in controller). TS saves first (`agent-handlers.ts:139-143`). PASS.
3. Roles. PHP has no role split. TS assumes admin, manager, agent with managers read-only (`agent-routes/DECISIONS.md:45`). PASS (recorded question).
4. Plan gate (PHP `planAllowsHumanAgent`, 403). Not ported. FAIL until resolved (M3).
5. Flag `DESK_CHATBOT_AGENT_ROUTES` must equal `"true"` and defaults off (`agent-routes/flags.ts`). PASS.

**inbox**
1. Handler derived from `connectAgentAt` (PHP handler state). TS derives `ai` or `human` (`inbox-service.ts:365`). PASS (recorded, decision 1).
2. Search escapes `%` and `_` (PHP passes them raw). TS escapes (decision 12). PASS (recorded).
3. Presence TTL 120 seconds with a 15 second floor (PHP). TS matches (decision 11). PASS.
4. Publisher failure does not roll back (PHP try/catch around Ably). TS matches (decision 13). PASS.
5. Offline excluded from active presence (PHP included it). TS excludes it (decision 9). PASS (recorded).

**customers**
1. Identifier normalisation: lowercase and trim; digits only for phone, sms and whatsapp (PHP `ContactIdentityService::normalize`). TS `normalizeIdentifier` and `PHONE_CHANNELS` (`customer-service.ts:71`, `:107-112`) match. PASS.
2. Duplicates match on the normalised value across channels (PHP `duplicates()`). TS matches (`customer-service.ts:323`, decision 5). PASS (recorded).
3. Merge moves identities and conversation links, then deletes the source (PHP `merge()`). TS matches (`customer-storage.ts:315-335`). PASS.
4. Self-merge and missing-customer checks. PHP has none. TS adds both (`customer-service.ts:337-344`, decision 7). PASS (recorded).
5. Identity uniqueness per company (PHP global index). TS per company (decision 3, `customer-storage.ts:181-192`). PASS (recorded).

**fulfilment**
1. Available = quantity minus reserved, committed, damaged and safety stock, floored at zero (PHP `InventoryAvailability::calculate`). TS `availableUnits` (`state.ts:69-71`). PASS.
2. Reservation TTL default 15 minutes, clamped 1 to 120 (PHP). TS `inventory.ts:25-26`, `:251`. PASS.
3. Backorders decided on the stock row (PHP reads the variant). TS moves the flag to the stock row (decision 4). PASS (recorded).
4. Commit after expiry persists the expiry, then fails (PHP order). TS matches (decision 9). Tested at `chatbot-fulfilment.test.mjs:173`. PASS.
5. Flag exactly `"true"`, throws 404 when off (`fulfilment/index.ts:16-17`, `:37-38`). PASS.

**integration/mount.ts**
- Flag off mounts nothing. Flag on with no dependency throws. Checked against the file and the mount test. PASS.
- Auth applied to the whole `/api/chatbot` base (`mount.ts:89`, `:106`). Correct only if mounted after the core router (INTEGRATION decision 5). Ordering is not enforced in code. PASS WITH ISSUES.

## Cross-cutting checks

**Tenancy.** Every storage method in the slice storages takes `companyId` first (checked from the interface files). In-memory bodies key every read and write by company: cart (`cart-storage.ts:53-160`), orders (`order-storage.ts:134-290`), inbox (`memory-storage.ts:76-140`), bookings (`booking-storage.ts:93-221`), builder (`builder-storage.ts:84-120`), customers (`customer-storage.ts:181-410`), fulfilment (`fulfilment-storage.ts:80-205`). No unscoped read or write found. SQL not present, so M8 applies. Routers take company only from `res.locals` or the injected authenticate. Verified in `booking-routes/router.ts`, `builder-router.ts`, `agent-handlers.ts:93-100`.

**Input trust.** Company, staff id and role come from `authenticate` only (`agent-handlers.ts:93-100`). Body and query schemas are strict in booking and builder routes, so a `companyId` in a request body returns 400. PASS.

**Money.** Integer minor units throughout (`orders/money.ts`, `orders/totals.ts`, `cart/money.ts`). Overflow checks use `Number.isSafeInteger`. Proration uses BigInt. No float arithmetic on amounts found by grep (`parseFloat`, `toFixed`, division by 100). PASS.

**Time.** Injected clocks everywhere (`now` options). Timezone conversion for bookings verified by scratch script (see bookings rule 5). Conversation export is UTC (L5). PASS.

**Secrets.** No `console` or logger calls in the slices. Webhook secret empty is refused (`bookings/webhooks.ts:50-53`). Calendly token: see H3. Channel secrets stay in component state (`steps/channel.tsx:10-12`); `ChannelState` is an empty type (`types.ts:190`), so they never enter the localStorage draft. The auth header is read from the app's existing `AuthStorage` (`api.ts:116`, `train.tsx:161`). That is the app's existing pattern and was not changed. PASS, except H3.

**Feature flags.** Every new feature defaults to off: bookings, booking-routes, builder-routes, agent-routes, customers and its sub-flags, fulfilment, orders, cart, inbox, generative UI (injected), channel step (`CHANNEL_STEP_ENABLED = false`, `steps.ts` `enabled: false`). Readers differ (L3). The core route is not gated (H4). PASS WITH ISSUES.

## Tests

Command: `node --test --experimental-transform-types <file>` with `NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs"`, the hook the integration report uses. Results:

- `chatbot-agent-routes`: 22 of 22 pass.
- `chatbot-booking-routes`: 21 of 21 pass.
- `chatbot-bookings`: 38 of 38 pass.
- `chatbot-builder-routes`: 26 of 26 pass.
- `chatbot-cart`: 19 of 19 pass.
- `chatbot-customers`: 27 of 27 pass.
- `chatbot-fulfilment`: 20 of 20 pass.
- `chatbot-inbox`: 24 of 24 pass.
- `chatbot-mount`: 4 of 4 pass.
- `chatbot-orders`: 43 of 43 pass.
- `chatbot` (core): 33 of 33 pass.
- Total: 277 of 277.

Weak tests:
- `chatbot-booking-routes.test.mjs:421-435` (token "never returned"). Passes through the mock only (H3).
- Router tests use hand-written services (M9).
- `chatbot-mount.test.mjs` has 4 tests. Flag-off and flag-on cases are covered; the ordering rule (M mount note) is not tested.

Not re-run: the report says four files fail without the hook because of missing modules. I did not re-check that claim, and I did not run the tests with `/home/claude/builder-test-deps/register.mjs`.

## Frontend

- API calls matched to backend routes: `api.ts` configure, customize and avatar calls match `builder-router.ts`. Upload calls match and answer 501 (L4).
- API calls with no route: the train step (H1).
- No step calls an external provider from the browser. Train's "EXTERNAL" comment refers to file parsing, which the backend is meant to do, and there is no third-party URL in the client.
- The wizard route is not flag-gated (M6).

## Not verified

- SQL tenancy, migrations and the `EXCLUDE` constraint: none exist (M8).
- Full line-by-line read of the fulfilment and customers storage bodies. Sampled and pattern-checked only.
- Browser behaviour of the wizard. The client `*.test.md` files are manual checklists and were not run.
- The claim that four test files fail without the hook (see Tests).
- Full `tsc` (not run, per CLAUDE.md). The integration report's scoped type check was not repeated.

## Fix pass (2026-11-08)

Fixer: fix agent, working from this report. Only H1, H2, H3, M5 and M6 were changed. Each decision that changes behaviour is logged in `/home/claude/supercharged-fixes-checklist.md` (section "Added 2026-11-08 (chatbot verification fix pass)"). No question was asked. `desk-review/CLAUDE.md` was followed. `/home/claude/CLAUDE.md` does not exist.

### Test totals

- `chatbot-booking-routes.test.mjs`: before 21 of 21, after 23 of 23. Two tests added.
- `chatbot-builder-routes.test.mjs`: before 26 of 26, after 27 of 27. One test added.
- `chatbot-mount.test.mjs`: before 4 of 4, after 4 of 4. Run with `/home/claude/integration-scratch/hook/register.mjs`. With `/home/claude/builder-test-deps/register.mjs` it fails both before and after, because `drizzle-orm` does not resolve from `chatbot-storage.ts`. This pass did not change that.
- No other test file imports the changed code, so none were re-run.
- Client: there is no automated runner. The client files were checked by reading. No TypeScript parser is installed and full `tsc` was not run.

### Per item

- **H1. FIXED.** The train step is hidden. Files: `client/src/pages/chatbot-builder/steps.ts` (`enabled: false` on the train entry), `client/src/pages/chatbot-builder/DECISIONS.md` (one-line note under item 10). The step file is kept. The wizard shell already filters out entries with `enabled: false` (`wizard-shell.tsx:42`). Proof is by reading, not by test. `steps/train.test.md` was not run, because the step is hidden.
- **H2. FIXED.** A new confirmed booking now has the wire status `confirmed`. `waitlisted` is kept. Files: `booking-routes/contract.ts`, `booking-routes/schemas.ts`, `booking-routes/DECISIONS.md` (line 8 corrected to cite the PHP migration default `confirmed`), `integration/INTEGRATION.md` (the one stale status sentence), and the test file. Proof: the test "create: successful booking returns 201" now asserts `confirmed`. The overlap (409) and cancel tests were moved to `confirmed` and still pass.
- **H3. FIXED.** The router strips `calendlyAccessToken` from whatever the service returns, on GET and on PATCH, and sends `hasCalendlyToken` instead. Files: `booking-routes/router.ts` (`toSettingsResponse`), the test file. Proof: the new test "settings: a service that returns the token in its object still does not leak it over HTTP". Its service returns the token. The test checks the response body does not contain the token and does contain `hasCalendlyToken: true`. The original mock-based test is kept. The old response field `calendlyAccessTokenSet` is no longer sent, which is a wire change. Token storage is unchanged. The new test was not run against the old router, but the old code returned the service object as is, so it would have failed.
- **M5. FIXED.** Both routers now refuse with 403 when no `requireRole` is supplied. Files: `booking-routes/router.ts`, `builder-routes/builder-router.ts`, and a comment in `integration/mount.ts`. Proof: "roles: a router built without requireRole refuses every authenticated request with 403" exists in both test files.
- **M6. FIXED.** The wizard route renders `ChatbotWizard` only when the flag is on. Otherwise it renders the existing `ChatbotBuilder`. Files: `client/src/App.tsx`, `client/src/pages/chatbot-builder/DECISIONS.md`. The app had no client feature-flag reader. The flag is `VITE_ENABLE_CHATBOT_BUILDER_ROUTES === "true"`, a Vite build-time variable, the same pattern `embed.tsx` uses. It must be set together with the server flag `ENABLE_CHATBOT_BUILDER_ROUTES`. Proof is by reading only. A browser check is still needed.

### Owner decisions still open

- **H4. OWNER DECISION.** The core chatbot route is ungated at `server/routes.ts:1743`. Not changed.
- **M1. OWNER DECISION.** Order can move to `refunded` without a refund record. Not changed.
- **M2. OWNER DECISION.** Refund recording moves an approved return straight to `refunded`. Not changed.
- **M3. OWNER DECISION.** Agent plan gate not ported. Not changed.
- **M4. OWNER DECISION.** Builder create validation is weaker than PHP. Not changed.
- Calendly token encryption at rest. Owner decision, recorded in `booking-routes/DECISIONS.md` (decision 6). Not changed.
- Not touched in this pass: M7 to M10 and the L items. Migrations and `shared/schema.ts` were not touched.
