# Cart and checkout slice: decisions

Port of the Commerce Crew cart and checkout domain (PHP) into the Desk chatbot module (TypeScript).
Scope: a conversation-scoped cart, integer-minor-unit totals, a checkout session that moves from open to
submitted with idempotency keys, and a per-conversation or per-customer spend limit. Payment capture is out of scope.

## Files

| File | Purpose | PHP source |
|---|---|---|
| `cart-types.ts` | Records, status vocabularies, `CartError`, idempotency-key and canonical-hash helpers | `Models/ChatbotCart.php`, `ChatbotCartLine.php`, `CartOperation.php`, `CheckoutSession.php`, `CheckoutOperation.php`, `Support/CartStatus.php`, `CheckoutStatus.php`, `CartLineKey.php` |
| `money.ts` | Integer minor-unit totals, line totals, quantity bounds | `Support/MoneyMath.php`, `CartLineQuantity.php` |
| `spend-limit.ts` | Pure limit decision and daily rollover | `Support/BudgetLock.php`, `Services/BudgetLockRuntime.php`, `Models/CommerceSpendLimit.php` |
| `cart-storage.ts` | `CartStorage` interface (company-scoped) and in-memory implementation | DB tables from migrations `2026_03_04_131543`, `2026_07_22_060004`, `2026_07_22_060006`, `2026_08_03_060012` |
| `cart-service.ts` | Add, set quantity, remove, clear, get-or-create per conversation | `Services/CartRuntime.php` |
| `checkout-service.ts` | Open, contact, submit with idempotency and spend check, cancel, set spend limit | `Services/CheckoutRuntime.php`, `Services/BudgetLockRuntime.php` |
| `catalog.ts` | `CartCatalog` port (variant lookup) and in-memory implementation | Product module, not ported |
| `keyed-lock.ts` | Per-key async serialisation within one process | Replaces PHP `lockForUpdate()` |
| `schema.DRAFT.ts` | Drizzle fragment for the six tables, with partial unique indexes (UNVERIFIED against Postgres) | Migrations above |
| `index.ts` | `createCartModule` factory and barrel exports | n/a |

## Not ported (out of scope or deliberately deferred)

- **Payment capture.** Submit produces an `OrderRequest` and stops. No payment gateway interface is defined,
  because the seam is the `OrderRequest` shape the orders slice will accept.
- **Carrier and shipping quotes, delivery selection, tax engine, pricing rules, coupons.** The totals include a
  discount field, clamped to the subtotal, but nothing in this slice produces a discount. Tax and shipping are absent.
- **Abandon, recover, merge.** `CartRuntime::abandon`, `recover`, `merge` and their recovery tokens are not ported.
  Status vocabulary is `active | converted | expired` only.
- **Reservations and inventory.** `InventoryRuntime` calls are not ported. Checkout does not reserve stock.
- **Approval tokens and `prepare`/`approve` steps.** The PHP two-step approval is collapsed into one submit.
- **Sweep jobs.** `ExpireCarts` and `ExpireCheckoutSessions` console commands are not ported. Expiry is lazy: it happens when
  a record is next accessed. A scheduled sweep is still needed before production.
- **`ChatbotDraft.php`.** This model stores a conversation's unsent message text (`ext_chatbot_drafts`). It is not cart
  state, so it belongs to the messaging slice and is not ported here.
- **Customisation pricing.** Customisation is part of the line key and is stored, but it does not change the price.
- **Drizzle storage implementation.** Now exists (see the Drizzle section). `schema.DRAFT.ts` is a
  draft fragment and has not been type-checked against drizzle-orm, because that package is not installed here.

## Decisions for owner review

1. **Quantity below 1 is rejected.** The PHP treats a set-quantity of 0 as removal, and clamps values to 0 to 999 silently.
   Here, quantity must be 1 to 999 and removal is a separate operation (`removeLine`). Owner to confirm.
2. **Quantity above 999 is rejected, not clamped.** This applies when repeat adds merge into one line. The PHP clamps silently.
3. **Feature flag.** `enabled` is an injected option, defaulting to `false`. Every public method throws
   `feature_disabled` (HTTP 404) while it is off. The chatbot module reads no environment variables, and its
   generative UI is gated the same way (injected deps, not env), so this slice does not read env either.
   Owner to decide the flag source in the composition root.
4. **Submit converts the cart.** The PHP converts the cart only when payment completes. With payment out of scope,
   this slice freezes the cart at submit. If the orders slice later rejects an order, the cart stays converted and needs a
   recovery path. Owner to confirm.
5. **All matching spend limits are checked.** The PHP picks the single most specific limit. Here, a conversation
   limit and a customer limit both apply, and the first block wins. This is stricter and stops a loose conversation
   cap from bypassing a customer cap. Owner to confirm.
6. **Spend counts at submit, not at order acceptance.** The PHP derives daily spend from orders. Here,
   `spentMinor` is incremented at submit, so the daily cap cannot be exceeded by parallel submits. A cancelled order downstream
   is not refunded against the limit in this slice.
7. **Daily period is the UTC calendar date.** The PHP uses the application's `today()`. Owner to confirm the timezone.
8. **Currency mismatch on a spend limit blocks.** This mirrors `BudgetLock::evaluate`. A cart's currency is set by its first
   line and does not change, including after clear.
9. **TTLs.** Cart expiry is 7 days from last activity. Checkout expiry is 30 minutes, clamped to 5 to 1440, both taken
   from the PHP defaults.
10. **Checkout totals are a snapshot.** They are refreshed on open, on re-open, and at submit. Cart edits made while a
    checkout is open do not block it. Clients that need certainty pass `expectedCartVersion` to submit.
11. **Idempotency replay semantics.** Cart operations replay by returning the current cart, as the PHP does. Checkout
    submit replays the stored result, including the stored order request. Submit requires a key (as the PHP does for checkout
    operations). Cart operations take an optional key.
12. **Error codes and status.** Validation is 422, state conflicts are 409, missing rows are 404, and a missing or
    malformed tenant is 403 (from `requireCompanyId`). Errors are `CartError`, a subclass of `ChatbotError`.
13. **Conversation scope.** The brief asks for a conversation-scoped cart, so one active cart exists per company and
    conversation. The PHP keys carts by chatbot and session. Owner to confirm that the Desk conversation id is the
    right key.
14. **Line identity.** A line key is `sha256(variantId | canonical customisation)`. Repeat adds merge into one line.
    Prices are captured when a line is written. Other lines are not repriced, unlike the PHP full recalculation.
15. **Contact rule.** Checkout needs an email or a phone number, as the PHP does. The email check is a basic
    pattern match. This slice does not validate phone numbers beyond a character set and length.
16. **Concurrency.** Operations are serialised per key within one process (`keyed-lock.ts`). Lock order is
    cart, then checkout, then spend. A database implementation needs row locks in the same order, and the
    submit writes must sit in one transaction.
17. **Schema dependency.** `schema.DRAFT.ts` imports `chatbots` and `chatbotConversations` from `../schema.DRAFT.ts`. `db/cart.ts` imports them from `shared/schema.ts`.
    The integration agent should repoint these to `shared/schema.ts` when the tables are merged.

## Test status

`tests/modules/chatbot-cart.test.mjs` runs 19 tests, all passing, with
`node --test --experimental-transform-types`. The slice imports only `chatbot-scope.ts`, so it runs without
`node_modules`. Strict `tsc` over the slice reports only missing `@types/node` errors, which come from this environment.

`tests/modules/chatbot.test.mjs` fails in this checkout before any slice code runs: `drizzle-orm` is not installed, so
`chatbot-storage.ts` cannot be imported. This is an environment gap and not caused by this slice.

## Drizzle

Date: 2026-11-08. Files: `db/cart.ts` (tables), `cart-storage.ts` (`transaction()` on the interface, its in-memory implementation, `DrizzleCartStorage`, query builders, error mapping). Tests: `tests/modules/chatbot-cart-drizzle.test.mjs` (27 tests). The 19 existing cart tests still pass.

1. **Interface change.** `CartStorage` gains `transaction(companyId, fn)`. No other signature changed. Without it, row locks cannot cover a read-check-write across several storage calls. Both implementations provide it (UNVERIFIED against Postgres for the row locks).
2. **Services must be wired to use it.** `cart-service.ts` and `checkout-service.ts` are outside this slice and still call storage one method at a time. Each operation must run inside `storage.transaction(companyId, (tx) => ...)` and use `tx` for every call, or the locks do nothing. Until that wiring lands, the database constraints still hold (below), but reads are not locked. (UNVERIFIED against Postgres.)
3. **Lock points.** Inside `transaction()`, `getCart`, `getCheckout` and `findSpendLimits` read with `SELECT ... FOR UPDATE`. Spend-limit rows are ordered by `(scope_type, scope_id)`. Lock order is cart, then checkout, then spend, as in decision 16 below. (UNVERIFIED against Postgres.)
4. **Database guarantees, no lock needed.** A partial unique index allows one active cart per conversation and one open checkout per cart. A unique index on `(company_id, owner_type, owner_id, idempotency_key)` allows each key once per owner. A unique index on `(company_id, scope_type, scope_id)` allows one spend limit per scope. A violation becomes `conflict` or `idempotency_conflict` (409). (UNVERIFIED against Postgres.)
5. **One idempotency table.** `chatbot_cart_idempotency_keys` holds keys for carts and checkouts. The owner type is part of the key, so a cart key and a checkout key with the same text never collide.
6. **Cart lines** are their own table, keyed `(company_id, cart_id, line_key)`. A `position` column keeps the order. A cart write replaces its lines in one transaction (UNVERIFIED against Postgres).
7. **Checkout lines and the order request** are stored as jsonb snapshots, as the in-memory records hold them.
8. **Tenant-safe upserts.** Carts, checkouts and spend limits upsert on a key that includes `company_id` (UNVERIFIED against Postgres).
9. **Money** is `bigint` in minor units, read as a JS number. CHECK constraints (draft, UNVERIFIED against Postgres): quantity 1 to 999, money >= 0, spent >= 0.
10. **Errors.** 23505 on the idempotency index becomes `idempotency_conflict`. Other 23505 becomes `conflict`. 23514 becomes `validation` (UNVERIFIED against Postgres). Service errors pass through.
11. **In-memory lock.** `keyed-lock.ts` is still used by the services, so it remains a per-process guard. The memory `transaction()` serialises per company in process only. Nested `transaction()` calls on the same in-memory storage would wait on themselves and are not allowed. The Drizzle path relies on row locks, so it holds across processes (UNVERIFIED against Postgres).
12. **Concurrent first cart (fix pass 2, 2026-11-08).** Cart creation is `INSERT ... ON CONFLICT DO NOTHING` on the active-cart index, then a company-scoped `SELECT` of the active cart. The conflict target is the existing partial index `(company_id, conversation_id) WHERE status = 'active'`, not a full unique index, because a full one would stop a conversation from ever having a second cart after the first expires or converts. Two first requests therefore share one cart. UNVERIFIED against Postgres.

Not verified: no run against a live Postgres. The tests use a recording in-process client and assert the SQL.

## Integration update (2026-11-08)

- Decision 2 above is resolved. `cart-service.ts` and `checkout-service.ts` run every mutation inside `storage.transaction`, using `tx` for all reads and writes. Read-only calls are unchanged.
- The keyed lock is the default in-process guard. A database deployment passes `passThroughLock` (`cart/index.ts`).
