# Fulfilment, inventory and dispatch: decisions

Port of the Commerce Crew `chatbot-ecommerce` inventory and fulfilment domain (PHP/Laravel) to
TypeScript for the Desk chatbot module. Scope is the domain logic only. Tests are in
`tests/modules/chatbot-fulfilment.test.mjs` (20 tests).

## Files

| File | Role |
| --- | --- |
| `types.ts` | Record shapes and status constants. Ids are strings. Every record has `companyId`. |
| `state.ts` | Pure rules: fulfilment and reservation transitions, aggregate status, availability, stable JSON for request hashing. |
| `support.ts` | Input checks, stock row locking, stale-reservation sweep. |
| `fulfilment-storage.ts` | Company-scoped `FulfilmentStorage` interface and in-memory implementation. |
| `inventory.ts` | Stock levels, adjustments, reserve, release, commit, expiry sweep. |
| `fulfilment-service.ts` | Order snapshot, fulfilment create, dispatch transitions, order summary. |
| `carrier-gateway.ts` | Carrier interface with a no-op default. |
| `index.ts` | Flag check and `createFulfilmentModule` factory. |
| `schema.DRAFT.ts` | Drizzle table fragment. Not imported, not applied. |

## Scope not ported

- Carrier rate lookups and label printing. Behind `CarrierGateway`; default is `noopCarrierGateway`, which returns no rates and no label. Nothing calls it yet.
- Payment, shipping quotes and `InternalShippingProvider`, WhatsApp, Telegram and Ably transports.
- Marketplace inventory mapping, scan jobs and conflict resolution (`MarketplaceInventory*`).
- HTTP controllers. Routes belong to the integration agent.
- `Metrics` and `ExtensionEvent` emission. The Desk event mechanism has not been decided.
- Checkout-session status sync (`fulfillment_status` on the checkout). Status is computed on demand by `summaryForOrder`.
- Per-item `metadata` merging from the PHP `FulfillmentRuntime`.
- The SQL migration. Drizzle tables and `DrizzleFulfilmentStorage` exist (see the Drizzle section). No migration is applied.

## Decisions for owner review

1. **Off by default.** `CHATBOT_FULFILMENT_ENABLED` must be exactly `"true"`. Otherwise `createFulfilmentModule` throws a 404. This follows the `process.env.X === 'true'` pattern in the Desk server.

2. **Fulfilment is coupled to stock (behaviour change).** The PHP fulfilment never touched stock. The brief requires that fulfilment cannot exceed what is available, so a physical fulfilment now:
   - on create, draws `allocated += qty` from committed stock at its location. It must fit within `committed - allocated`. Reserved-only stock is not enough.
   - on ship, decrements `quantity`, `committed` and `allocated` by the shipped quantity.
   - on cancel, releases `allocated`.
   Confirm this is the intended model. The alternative is to keep PHP behaviour and enforce only the order-quantity rule.

3. **Physical fulfilments need a `locationId`.** The PHP allowed null. Stock is per location, so a null location has no defined source. Digital fulfilments skip stock entirely.

4. **Backorder flag moved to the stock row.** PHP reads `ProductVariant.allow_backorder`. The product tables are outside this slice, so `allowBackorder` lives on `StockRecord` and defaults to `false`.

5. **Cart quantity is passed in.** PHP `reserve()` reads the cart's lines to cap reservations. Cart is outside this slice, so the caller passes `holderQuantity`.

6. **Order snapshot replaces checkout.** `registerOrder()` stores what was sold: id, reference and lines. The integration calls it when checkout completes. The PHP "checkout must be completed" check is replaced by "committed stock exists".

7. **Idempotency keys are scoped per company.** PHP uses a global unique key. Scoping by company keeps tenants isolated, so one company's key cannot collide with another's.

8. **Adjustments check the payload on replay.** PHP returns the existing adjustment for a repeated key without comparing the payload. The port returns 409 when the variant, location or delta differ. This is a deliberate deviation.

9. **Commit after expiry persists the expiry, then fails.** This matches PHP. The expiry is written, and the 422 is thrown only after the transaction commits.

10. **Tracking required for delivery defaults to off.** Matches the PHP config default. Passed as `requireTrackingForDelivery`.

11. **Availability does not sweep stale reservations.** Matches PHP. Availability can under-report until `expireDue` runs.

12. **Reservation TTL** defaults to 15 minutes and is clamped to 1 to 120, as in PHP. Reservation quantity is 1 to 999.

## Concurrency

`transaction()` in the in-memory storage serialises work per company and rolls back on throw. The in-memory version is single-process only. `DrizzleFulfilmentStorage` maps it to a database transaction with `SELECT ... FOR UPDATE` on the stock row (see the Drizzle section). UNVERIFIED against Postgres.

## Schema draft

- Every table has `company_id`. Child tables use composite FKs on `(company_id, id)`.
- Stock check constraints (draft, UNVERIFIED against Postgres): `reserved, committed, allocated >= 0`, `allocated <= committed`, `quantity >= reserved + committed + damaged`.
- Null-location stock rows need a partial unique index `WHERE location_id IS NULL`. A plain unique index does not stop duplicate NULL keys (UNVERIFIED against Postgres).
- The integration agent must add `pgTable` exports to `shared/schema.ts` and write the matching SQL.

## Drizzle

Date: 2026-11-08. Files: `db/fulfilment.ts` (tables), `fulfilment-storage.ts` (`DrizzleFulfilmentStorage`, query builders, error mapping). The in-memory storage and its interface are unchanged. Tests: `tests/modules/chatbot-fulfilment-drizzle.test.mjs` (20 tests).

1. **Tables.** Eight `chatbot_` tables, snake_case columns, `company_id` NOT NULL on every one. The interface needs locations, orders and order lines as well as the four listed in the brief, so all eight exist. Not added to `shared/schema.ts`. No migration.
2. **Primary keys are `(company_id, id)`.** An upsert on the key cannot overwrite another tenant's row. Stock, adjustment and fulfilment-item rows use a uuid id, because their records have no id field.
3. **Stock cannot go negative in the database.** CHECK constraints: `reserved`, `committed`, `allocated` >= 0; `allocated` <= `committed`; `quantity` >= `reserved + committed + damaged`. A write that breaks one maps to a 409. The service still checks availability first, under the row lock. UNVERIFIED against Postgres.
4. **Locking.** `transaction()` runs a database transaction. Inside it, `getStock` reads with `SELECT ... FOR UPDATE`. Outside it, reads take no lock. Every stock-changing service path already runs inside `storage.transaction`, so the lock covers reserve, adjust, release, commit, expiry and fulfilment create. UNVERIFIED against Postgres.
5. **Null location.** A partial unique index on `(company_id, variant_id) WHERE location_id IS NULL` covers the company-wide row. `saveStock` tries an update with `IS NULL`, then inserts if nothing changed. The row lock keeps that safe. UNVERIFIED against Postgres.
6. **Idempotency keys.** Unique on `(company_id, key)` for reservations, adjustments and fulfilments. The service re-checks the key after it takes the lock, so a normal replay returns the stored record. Only a true race between two first requests reaches the index, and that returns a 409 instead of the stored record. UNVERIFIED against Postgres.
7. **Errors.** 23505 and 23514 become `ChatbotError` with status 409. Service errors pass through unchanged, so a rolled-back transaction reports the real reason. UNVERIFIED against Postgres.
8. **Concurrency.** The per-company in-process lock stays in `createMemoryFulfilmentStorage` only. Across processes, the Drizzle path relies on row locks. UNVERIFIED against Postgres.

Not verified: no run against a live Postgres. The tests use a recording in-process client (no socket) and assert the SQL. The CHECK constraints and partial indexes have not been applied to a database.
