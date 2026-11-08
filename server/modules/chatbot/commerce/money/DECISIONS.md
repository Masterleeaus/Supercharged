# Commerce money: decisions (2026-11-08)

Slice: `server/modules/chatbot/commerce/money/`. Source: Commerce Crew `extensions/chatbot-ecommerce/System/` (PaymentRuntime, BnplRuntime, TaxRuntime, ShippingRuntime, PricingRuntime, RentalHireRuntime, the Support calculators and the internal providers). Tables in `db/commerce-money.ts`. Draft SQL in `db/migrations-draft/0101_commerce_money.sql`.

## Files

| File | Role |
| --- | --- |
| `money.ts` | Integer minor-unit maths: half-up percentages, exact BigInt division, discount allocation. |
| `request-keys.ts` | Canonical request hash, required idempotency key, per-key in-process lock. |
| `flags.ts` | Flag readers through `readFlag`. |
| `payment-lifecycle.ts` | Status transitions and refund and capture amounts. |
| `webhook-signature.ts` | Fail-closed HMAC check with tolerance and constant-time compare. |
| `payment-storage.ts` | Storage port and in-memory store. |
| `internal-payment-provider.ts` | In-process `PaymentProvider` (key `internal`). No HTTP. |
| `payment-service.ts` | Create, authorise, capture, cancel, refund, webhook intake. |
| `bnpl.ts` | Eligibility, instalment schedule, merchant fee, offer service through `BnplProvider`. |
| `zones.ts` | Address-to-zone matching shared by tax and shipping. |
| `tax.ts` | Tax calculator, internal `TaxProvider`, order tax. |
| `shipping.ts` | Rate calculator, internal `ShippingProvider`, quote expiry. |
| `pricing.ts` | `PricingProvider` with percent and fixed rules, price overrides, snapshot hash. |
| `rental-hire.ts` | Item availability, deposit, late-return fee. |
| `rental-storage.ts` | In-memory hire storage. |
| `drizzle-queries.ts` | Drizzle query builders for payment and hire paths, each filtered on `company_id`. |
| `index.ts` | Barrel. |

## Behaviour decisions

- Money is an integer count of minor units everywhere. Products go through BigInt, then a safe-integer check. Percentages are basis points. A 10 percent discount on 999 cents is 100 cents (half up).
- Payment statuses are the contract's `PAYMENT_STATUSES`, not the PHP list. Partial capture and partial refund are read from the captured, authorised and refunded amounts. The intent is `refunded` only when every captured cent is refunded and the full authorised amount was captured.
- A refund is refused before the provider is called when it is above captured minus refunded. A refund is allowed while the intent is `requires_capture` with money captured, or `succeeded`. The PHP allowed refunds on partially captured payments too.
- Idempotency is scoped by company. The PHP key was globally unique. A repeat with the same key and the same request returns the stored result and makes no provider call. A different request under the same key is refused.
- Webhooks are verified first. A failed check stores nothing and throws. The PHP stored a rejected row. The signature header is `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. The timestamp header must equal the signed `t`. Tolerance is 300 seconds. A missing secret refuses.
- Webhooks may only apply `canceled` or `failed`. Money-moving states come from the operation path. The PHP applied any status a webhook sent.
- Each webhook is applied once, keyed by provider and event id. A body with no event id falls back to a body hash.
- Payment, BNPL, pricing and rental hire are off unless their flag is exactly `"true"`. Pricing rules off means list prices stand. This is a behaviour change from the PHP, which always applied rules.
- BNPL: the service creates the provider offer only. The PHP also created a payment intent from the offer. Merchant fee is rounded up to the cent. Offer statuses are the contract's `BnplOfferStatus`.
- Tax: the zone's `pricesIncludeTax` is used when set, otherwise the caller's value. Pattern whitespace is removed on both tax and shipping. The PHP removed it from postcodes only.
- Shipping weights are whole grams, not float kilograms. A weight rate charges per started kilogram. Quotes expire after 15 minutes (clamped 1 to 120). A line with no `productType` is physical.
- Rental hire is new design. The PHP has no item availability, deposit or late-return logic. Bookings are inclusive calendar dates. A reserved or active booking holds the item. Two holding bookings that share a day clash. The late fee is charged per day after the grace days, up to an optional cap. The deposit covers the fee first, and the customer owes any excess.
- Credentials are passed in from the commerce credential store, per the contract. This code reads no provider key from the environment and stores none. The owner wires the environment or credential store.
- Tables have no foreign keys to `shared/schema.ts`. The owner adds them when the tables are promoted.
- Migration file is named `0101_commerce_money.sql` as a placeholder. Renumber it if 0101 is taken.

## Concurrency

- The PHP used `SELECT ... FOR UPDATE`. The port uses an in-process keyed lock for the same key or the same intent. (UNVERIFIED against Postgres.)
- Across processes the guards are the unique constraints, and for hire the `commerce_rental_bookings_no_overlap` exclusion constraint in the draft. The Drizzle query builders include `FOR UPDATE` on the overlap read. (UNVERIFIED against Postgres.)
- Known gap: if the provider refund succeeds and the local write then fails, the refund exists only at the provider. Reconcile it from the provider's webhook or retrieve call. The PHP had the same window, but inside one transaction. (UNVERIFIED against Postgres.)

## Not ported

- Coupons (`CouponRuntime.php`). They need reservation state in the database and belong to another slice.
- Tax exemption records and compound tax components. The contract `TaxRate` has no compound flag. Exemption is a per-order flag here.
- Shipping quote persistence and the `ShippingQuote` rows in the PHP.
- The PHP recurring rental model: agreements, charges, ledger, payments and receipts.
- BNPL cancel and BNPL webhook handling. The provider's `verifyWebhook` exists on the contract. This port does not call it.
- Drizzle storage adapters. Only query builders exist for payments and hire. BNPL, tax, shipping and pricing config storage are not written.
- Real provider calls. None are made, per the brief.

## Contract change requests (not made here)

1. `PaymentStatus`: add `partially_captured`, `partially_refunded`, `expired`, `disputed` from the PHP, or confirm that amounts stay the source.
2. `PricingRule`: add `targetId`, `minQuantity`, `minSubtotalMinor`, `customerRef`, `perUnit`. The port carries them in `PricingRuleRecord`.
3. `ShippingCartLine`: add `productType: "physical" | "digital" | "service"`. The port reads it as an optional field.
4. `TaxRate`: add `compound: boolean` if compound components are needed.
5. `PRICING_SCOPES` and `PRICING_RULE_TYPES`: add `shipping` scope and `free_shipping` type, from the PHP.

## Money gaps: coupons, tax exemptions, BNPL cancel and webhook, recurring rental, Drizzle store (2026-11-09)

Owner: money-gaps agent. Files: `coupons.ts`, `tax-exemptions.ts`, `bnpl-lifecycle.ts`, `recurring-rental.ts`, `drizzle-store.ts`, `gap-tables.ts`, `gap-draft.sql`. Edited: `rental-hire.ts` (optional `seriesId` on `HireBooking`), `tax.ts` (optional `shippingExempt` on `OrderTaxInput`), `index.ts` (four new exports). `bnpl.ts` and `drizzle-queries.ts` are unchanged. The "Not ported" list above is partly out of date: coupons, tax exemption records and recurring rentals are now ported, as below.

### Source findings

- `BnplRuntime.php` has no cancel path and no BNPL webhook. Offers are created and then expired by `expireDue`. The cancel and webhook rules are new design, modelled on `PaymentRuntime::processWebhook` (signature first, dedupe, then the state change in one transaction). (UNVERIFIED against Postgres.)
- `RentalHireRuntime.php` models recurring rent as agreements that raise charges per billing period. It has no item availability, so it cannot show that two recurring rentals clash. The recurring port books the item instead (see below).
- `CouponRuntime.php` has no discount maths. The discount is in `PricingRuntime::applyCouponDiscount`, and it is ported in `coupons.ts`.

### Behaviour decisions

- Coupons: `quote()` throws a validation `MoneyError` with the PHP message when a coupon is refused. A caller that wants the PHP non-strict behaviour catches it. The PHP returned null.
- Coupon usage counts redeemed uses and reservations that have not expired. The cart's own reservation is left out of the count, as in the PHP.
- Coupon reservation runs in one transaction: `SELECT ... FOR UPDATE` on the coupon row, the limit check, release of the cart's other reservations, then the upsert. The memory store uses a keyed lock for the same rule. (UNVERIFIED against Postgres.)
- Coupon target ids are strings, not integers, because the port's lines carry product, variant and category ids as strings.
- No coupon feature flag. The PHP coupon path was not flag-gated, and no contract flag exists for coupons.
- Coupon reservation TTL is 30 minutes (clamped 1 to 1440), the PHP default.
- Tax exemption binding: a record is bound to an exemption key or to one customer reference, never both and never neither. A customer-bound record matches only that customer. The PHP matched key OR customer in one query, so a customer-bound record could match a request that carried a key. The port does not reproduce that.
- A record with no tax class exempts the whole order. A record with a class exempts that class, and "shipping" exempts shipping.
- `calculateOrderTax` takes an optional `shippingExempt` flag, so a shipping-only exemption reaches the total. The default is the whole-order flag, so existing callers are unchanged.
- BNPL cancel: allowed from `eligible` and `accepted` only. An `active` or `completed` plan is refused, because it needs a refund rather than a cancel. A repeat cancel of a cancelled offer returns `cancelled` without calling the provider.
- BNPL cancel: the provider must return status `cancelled`. Any other result, or null, is refused as a state error and the local status is left alone. Null from `cancelOffer` is read as "not confirmed". This is an assumption about the contract's null.
- BNPL webhook body: `{ "id", "type", "data": { "offer_id", "status" } }`. No provider sends this today, so the shape is an assumption to confirm when a BNPL provider is wired.
- BNPL webhook signature: the provider's `verifyWebhook` decides. A `false`, a thrown error, or a missing secret is refused with `forbidden`, before any read or write.
- BNPL webhook transitions: eligible to accepted, declined or cancelled. Accepted to active or cancelled. Active to completed. Declined, cancelled and completed have no moves. Any other status is stored as `ignored`.
- BNPL webhook dedupe uses the existing `commerce_payment_webhook_events` table with provider `bnpl:<code>`, and the offer id goes in its `intent_id` column. This reuses a table that exists, instead of adding one.
- BNPL offer id: the port assumes `BnplOffer.id` is the provider's offer id, because `cancelOffer` takes it.
- Recurring rental: frequency is `weekly` (7 days), `fortnightly` (14 days) or `custom` (1 to 365 days). The PHP names `daily`, `monthly` and `one_time` are not ported. A monthly series would need calendar arithmetic, and no one has asked for it.
- Recurring rental: 1 to 52 occurrences, rental 1 to 365 days. The interval must be at least the rental length, so occurrences of one series never overlap each other.
- Recurring rental: every occurrence is checked against the item's reserved and active bookings, from any series or single hire. One clash refuses the whole series. Nothing is written.
- Recurring rental: each occurrence is a normal hire booking with its own deposit, and the series total is the sum. A single deposit for the whole series was not chosen, to keep the single-hire model unchanged.
- Recurring rental: occurrence idempotency keys are `<series key>#<n>`, because the bookings table requires a unique key per booking.
- Recurring rental: cancelling a series is not ported. The gap is listed below.
- Drizzle store: a company id that is not a UUID is treated as absent. The read returns null or an empty list, and the write is refused. This avoids a Postgres uuid error and keeps the tenancy rule.
- Drizzle store: `insertBooking` maps the exclusion-constraint error (23P01) to a `conflict` `MoneyError`, so a booking that bypasses the service check is still refused.
- Drizzle store: `insertSeries` locks the item's holding bookings with `FOR UPDATE` in a transaction, then writes the series, its bookings and the link rows together. (UNVERIFIED against Postgres.)
- Drizzle store: the webhook settlement (offer move and webhook record) runs in one transaction. (UNVERIFIED against Postgres.)
- Drizzle store: payment operations are inserted with a generated uuid as their primary key, because `PaymentOperationRecord` has no id.

### Test coverage

`tests/modules/chatbot-commerce-money-gaps.test.mjs`: 32 tests. 25 run without a database. 7 Drizzle cases run only when `MONEY_GAPS_DATABASE_URL` is set. They were run against a scratch Postgres 16 with `0101_commerce_money.sql` and `gap-draft.sql` applied, and all 32 passed. Concurrency cases: two carts racing for a one-use coupon (one wins), and two overlapping series inserted at once (one stored).

### Change requests (not made here)

1. Move `gap-tables.ts` into `server/modules/chatbot/db/commerce-money.ts`, and `gap-draft.sql` into `db/migrations-draft/` under the next free number after 0310. The money slice may not write to `db/`.
2. Export `drizzle-store.ts` from the money barrel, or document that services import it by path. It is not in the barrel now, so the barrel does not pull in the Drizzle tables.
3. The contract `BnplOffer.id` meaning (provider offer id) and `BnplProvider.cancelOffer` null meaning should be written into `contracts/commerce.ts`.
4. `contracts/flags.ts`: no coupon or tax-exemption flag is needed. Recorded here so the integration pass does not add one by mistake.

### Left

- Cancelling a recurring series (and its reserved occurrences).
- The PHP's monthly, daily and one-time recurring frequencies.
- Outbox events for coupon, exemption, BNPL and series changes (CONVENTIONS section 6). The money code does not write them yet, same as the existing payment code.
- Nothing is applied to a real database. The Drizzle tests ran against a throwaway Postgres 16 cluster in /tmp/money-gaps-pg (database `money_gaps`), not against the harness.
- `db/harness/` was empty when this was written, so the tests could not use it. Set `MONEY_GAPS_DATABASE_URL` to run the Drizzle cases against any Postgres with the two SQL drafts applied.
