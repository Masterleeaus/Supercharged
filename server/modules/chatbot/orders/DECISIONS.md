# Native orders slice: decisions

Source: `extensions/chatbot-ecommerce/System/` (NativeOrderRuntime, CouponRuntime, OrderLifecycle, ReturnLifecycle, and the Commerce models), with table definitions from `database/migrations/2026_08_03_060012_conversational_commerce_slice1.php` and `2026_07_22_060005_pricing_discount_engine.php`.

## Ported

- Order model and lifecycle state machine. The transition table matches `OrderLifecycle.php` exactly. Terminal states are `cancelled` and `refunded`.
- Return lifecycle matching `ReturnLifecycle.php`. A return cannot move to `refunded` except through `recordRefund`.
- Order items, with line and order totals in integer minor units. Proration and percentages use BigInt, halves rounded up.
- Order event log. It is append-only: the interface has no update or delete, and stored events are frozen copies.
- Returns, with a per-item returned-quantity ceiling. Requests are validated in full before any write.
- Refund recording, with an outstanding-amount ceiling.
- Coupon validation (expiry, start date, minimum, currency, channel, first-order, target eligibility, usage limits), discount calculation, and reserve, redeem, release and expire.

## Not ported (out of scope this round)

- Payment capture and provider refunds. `recordRefund` takes an amount the caller has already confirmed with the provider.
- BNPL (`BnplOffer`, `BnplProviderProfile`).
- Tax calculation providers. Tax amounts are inputs, and only their arithmetic is checked.
- Marketplace sync (Shopify, eBay and similar), including `MarketplaceOrderSnapshot` and `UnifiedCommerceOrder`.
- Listing intelligence.
- Shipping rules and the pricing rule engine. Shipping is an input, and only coupon discounts are computed here.
- Fulfilment records (`Fulfillment`, `FulfillmentItem`). Fulfilled quantities are not yet tracked.
- Order exceptions, reconciliation and settlement.
- Drizzle storage implementation. Now written in `db/orders-storage.ts`, with transactions and row locks (UNVERIFIED against Postgres). The memory store is the reference implementation.
- SQL migration. `schema.DRAFT.ts` is the only artifact, as requested.
- Transports: WhatsApp, Telegram, Ably. `OrderEventPublisher` is a no-op port.

## Feature flag

- The module is off by default. `createOrderService` refuses every call with status 503 unless `enabled: true` is passed.
- The module does not read `process.env`. This matches the chatbot module, which takes switches as options. `nativeOrdersEnabled(env)` in `index.ts` reads `CHATBOT_NATIVE_ORDERS_ENABLED`, and only the exact string `"true"` turns it on.

## Deliberate deviations from the PHP

1. **Checkout totals are recomputed.** PHP copies the checkout's totals. This port recomputes them and refuses the order if they differ. This is fail-closed against drift.
2. **Refunds cannot exceed the order total.** PHP checks only the return's outstanding amount. The order-level guard is new.
3. **Redeem skips expired reservations.** PHP redeemed any reserved usage, including one past its expiry. That would let a reservation bypass the usage limit before the sweep runs. Expired reservations are left for `expireDueCouponUsages`.
4. **Proration is integer half-up.** PHP divides as floats and then rounds. For positive amounts the results agree. The integer version is exact.
5. **`quantitiesReleased` is a typed field.** PHP keeps it in return metadata.
6. **Return metadata is a shallow merge.** PHP uses a recursive merge. Metadata is informational and no logic reads nested keys.
7. **Coupon percentage values are capped at 10000 basis points on creation.** PHP silently caps them at query time. The creation check rejects bad input earlier.
8. **Coupon codes are unique per company and chatbot.** The PHP `code` column is unique without a chatbot scope.
9. **The order and item `id` is a UUID.** PHP keeps a separate auto-increment `id` and a `uuid`. One identifier is used here.

## Decisions needing the owner's review

1. **`recordRefund` moves an approved return straight to `refunded`.** This is PHP behaviour. `ReturnLifecycle` has no `approved -> refunded` edge, so the two are inconsistent. The port keeps PHP's behaviour for now.
2. **`transitionOrder` can set `refunded` or `partially_refunded` directly**, without a refund record. PHP allows this. The safer option is to block it, as `transitionReturn` blocks `refunded`.
3. **`returned` orders cannot have new returns requested.** This is PHP behaviour, even though `fulfilled` and `completed` both allow a return.
4. **`stackable` is stored but not enforced.** PHP does not enforce it in validation either.
5. **Event log immutability is application-level only.** Promotion should add a database trigger that rejects UPDATE and DELETE on `commerce_order_events`.
6. **Table names may clash with the pricing slice.** `commerce_coupons` and `commerce_coupon_usages` are named here. The pricing or integration agent needs to reconcile them.
7. **`schema.DRAFT.ts` was not type-checked.** `drizzle-orm` is not installed in this checkout. The draft imports `chatbots` from `../schema.DRAFT.ts`, and the integration agent must confirm that path after merging.

## Tests

`tests/modules/chatbot-orders.test.mjs`: 43 tests, all passing. Run with `node --test --experimental-transform-types tests/modules/chatbot-orders.test.mjs`.

## Drizzle (2026-11-08)

Files:
- `../db/orders.ts`: Drizzle tables. Names use the `chatbot_commerce_` prefix. The coupon tables are `chatbot_commerce_coupons` and `chatbot_commerce_coupon_usages`, so they do not clash with the pricing slice. Parent `chatbots` is imported from `shared/schema.ts`, which is not edited. Not added to `shared/schema.ts`, and no migration is applied.
- `../db/orders-storage.ts`: `DrizzleOrderStorage`. Every statement filters by `company_id`. Every method takes the company id first and calls `requireCompanyId`.
- `orders/order-storage.ts`: the in-memory interface is unchanged. The memory store has the M1 guard (below).
- `orders/lifecycle.ts`: the M2 edge (below).
- Tests: `tests/modules/chatbot-orders-drizzle.test.mjs`, 32 tests, all passing. Run with the integration hook (see Test run below).

Decisions:

1. **Sync interface, async storage (owner decision).** `OrderStorage` is synchronous. Drizzle is async, so `DrizzleOrderStorage` cannot implement it. It implements `AsyncOrderStorage`, the same method names with Promise return types. `order-service.ts` must await its storage before the Drizzle class can be used. This slice does not edit the service.
2. **M1 enforced in the storage write path, not in `transitionOrder`.** `transitionOrder` calls `storage.updateOrder` for every status change, so the guard sits on that call. A move to `refunded` throws `OrderError` unless a return of the same order has a refunded amount above zero. The message is `REFUND_RECORD_REQUIRED`. The memory store checks in code. The Drizzle store runs one UPDATE whose WHERE holds an EXISTS subquery, so the check and the write are one statement (UNVERIFIED against Postgres). `order-service.ts` was not edited, because it is outside this slice. The owner may still add the same check to `transitionOrder` for an earlier, clearer error. Order-level refunds are recorded through `recordRefund`, which updates the return before the order, so it passes the guard. Since fix pass 2, `recordRefund` runs both writes in one transaction with row locks (UNVERIFIED against Postgres).
3. **M2: approved -> refunded added to the return table.** `RETURN_TRANSITIONS.approved` now includes `refunded`. This matches PHP `recordRefund`, which accepts an approved return (`REFUNDABLE_RETURN_STATUSES`). `transitionReturn` still refuses `refunded` directly, so the only route to `refunded` is `recordRefund`. Tests cover the new edge, the absence of other new edges, and a full service refund from approved.
4. **Event log append-only.** `DrizzleOrderStorage` and the memory store have `appendOrderEvent` and `listOrderEvents` only. A test fails if any method on either store has an event name plus an update, delete or similar word. A second test checks that no statement against the event table is an UPDATE or DELETE. The database trigger that rejects UPDATE and DELETE is still not built.
5. **Sequence is computed in the INSERT.** The next `sequence` is a subquery in the same INSERT, per company. The unique `(company_id, sequence)` index rejects a race, so a conflict fails rather than duplicating a sequence number (UNVERIFIED against Postgres).
6. **Duplicates return 409.** A repeated checkout, coupon code or coupon usage uses `ON CONFLICT DO NOTHING` on the company key. An empty result becomes the same 409 as the memory store (UNVERIFIED against Postgres).
7. **Transactions.** `createOrder` (order plus items) and `createReturn` (return plus items) run in one transaction. A conflict rolls back (UNVERIFIED against Postgres).
8. **Money.** All money columns are `bigint` with `mode: "number"` (53-bit), in minor units. A test checks this and that no column is real, double or numeric.
9. **Limits of this port.** Not enforced here: a single transaction across `transitionReturn`'s several writes (stock release and status), and the row lock that a real database needs for concurrent transitions. Both are needed before the service runs against Postgres. Recorded for the owner. Fix pass 2 gave `recordRefund` one transaction and row locks, so two refunds of one order no longer race (UNVERIFIED against Postgres). `transitionReturn` still has no transaction.
10. **Two draft schemas.** `schema.DRAFT.ts` in this folder uses `commerce_` names. `db/orders.ts` uses `chatbot_commerce_` names. The integration agent must keep one set. Both cannot be promoted.

Test run:
- Command: `NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-orders-drizzle.test.mjs`. Result: 32 of 32 pass.
- `/home/claude/builder-test-deps/register.mjs` was tried first. It cannot resolve `drizzle-orm` or `shared/schema.ts`, so the integration hook is used.
- Existing `tests/modules/chatbot-orders.test.mjs`: 43 of 43 pass, with and without the hook.
- No database connection is made. Tests use a stub `pg` client.


## Integration update (2026-11-08)

- Fix 1 (resolved): `OrderStorage` is async, and `order-service.ts` awaits every storage call. The Drizzle store implements `OrderStorage` directly. Decision 1 in the Drizzle section above is closed.
- Fix 2 (M1): `transitionOrder` enforces the refund-record rule before any storage write. The storage check stays as a second line.
