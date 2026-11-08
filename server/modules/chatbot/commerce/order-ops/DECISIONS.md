# Commerce order ops: decisions

Source: `extensions/chatbot-ecommerce/System/Services/` in the Commerce Crew repo (copy at `/tmp/commerce-crew/Commerce-Crew-main/`):
MarketplaceInventoryReconciliationRuntime, MarketplaceInventoryConflictRuntime, MarketplaceOrderImportRuntime,
UnifiedOrderProjectorRuntime, UnifiedOrderWorkbenchRuntime, OrderWorkbenchToolRuntime, OrderExceptionRuntime,
OrderSettlementRuntime. Support classes from `System/Support/`: InventoryChannelAllocator, InventoryConflictResolutionPolicy,
MarketplaceInventoryReconciliation, SettlementReconciliation, OrderExceptionDetector, OrderWorkbenchAction, UnifiedOrderSource.

## Placement

- Code: this folder. Tests: `tests/modules/chatbot-commerce-order-ops.test.mjs` (48 tests).
- Drizzle tables: `server/modules/chatbot/db/commerce-order-ops.ts`. The brief and CONVENTIONS.md put tables in `db/`, outside this
  folder, so this is a second write location. It is a new file, and no existing file was edited.
- Migration draft: `server/modules/chatbot/db/migrations-draft/0310_commerce_order_ops.sql`. The number 0310 is a guess to avoid
  the existing 0001 to 0201 drafts. Other agents may pick the same number; rename on promotion if so.
- `commerce/LifecycleRuntime` (CommerceLifecycleRuntime.php) is not ported. It was read but is not in the build list.

## Ported

- Inventory allocation (mirror, equal share, percentage, fixed cap, percentage cap) with basis points and a buffer, using BigInt.
- Inventory assessment: stale, in sync, above target (oversell exposure), below target (undersell). Tolerance applied.
- Scan: discovers mappings by exact SKU (one variant only), reads each listing, assesses it, records conflicts, and closes
  conflicts that return to sync. A scan run records the counts.
- Correction: prepared as a write proposal for the owning seller. It is never applied in this slice.
- Marketplace order import: one page per run, cursor moves only after the page is stored, failure recorded as a hash.
- Unified projection for native orders (from OrderDetail) and marketplace orders. Source hash history per order.
- Exceptions: six types, fingerprint per order and type, open, reopen, auto-resolve, acknowledge, assign, resolve.
- Settlement: entries idempotent by provider, source scope and external id. Reconciliation with evidence hash.
- Workbench: list, sync (needs seller approval), refund proposal, customer-contact draft, and idempotent acknowledge, assign,
  resolve. Owner-only tools.

## Deviations from the PHP (each is intentional)

1. **Money is refused, not cast.** PHP casts amounts with `(int)`. Here a non-integer amount, a negative total or a bad
   currency rejects that payload or entry with a 422. Nothing is truncated.
2. **Invalid marketplace payloads are counted as rejected.** PHP skipped a payload without an external order id and crashed on
   a missing field. Here each invalid payload counts as `recordsRejected`, and the rest of the page still imports.
3. **Conflicts: the history is kept, and the change is in the event.** PHP overwrote the conflict row on each scan. Here the
   `observed_again` event holds the previous and current quantities and status. A conflict with a different code closes the
   old one as `superseded`. Nothing is deleted.
4. **Correction preparation needs `CHATBOT_MARKETPLACE_WRITE_ENABLED`.** PHP did not gate it. Automatic preparation is gated too,
   so with the flag off a scan only records conflicts and never fails because of the flag.
5. **Returned-order dispute is read at projection time.** PHP queried the returns table during each scan. Here
   `sourceSnapshot.return_disputed` is set when a native order is projected from its returns.
6. **Native payment status** comes from `paymentSnapshot.status`, defaulting to `unpaid`. PHP used the payment intent relation.
7. **Native source id** is the order id. PHP used the order uuid. Both are unique per company.
8. **Reconciliation default** is `unreconciled`. The PHP column default is not in the source read here.
9. **Settlement report** is new. Expected lines are signed and sum to `expectedNetMinor`. Reported (payout) lines sum to
   `reportedNetMinor`. Building the report throws if the sums differ from the calculation.
10. **Outbox instead of events.** PHP fired `ExtensionEvent` and metrics. Here state changes write an outbox row through the
    store, in the same transaction. Topics: `commerce.marketplace.inventory.conflict.detected`,
    `commerce.marketplace.inventory.correction.prepared`. The production outbox must join the same database transaction.
11. **List result** returns `total` (count of matches) and a page of items. PHP used a length-aware paginator.
12. **Not ported:** `link_communication_thread` (needs the communication thread table, which is outside this slice), metrics,
    and the lifecycle runtime.
13. **Idempotency** checks for an existing key before insert. The unique index on (company, chatbot, key) backs this in the
    database. PHP caught the duplicate-key exception instead. (UNVERIFIED against Postgres.)
14. **Tenant mismatch returns 404**, as the conventions require. PHP `abort_unless(..., 404)` does the same, and owner checks
    return 422 as PHP did.

## Decisions needing the owner's review

1. **A manual resolve is undone by the next scan while the condition holds.** This is PHP behaviour and it is kept. If the seller
   should be able to close an exception for good, this needs a separate "dismissed" state.
2. **A listing with no quantity field reads as zero.** PHP does the same. Zero reads as below target, so a missing field
   could trigger a correction proposal. Consider treating a missing quantity as "unknown" and blocking.
3. **Nested transactions.** Workbench actions run exception changes inside their own transaction, so the in-memory store nests
   them. A Drizzle store needs savepoint support, or the workbench should call the exception storage directly.
4. **Native orders need a chatbot-wide read.** `OrderService` has no list of all orders for a chatbot (only per session). The
   order projection takes a `NativeOrderSource` port. This needs a read-only function in the orders slice (change request).
5. **SKU lookup needs a catalogue port.** The `VariantLookup` port is used for exact SKU matching. The fulfilment slice does not
   expose variants by SKU.
6. **Write proposals are not in `contracts/commerce.ts`.** `InventoryWriteProposer` is a local port. The marketplace write
   runtime needs a `propose` operation (change request against contracts).
7. **Foreign keys to `chatbots` are omitted.** The orders tables use a composite foreign key to `chatbots`. These tables do not
   yet, so the owner must add it on promotion.

## Drizzle

- Tables are defined in `db/commerce-order-ops.ts` (17 tables). Every table has company_id, a composite primary key, and every
  unique index includes company_id. The test checks all three. (UNVERIFIED against Postgres.)
- `commerce/order-ops/drizzle-queries.ts` has seven query builders for the hot paths. Each takes companyId in its WHERE clause
  (or in the insert values). The tests render them with PgDialect and check the company predicate and the bound company id.
- A full `DrizzleOrderOpsStore` (implementing `OrderOpsStore`) is not written. The in-memory store is the reference
  implementation. UNVERIFIED against Postgres: no test has run the migration draft.

## Tests

`tests/modules/chatbot-commerce-order-ops.test.mjs`: 48 tests, all passing.
Run: `NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-commerce-order-ops.test.mjs`
Scoped strict type check: `tsc -p /home/claude/integration-scratch/order-ops-tc/tsconfig.json` (exit 0, 17 files of this slice
plus their dependencies).

## Section: Drizzle store, thread linking, lifecycle (2026-11-09)

Files: `drizzle-store.ts` (new), `thread-link.ts` (new), `lifecycle.ts` (new), `ports.ts` (one port added), `storage.ts` (outbox made idempotent by dedupe key), `index.ts` (exports). Tests: `tests/modules/chatbot-commerce-marketplace-ops.test.mjs` (21 tests, all pass, shared with the marketplace slice). The existing `chatbot-commerce-order-ops.test.mjs` (48) still passes. Real Postgres: 16 checks pass against a scratch database (see the last bullet).

### Decisions

1. **Drizzle store implements `OrderOpsStore`.** It uses the 17 existing tables in `db/commerce-order-ops.ts`. The outbox uses `chatbotEventOutbox` from `db/events.ts`. No table was added or edited.
2. **Tenancy.** Every query has `company_id` in its WHERE clause, or in the insert values. Every returned row is also checked in code for both company and id. A patch cannot change `id` or `companyId`. A missing company is refused before any query is built.
3. **`find` and `list` read the company's rows and filter in memory.** The services pass JavaScript predicates, which SQL cannot run, so this is correct but not indexed. Before production, the large tables (conflicts, orders, exceptions) need predicates that map to SQL. The builders in `drizzle-queries.ts` are the hot paths.
4. **Transactions.** `transaction()` opens a database transaction. A nested call is a savepoint. Expected behaviour: a failed transaction leaves no row, and a failed inner savepoint rolls back only its own work (UNVERIFIED against Postgres; owner decision 2026-11-09). This resolves the nested-transaction question in the earlier decisions (item 3 under "Decisions needing the owner's review"). (UNVERIFIED against Postgres.)
5. **Outbox is idempotent by dedupe key in both stores.** The in-memory store used to write duplicates. The Drizzle store uses ON CONFLICT DO NOTHING on (company_id, dedupe_key), which the events table already has as a unique index. (UNVERIFIED against Postgres.)
6. **Thread linking is recorded as a workbench action** (`link_communication_thread`), with `proposal.threadId`. It is audited through the existing actions table. The thread table is not written.
7. **A thread links once.** The same thread to the same order returns the existing link and writes nothing. The same thread to a different order returns 409. The same idempotency key with another request returns 422. A thread from another company or chatbot returns 404.
8. **Thread existence is read through `CommunicationThreadPort`.** The conversational slice owns the thread table, so order-ops only reads it.
9. **Lifecycle runtime** is a port of `CommerceLifecycleRuntime.php` and `LifecycleStatus.php`. Transitions are checked: enabled to disabled or uninstalling, disabled to enabled or uninstalling, uninstalling to enabled or uninstalled, uninstalled to enabled. Any other move throws 409 and writes nothing. Asking for the current status is a no-op. The PHP wrote any status over any other.
10. **Lifecycle state is kept per company.** PHP keeps one row for the whole install. The owner may choose otherwise.
11. **Lifecycle data is always preserved.** Nothing in this runtime deletes order, customer or stock data.
12. **Each lifecycle change saves an event with the state**, through `LifecycleStateStore.save`. The in-memory store keeps the events for tests.
13. **Lifecycle lives in `order-ops/`** because this is the only folder I may write to. The owner may move it to `commerce/` root.

### Change requests (owner review, not edited here)

- `db/commerce-order-ops.ts`: add `thread_id` to `chatbot_commerce_workbench_actions` (or a link table) with a unique index on (company_id, chatbot_id, thread_id). Until then, the "links once" rule is checked in code inside a transaction. Two requests that race could both pass. This is the main gap in item 7. (UNVERIFIED against Postgres.)
- `db/commerce-order-ops.ts`: add `chatbot_commerce_lifecycle_states` (company_id, extension_key, status with a check constraint, installed_version, reason, four timestamps, primary key (company_id, extension_key)). The Drizzle version of `LifecycleStateStore` depends on it. (UNVERIFIED against Postgres.)
- `db/commerce-order-ops.ts`: the timestamps are `timestamp` without time zone. CONVENTIONS section 3 says `timestamptz`. The migration draft and the table file need changing together.
- `conversational` slice: a read function `findThread(companyId, chatbotId, threadId)` that satisfies `CommunicationThreadPort`.

### Verification against real Postgres (scratch, not in the repo)

- Local cluster from `db/harness/pg-local.sh`, scratch database `order_ops_scratch`.
- Applied `db/migrations-draft/0310_commerce_order_ops.sql` in full.
- Applied only the `chatbot_event_outbox` table and its two indexes from `0301_events.sql`. The rest of 0301 references `chatbot_conversations`, which is not in this scratch database.
- Script: `/home/claude/integration-scratch/pg-check/run.mjs`. 16 checks, all pass: tenancy, JSON and bigint round trip, outbox dedupe, rollback, savepoint, thread linking, lifecycle.
- `apply-drafts.mjs` in the harness does not exist yet, so the draft was applied by hand.

### Not built

- A Drizzle `LifecycleStateStore` (needs the table above).
- Predicate-to-SQL for the hot list paths (decision 3).
- Inventory reconciliation, order import and the native order list are unchanged. They keep their current behaviour and tests.
