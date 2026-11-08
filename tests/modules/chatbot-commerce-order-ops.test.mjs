// Commerce order ops: inventory reconciliation, marketplace order import, unified projection, exceptions,
// settlement and the workbench. No network: the HttpClient passed in throws if anything calls it.
// Drizzle queries are rendered with PgDialect and checked for a company_id predicate. No database is reached.
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { createOrderOps, createMemoryOrderOpsStore, OrderOpsError, canonicalStockFromFulfilment } from "../../server/modules/chatbot/commerce/order-ops/index.ts";
import { allocate, assess, evaluateResolution } from "../../server/modules/chatbot/commerce/order-ops/inventory-math.ts";
import { detectExceptions, exceptionFingerprint } from "../../server/modules/chatbot/commerce/order-ops/exception-detector.ts";
import { calculateSettlement, buildSettlementReport } from "../../server/modules/chatbot/commerce/order-ops/settlement-math.ts";
import { assertMinor, assertCurrency, hashOf } from "../../server/modules/chatbot/commerce/order-ops/canonical.ts";
import * as queries from "../../server/modules/chatbot/commerce/order-ops/drizzle-queries.ts";
import * as dbTables from "../../server/modules/chatbot/db/commerce-order-ops.ts";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHATBOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION = "conn-ebay-1";
const OWNER = "user-owner";
const STRANGER = "user-other";
const VARIANT = "variant-1";
const START = new Date("2026-11-08T10:00:00.000Z");
const WRITE_ON = { CHATBOT_MARKETPLACE_WRITE_ENABLED: "true" };

const dialect = new PgDialect();
const render = (query) => dialect.sqlToQuery(query.getSQL());

function world({ env = {}, stock = 10, skus = {}, listing = null, pages = [], importError = null, nativeOrders = [] } = {}) {
  let clock = new Date(START);
  const now = () => new Date(clock);
  const store = createMemoryOrderOpsStore();
  const calls = { getListing: 0, importOrders: 0, propose: [], http: 0, execute: 0 };
  const state = { listing, listingError: null, pages: [...pages] };
  const provider = {
    key: "ebay",
    capabilities: () => ["read_listings", "read_inventory", "import_orders"],
    read: {
      searchListings: async () => ({ rows: [], nextCursor: null }),
      getListing: async () => {
        calls.getListing++;
        if (state.listingError) throw state.listingError;
        return state.listing;
      },
      getInventory: async () => [],
      importOrders: async () => {
        calls.importOrders++;
        if (importError) throw importError;
        return state.pages.length > 0 ? state.pages.shift() : { orders: [], nextCursor: null };
      },
    },
    write: null,
    rateLimit: { acquire: async () => ({ allowed: true, retryAfterMs: null, remaining: null }), observe: async () => {}, recordFailure: async () => {} },
  };
  const ops = createOrderOps({
    store,
    native: { listForChatbot: async (companyId, chatbotId) => nativeOrders.filter((d) => d.order.companyId === companyId && d.order.chatbotId === chatbotId) },
    marketplaces: { get: () => provider },
    writes: {
      propose: async (input) => {
        calls.propose.push(input);
        return { proposalId: `proposal-${calls.propose.length}` };
      },
    },
    stock: {
      read: async (companyId, variantId) => (companyId === COMPANY_A && variantId === VARIANT ? { quantity: stock, reserved: 0, committed: 0, incoming: 0, damaged: 0, safetyStock: 0, available: stock, version: 3 } : null),
    },
    variants: { idsBySku: async (companyId, sku) => skus[`${companyId}:${sku}`] ?? [] },
    http: async () => {
      calls.http++;
      throw new Error("network call attempted in a test");
    },
    env,
    now,
  });
  return {
    ops,
    store,
    calls,
    state,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    scope(companyId = COMPANY_A, overrides = {}) {
      return { companyId, chatbotId: CHATBOT, connectionId: CONNECTION, provider: "ebay", ownerUserId: OWNER, ...overrides };
    },
  };
}

function listingAt(quantity, observedAt = START) {
  return { externalListingId: "L-1", title: "Mop", priceMinor: 1000, currency: "AUD", quantity, sourceHash: `h-${quantity}`, raw: { quantity, sku: "SKU-1" } };
}

async function mappedWorld(options = {}) {
  const w = world({ skus: { [`${COMPANY_A}:SKU-1`]: [VARIANT] }, ...options });
  w.state.listing = listingAt(options.externalQuantity ?? 4);
  const base = w.scope();
  // The listing snapshot normally comes from the marketplace sync. Seed it so SKU discovery can find it.
  await w.store.listings.insert(COMPANY_A, {
    chatbotId: CHATBOT, connectionId: CONNECTION, provider: "ebay", externalListingId: "L-1",
    sourceHash: "seed", snapshot: { sku: "SKU-1", quantity: 0 }, firstSeenAt: START, lastSeenAt: START,
  });
  await w.ops.inventory.discoverMappings(COMPANY_A, base);
  const mapping = (await w.store.mappings.list(COMPANY_A))[0];
  await w.ops.inventory.verifyMapping(COMPANY_A, base, mapping.id, OWNER);
  return { ...w, mapping };
}

const ORDER_PAYLOAD = (overrides = {}) => ({
  external_order_id: "EB-1",
  status: "paid",
  currency: "AUD",
  total_amount: 2500,
  placed_at: "2026-11-08T09:00:00.000Z",
  updated_at: "2026-11-08T09:30:00.000Z",
  buyer: { display_name: "Sam" },
  shipping_address: { line1: "1 Main St", city: "Melbourne", country: "AU" },
  lines: [{ external_line_id: "L1", sku: "SKU-1", title: "Mop", quantity: 2, unit_amount: 1000, tax_amount: 200 }],
  ...overrides,
});

function nativeDetail(companyId, overrides = {}) {
  const placed = new Date(START.getTime() - 3 * 86_400_000);
  const order = {
    id: "order-native-1", companyId, orderNumber: "N-1", chatbotId: CHATBOT, cartId: null, checkoutId: "co-1",
    paymentIntentId: null, customerIdentityId: null, conversationId: null, sessionId: null, source: "internal",
    status: "paid", fulfillmentStatus: "unfulfilled", currency: "AUD", subtotal: 2000, discountTotal: 0, taxTotal: 200,
    shippingTotal: 300, total: 2500, refundedTotal: 0, customerSnapshot: { name: "Alex" }, billingAddress: {},
    shippingAddress: { line1: "2 High St", city: "Sydney", country: "AU" }, paymentSnapshot: { status: "succeeded" },
    metadata: {}, placedAt: placed, confirmedAt: null, completedAt: null, cancelledAt: null, createdAt: placed, updatedAt: placed,
    ...overrides.order,
  };
  return { order, items: [], events: [], returns: overrides.returns ?? [] };
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test("allocation keeps the buffer back and splits the rest equally across channels", () => {
  const a = allocate(10, { bufferQuantity: 2, channelCount: 4, allocationMode: "equal_share" });
  assert.equal(a.distributable, 8);
  assert.equal(a.targetQuantity, 2);
});

test("allocation refuses an unknown mode and caps a percentage in basis points", () => {
  assert.throws(() => allocate(10, { allocationMode: "guess" }), OrderOpsError);
  assert.equal(allocate(10, { allocationMode: "percentage", allocationBps: 5000 }).targetQuantity, 5);
});

test("a stale marketplace observation is critical and blocks correction", () => {
  const result = assess(
    { quantity: 10, reserved: 0, committed: 0, available: 10, version: 1 },
    { quantity: 10, observedAt: new Date(START.getTime() - 3_600_000), sourceHash: "h" },
    { targetQuantity: 10, maximumSyncAgeSeconds: 300, quantityTolerance: 0 },
    START.getTime(),
  );
  assert.equal(result.code, "external_state_stale");
  assert.equal(result.severity, "critical");
  assert.equal(result.blocking, true);
});

test("marketplace stock above target is flagged as oversell exposure", () => {
  const result = assess(
    { quantity: 10, reserved: 0, committed: 0, available: 10, version: 1 },
    { quantity: 13, observedAt: START, sourceHash: "h" },
    { targetQuantity: 10, maximumSyncAgeSeconds: 300, quantityTolerance: 0 },
    START.getTime(),
  );
  assert.equal(result.code, "external_above_target");
  assert.equal(result.oversellExposure, 3);
  assert.equal(result.delta, -3);
});

test("automatic preparation never marks an execution as automatic", () => {
  const eligibility = evaluateResolution(
    { resolutionMode: "auto_prepare", requireFreshSnapshot: true, maximumAutoDelta: 5 },
    { conflict: true, blocking: false, snapshotFresh: true, delta: 2 },
  );
  assert.equal(eligibility.autoPrepare, true);
  assert.equal(eligibility.autoExecute, false);
});

test("money must be an integer in minor units and currency must be upper case", () => {
  assert.equal(assertMinor(2500, "total"), 2500);
  assert.throws(() => assertMinor(25.5, "total"), OrderOpsError);
  assert.throws(() => assertMinor(Number.NaN, "total"), OrderOpsError);
  assert.throws(() => assertCurrency("aud"), OrderOpsError);
});

test("canonical hashes do not depend on key order", () => {
  assert.equal(hashOf({ a: 1, b: { c: 2, d: 3 } }), hashOf({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
});

test("exception detection flags a missing address and a stale unfulfilled order, and skips digital orders", () => {
  const items = detectExceptions(
    { paymentStatus: "succeeded", fulfillmentStatus: "unfulfilled", placedAtMs: START.getTime() - 3 * 86_400_000, shippingAddress: {}, stockConflict: false, returnDisputed: false, reconciliationStatus: "unreconciled" },
    START.getTime(),
    172_800,
  );
  const types = items.map((i) => i.type).sort();
  assert.deepEqual(types, ["fulfillment_delay", "invalid_address"]);
  const digital = detectExceptions({ paymentStatus: "succeeded", fulfillmentStatus: "digital", placedAtMs: 0, shippingAddress: {}, stockConflict: false, returnDisputed: false, reconciliationStatus: "unreconciled" }, START.getTime(), 172_800);
  assert.equal(digital.length, 0);
  assert.notEqual(exceptionFingerprint("o1", "invalid_address"), exceptionFingerprint("o1", "payment_failure"));
});

test("settlement report lines sum to the expected net and the reported net", () => {
  const cases = [
    [{ type: "sale", amount: 2500 }, { type: "fee", amount: -300 }, { type: "payout", amount: 2200 }],
    [{ type: "sale", amount: 4000 }, { type: "refund", amount: 500 }, { type: "chargeback", amount: 120 }, { type: "tax", amount: 80 }, { type: "shipping_cost", amount: 150 }, { type: "adjustment", amount: 25 }, { type: "payout", amount: 3000 }],
    [{ type: "sale", amount: 999 }, { type: "fee", amount: 33 }, { type: "payout", amount: 1 }],
  ];
  for (const entries of cases) {
    const report = buildSettlementReport("AUD", entries);
    const expectedSum = report.lines.filter((l) => l.kind === "expected").reduce((s, l) => s + l.amountMinor, 0);
    const reportedSum = report.lines.filter((l) => l.kind === "reported").reduce((s, l) => s + l.amountMinor, 0);
    assert.equal(report.expectedNetMinor, expectedSum);
    assert.equal(report.reportedNetMinor, reportedSum);
    assert.equal(report.varianceMinor, reportedSum - expectedSum);
    assert.equal(calculateSettlement(entries).expectedNetAmount, expectedSum);
    for (const line of report.lines) assert.equal(Number.isSafeInteger(line.amountMinor), true);
  }
});

test("settlement reports awaiting payout until a payout entry arrives", () => {
  const report = buildSettlementReport("AUD", [{ type: "sale", amount: 2500 }, { type: "fee", amount: 300 }]);
  assert.equal(report.status, "awaiting_payout");
  assert.equal(report.reportedNetMinor, 0);
});

// ---------------------------------------------------------------------------
// Inventory reconciliation
// ---------------------------------------------------------------------------

test("a conflict is recorded and the old one is kept when the state changes, with no marketplace write", async () => {
  const w = await mappedWorld({ externalQuantity: 4 });
  const first = await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  assert.equal(first.status, "completed");
  assert.equal(first.conflictCount, 1);
  const [conflictA] = await w.ops.inventory.listConflicts(COMPANY_A, w.scope());
  assert.equal(conflictA.code, "external_below_target");
  assert.equal(conflictA.status, "open");

  w.state.listing = listingAt(12);
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const all = await w.store.conflicts.list(COMPANY_A);
  assert.equal(all.length, 2, "the first conflict is kept, not deleted or overwritten");
  const old = await w.store.conflicts.get(COMPANY_A, conflictA.id);
  assert.equal(old.status, "resolved");
  assert.equal(old.resolutionMode, "superseded");
  const trail = await w.store.conflictEvents.list(COMPANY_A, (e) => e.conflictId === conflictA.id);
  assert.deepEqual(trail.map((e) => e.eventType), ["detected", "superseded"]);
  assert.equal(w.calls.propose.length, 0, "no stock change was proposed or applied");
});

test("the same conflict seen again writes an event holding the previous and current values", async () => {
  const w = await mappedWorld({ externalQuantity: 4 });
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const [conflict] = await w.ops.inventory.listConflicts(COMPANY_A, w.scope());
  w.advance(60_000);
  w.state.listing = listingAt(3);
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const trail = await w.store.conflictEvents.list(COMPANY_A, (e) => e.conflictId === conflict.id);
  const again = trail.find((e) => e.eventType === "observed_again");
  assert.ok(again, "observed_again event recorded");
  assert.equal(again.payload.previous.external_quantity, 4);
  assert.equal(again.payload.current.external_quantity, 3);
  assert.equal(w.calls.propose.length, 0);
});

test("a stale listing that cannot be refreshed becomes a critical conflict and blocks correction", async () => {
  const w = await mappedWorld({ externalQuantity: 10 });
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  assert.equal((await w.ops.inventory.listConflicts(COMPANY_A, w.scope())).length, 0, "in sync at first");
  w.advance(20 * 60_000);
  w.state.listingError = new Error("provider timeout");
  const run = await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  assert.equal(run.criticalCount, 1);
  const [conflict] = await w.ops.inventory.listConflicts(COMPANY_A, w.scope());
  assert.equal(conflict.code, "external_state_stale");
  assert.equal(conflict.severity, "critical");
});

test("an unverified mapping still records the conflict but cannot be corrected", async () => {
  const w = world({ env: WRITE_ON, skus: { [`${COMPANY_A}:SKU-1`]: [VARIANT] } });
  w.state.listing = listingAt(4);
  const scope = w.scope();
  await w.store.listings.insert(COMPANY_A, {
    chatbotId: CHATBOT, connectionId: CONNECTION, provider: "ebay", externalListingId: "L-1",
    sourceHash: "seed", snapshot: { sku: "SKU-1" }, firstSeenAt: START, lastSeenAt: START,
  });
  await w.ops.inventory.discoverMappings(COMPANY_A, scope);
  await w.ops.inventory.scan(COMPANY_A, scope, OWNER);
  const [conflict] = await w.ops.inventory.listConflicts(COMPANY_A, scope);
  assert.ok(conflict, "conflict recorded");
  await assert.rejects(() => w.ops.inventory.prepareCorrection(COMPANY_A, scope, conflict.id, OWNER), (e) => e.status === 422 && /verify/i.test(e.message));
  assert.equal(w.calls.propose.length, 0);
});

test("preparing a correction needs the write flag, and only prepares a proposal", async () => {
  const off = await mappedWorld({ externalQuantity: 4 });
  await off.ops.inventory.scan(COMPANY_A, off.scope(), OWNER);
  const [c1] = await off.ops.inventory.listConflicts(COMPANY_A, off.scope());
  await assert.rejects(() => off.ops.inventory.prepareCorrection(COMPANY_A, off.scope(), c1.id, OWNER), (e) => e.status === 403);
  assert.equal(off.calls.propose.length, 0);

  const on = await mappedWorld({ externalQuantity: 4, env: WRITE_ON });
  await on.ops.inventory.scan(COMPANY_A, on.scope(), OWNER);
  const [c2] = await on.ops.inventory.listConflicts(COMPANY_A, on.scope());
  const result = await on.ops.inventory.prepareCorrection(COMPANY_A, on.scope(), c2.id, OWNER);
  assert.equal(result.proposalId, "proposal-1");
  assert.equal(result.conflict.status, "resolution_prepared");
  assert.equal(on.calls.propose.length, 1);
  assert.equal(on.calls.propose[0].quantity, 10);
  assert.equal(on.calls.propose[0].expectedSourceHash, c2.sourceHash, "the write quotes the hash it was based on");
  assert.equal(on.calls.execute, 0);
});

test("only the owning seller can prepare or verify a correction", async () => {
  const w = await mappedWorld({ externalQuantity: 4, env: WRITE_ON });
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const [conflict] = await w.ops.inventory.listConflicts(COMPANY_A, w.scope());
  await assert.rejects(() => w.ops.inventory.prepareCorrection(COMPANY_A, w.scope(), conflict.id, STRANGER), (e) => e.status === 422);
  assert.equal(w.calls.propose.length, 0);
});

test("automatic preparation prepares a bounded correction, and an in-sync scan resolves it", async () => {
  const w = await mappedWorld({ externalQuantity: 8, env: WRITE_ON });
  await w.ops.inventory.setPolicy(COMPANY_A, w.scope(), { resolutionMode: "auto_prepare", maximumAutoDelta: 5 });
  const run = await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  assert.equal(run.correctionsPrepared, 1);
  assert.equal(w.calls.propose.length, 1);
  w.state.listing = listingAt(10);
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const conflicts = await w.store.conflicts.list(COMPANY_A);
  assert.equal(conflicts.every((c) => c.status === "resolved"), true);
  assert.equal(conflicts.find((c) => c.writeProposalId).resolutionMode, "inventory_returned_to_sync");
});

test("automatic preparation does nothing while the write flag is off", async () => {
  const w = await mappedWorld({ externalQuantity: 8 });
  await w.ops.inventory.setPolicy(COMPANY_A, w.scope(), { resolutionMode: "auto_prepare", maximumAutoDelta: 5 });
  const run = await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  assert.equal(run.status, "completed");
  assert.equal(run.correctionsPrepared, 0);
  assert.equal(w.calls.propose.length, 0);
});

test("ignoring a conflict needs a reason and is audited", async () => {
  const w = await mappedWorld({ externalQuantity: 4 });
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const [conflict] = await w.ops.inventory.listConflicts(COMPANY_A, w.scope());
  await assert.rejects(() => w.ops.inventory.ignore(COMPANY_A, w.scope(), conflict.id, OWNER, "   "), (e) => e.status === 422);
  const ignored = await w.ops.inventory.ignore(COMPANY_A, w.scope(), conflict.id, OWNER, "Seasonal stock, known", 24);
  assert.equal(ignored.status, "ignored");
  const trail = await w.store.conflictEvents.list(COMPANY_A, (e) => e.conflictId === conflict.id && e.eventType === "ignored");
  assert.equal(trail[0].payload.reason, "Seasonal stock, known");
});

test("inventory state is invisible to another company", async () => {
  const w = await mappedWorld({ externalQuantity: 4 });
  await w.ops.inventory.scan(COMPANY_A, w.scope(), OWNER);
  const other = w.scope(COMPANY_B);
  assert.deepEqual(await w.ops.inventory.listConflicts(COMPANY_B, other), []);
  await assert.rejects(() => w.ops.inventory.listConflicts(COMPANY_B, w.scope(COMPANY_A)), (e) => e.status === 404);
});

// ---------------------------------------------------------------------------
// Marketplace order import
// ---------------------------------------------------------------------------

test("importing the same order twice creates one marketplace order and one unified order", async () => {
  const page = { orders: [ORDER_PAYLOAD()], nextCursor: { page: 2 } };
  const w = world({ pages: [page, { orders: [ORDER_PAYLOAD({ status: "shipped" })], nextCursor: { page: 3 } }] });
  const first = await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  const second = await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  assert.equal(first.recordsCreated, 1);
  assert.equal(second.recordsCreated, 0);
  assert.equal(second.recordsUpdated, 1);
  assert.equal((await w.store.marketplaceOrders.list(COMPANY_A)).length, 1);
  assert.equal((await w.store.marketplaceLines.list(COMPANY_A)).length, 1);
  const unified = await w.store.unifiedOrders.list(COMPANY_A);
  assert.equal(unified.length, 1);
  assert.equal(unified[0].status, "shipped", "the later import updates the same order");
  assert.equal(unified[0].externalAuthoritative, true);
});

test("an invalid payload is rejected and the rest of the page still imports", async () => {
  const bad = ORDER_PAYLOAD({ external_order_id: "EB-BAD", total_amount: 19.99 });
  const w = world({ pages: [{ orders: [bad, ORDER_PAYLOAD()], nextCursor: { page: 2 } }] });
  const run = await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  assert.equal(run.status, "completed");
  assert.equal(run.recordsRejected, 1);
  assert.equal(run.recordsCreated, 1);
  const cursor = await w.store.cursors.find(COMPANY_A, (c) => c.connectionId === CONNECTION);
  assert.deepEqual(cursor.cursor, { page: 2 });
});

test("a failed import records a hashed reason and leaves the cursor where it was", async () => {
  const w = world({ importError: new Error("upstream said: secret-token-xyz") });
  const run = await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  assert.equal(run.status, "failed");
  assert.match(run.failureReason, /^Marketplace order import failed: [0-9a-f]{64}$/);
  assert.equal(run.failureReason.includes("secret-token-xyz"), false);
  const cursor = await w.store.cursors.find(COMPANY_A, (c) => c.connectionId === CONNECTION);
  assert.deepEqual(cursor.cursor, {}, "cursor does not advance on failure");
});

// ---------------------------------------------------------------------------
// Unified projection
// ---------------------------------------------------------------------------

test("the projection never mixes two companies, even with the same external order id", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  w.state.pages.push({ orders: [ORDER_PAYLOAD({ buyer: { display_name: "Other" } })], nextCursor: null });
  await w.ops.orderImport.importOrders(COMPANY_B, w.scope(COMPANY_B));
  const rowsA = await w.store.unifiedOrders.list(COMPANY_A);
  const rowsB = await w.store.unifiedOrders.list(COMPANY_B);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.notEqual(rowsA[0].id, rowsB[0].id);
  assert.equal(rowsA[0].buyerDisplayName, "Sam");
  assert.equal(rowsB[0].buyerDisplayName, "Other");
});

test("projecting a marketplace order under another company is refused", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  const [order] = await w.store.marketplaceOrders.list(COMPANY_A);
  const lines = await w.store.marketplaceLines.list(COMPANY_A);
  await assert.rejects(() => w.ops.projector.projectMarketplace(COMPANY_B, order, lines), (e) => e.status === 404);
  assert.equal((await w.store.unifiedOrders.list(COMPANY_B)).length, 0);
});

test("a native order is projected with its payment status and a disputed-return flag", async () => {
  const detail = nativeDetail(COMPANY_A, { returns: [{ returnRecord: { id: "r1", status: "disputed" }, items: [] }] });
  const w = world({ nativeOrders: [detail] });
  const projected = await w.ops.projector.projectNative(COMPANY_A, detail);
  assert.equal(projected.sourceType, "native");
  assert.equal(projected.paymentStatus, "succeeded");
  assert.equal(projected.grossTotal, 2500);
  assert.equal(projected.externalAuthoritative, false);
  assert.equal(projected.sourceSnapshot.return_disputed, true);
  assert.equal(projected.reconciliationStatus, "unreconciled");
});

test("syncing a chatbot projects its native and marketplace orders", async () => {
  const detail = nativeDetail(COMPANY_A);
  const w = world({ nativeOrders: [detail], pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  const counts = await w.ops.projector.syncChatbot(COMPANY_A, CHATBOT, { listForChatbot: async () => [detail] });
  assert.deepEqual(counts, { native_projected: 1, external_projected: 1, total_projected: 2 });
  assert.equal((await w.store.unifiedOrders.list(COMPANY_A)).length, 2);
});

test("the fulfilment stock reader sums locations only when no location is given", async () => {
  const views = { "loc-1": { quantity: 4, reserved: 1, committed: 0, incoming: 0, damaged: 0, safetyStock: 0, available: 3, version: 1 }, "loc-2": { quantity: 6, reserved: 0, committed: 0, incoming: 0, damaged: 0, safetyStock: 0, available: 6, version: 2 } };
  const reader = canonicalStockFromFulfilment(
    { availability: async (c, v, loc) => ({ variantId: v, locationId: loc, ...views[loc] }) },
    async () => ["loc-1", "loc-2"],
  );
  const total = await reader.read(COMPANY_A, VARIANT, null);
  assert.equal(total.available, 9);
  assert.equal(total.quantity, 10);
  const one = await reader.read(COMPANY_A, VARIANT, "loc-1");
  assert.equal(one.available, 3);
});

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

test("exceptions open once, auto-resolve when fixed, and keep an audit trail", async () => {
  const detail = nativeDetail(COMPANY_A, { order: { shippingAddress: {} } });
  const w = world({ nativeOrders: [detail] });
  await w.ops.projector.projectNative(COMPANY_A, detail);
  let order = (await w.store.unifiedOrders.list(COMPANY_A))[0];
  const first = await w.ops.exceptions.scanOrder(COMPANY_A, order);
  assert.equal(first.opened, 2, "address and fulfilment delay");
  const again = await w.ops.exceptions.scanOrder(COMPANY_A, order);
  assert.equal(again.opened, 0, "a second scan opens nothing new");
  assert.equal((await w.store.exceptions.list(COMPANY_A)).length, 2);

  const fixed = nativeDetail(COMPANY_A, { order: { shippingAddress: { line1: "2 High St", city: "Sydney", country: "AU" } } });
  await w.ops.projector.projectNative(COMPANY_A, fixed);
  order = await w.store.unifiedOrders.get(COMPANY_A, order.id);
  const after = await w.ops.exceptions.scanOrder(COMPANY_A, order);
  assert.equal(after.resolved, 1);
  const addr = (await w.store.exceptions.list(COMPANY_A)).find((e) => e.exceptionType === "invalid_address");
  assert.equal(addr.status, "resolved");
  assert.equal(addr.metadata.auto_resolved, true);
  const trail = await w.store.exceptionEvents.list(COMPANY_A, (e) => e.exceptionId === addr.id);
  assert.deepEqual(trail.map((e) => e.eventType), ["detected", "auto_resolved"]);
});

test("acknowledge, assign and resolve each write an audit event with before and after states", async () => {
  const detail = nativeDetail(COMPANY_A, { order: { shippingAddress: {} } });
  const w = world({ nativeOrders: [detail] });
  await w.ops.projector.projectNative(COMPANY_A, detail);
  const order = (await w.store.unifiedOrders.list(COMPANY_A))[0];
  await w.ops.exceptions.scanOrder(COMPANY_A, order);
  const exception = (await w.store.exceptions.list(COMPANY_A)).find((e) => e.exceptionType === "invalid_address");
  await w.ops.exceptions.acknowledge(COMPANY_A, CHATBOT, exception.id, OWNER);
  await w.ops.exceptions.assign(COMPANY_A, CHATBOT, exception.id, "user-staff", OWNER);
  await w.ops.exceptions.resolve(COMPANY_A, CHATBOT, exception.id, OWNER, "Customer confirmed address");
  const trail = await w.ops.exceptions.auditTrail(COMPANY_A, CHATBOT, exception.id);
  assert.deepEqual(trail.map((e) => e.eventType), ["detected", "acknowledged", "assigned", "resolved"]);
  const resolved = trail[3];
  assert.equal(resolved.beforeState.status, "acknowledged");
  assert.equal(resolved.afterState.status, "resolved");
  assert.equal(resolved.metadata.note, "Customer confirmed address");
});

test("a seller's manual resolve reopens when the scan still finds the condition", async () => {
  const detail = nativeDetail(COMPANY_A, { order: { shippingAddress: {} } });
  const w = world({ nativeOrders: [detail] });
  await w.ops.projector.projectNative(COMPANY_A, detail);
  const order = (await w.store.unifiedOrders.list(COMPANY_A))[0];
  await w.ops.exceptions.scanOrder(COMPANY_A, order);
  const exception = (await w.store.exceptions.list(COMPANY_A)).find((e) => e.exceptionType === "invalid_address");
  await w.ops.exceptions.resolve(COMPANY_A, CHATBOT, exception.id, OWNER);
  const result = await w.ops.exceptions.scanOrder(COMPANY_A, order);
  assert.equal(result.opened, 1, "reopened, because the address is still missing");
  const trail = await w.ops.exceptions.auditTrail(COMPANY_A, CHATBOT, exception.id);
  assert.equal(trail.at(-1).eventType, "reopened");
});

test("exceptions are invisible to another chatbot or company", async () => {
  const detail = nativeDetail(COMPANY_A, { order: { shippingAddress: {} } });
  const w = world({ nativeOrders: [detail] });
  await w.ops.projector.projectNative(COMPANY_A, detail);
  const order = (await w.store.unifiedOrders.list(COMPANY_A))[0];
  await w.ops.exceptions.scanOrder(COMPANY_A, order);
  const exception = (await w.store.exceptions.list(COMPANY_A))[0];
  await assert.rejects(() => w.ops.exceptions.acknowledge(COMPANY_A, "other-chatbot", exception.id, OWNER), (e) => e.status === 404);
  await assert.rejects(() => w.ops.exceptions.acknowledge(COMPANY_B, CHATBOT, exception.id, OWNER), (e) => e.status === 404);
});

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

async function importedOrder(w) {
  await w.ops.orderImport.importOrders(COMPANY_A, w.scope());
  return (await w.store.unifiedOrders.list(COMPANY_A))[0];
}

test("settlement entries are idempotent by external id, and a repeat changes nothing", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  const order = await importedOrder(w);
  const entries = [{ external_entry_id: "E1", type: "sale", amount: 2500 }, { external_entry_id: "E2", type: "fee", amount: -300 }, { external_entry_id: "E3", type: "payout", amount: 2200 }];
  const first = await w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, { provider: "ebay", entries });
  assert.equal(first.created, 3);
  const second = await w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, { provider: "ebay", entries });
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 3);
  assert.equal((await w.store.settlementEntries.list(COMPANY_A)).length, 3);
  assert.equal(second.reconciliation.report.status, "reconciled");
});

test("re-using a settlement entry id with different data is refused", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  const order = await importedOrder(w);
  await w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, { provider: "ebay", entries: [{ external_entry_id: "E1", type: "fee", amount: 300 }] });
  await assert.rejects(
    () => w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, { provider: "ebay", entries: [{ external_entry_id: "E1", type: "fee", amount: 400 }] }),
    (e) => e.status === 422,
  );
});

test("a currency that does not match the order is refused and nothing from the batch is kept", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  const order = await importedOrder(w);
  await assert.rejects(
    () => w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, { provider: "ebay", entries: [{ external_entry_id: "OK", type: "fee", amount: 100 }, { external_entry_id: "BAD", type: "fee", amount: 100, currency: "USD" }] }),
    (e) => e.status === 422 && /currency/.test(e.message),
  );
  assert.equal((await w.store.settlementEntries.list(COMPANY_A)).length, 0, "the batch is all or nothing");
});

test("a settlement that does not match the payout opens a settlement variance exception", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  const order = await importedOrder(w);
  const result = await w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, {
    provider: "ebay",
    entries: [{ external_entry_id: "P1", type: "payout", amount: 2100 }, { external_entry_id: "F1", type: "fee", amount: -300 }],
  });
  assert.equal(result.reconciliation.report.status, "variance");
  assert.equal(result.reconciliation.report.varianceMinor, 2100 - 2200);
  const updated = await w.store.unifiedOrders.get(COMPANY_A, order.id);
  assert.equal(updated.settlementVariance, -100);
  const scan = await w.ops.exceptions.scanOrder(COMPANY_A, updated);
  assert.equal(scan.opened >= 1, true);
  const types = (await w.store.exceptions.list(COMPANY_A)).map((e) => e.exceptionType);
  assert.ok(types.includes("settlement_variance"));
});

test("a reconciliation report's lines add up to its totals", async () => {
  const w = world({ pages: [{ orders: [ORDER_PAYLOAD()], nextCursor: null }] });
  const order = await importedOrder(w);
  const result = await w.ops.settlement.importEntries(COMPANY_A, CHATBOT, order.id, {
    provider: "ebay",
    entries: [{ external_entry_id: "A", type: "fee", amount: 150 }, { external_entry_id: "B", type: "refund", amount: 200 }, { external_entry_id: "C", type: "payout", amount: 2000 }],
  });
  const report = result.reconciliation.report;
  const expected = report.lines.filter((l) => l.kind === "expected").reduce((s, l) => s + l.amountMinor, 0);
  assert.equal(report.expectedNetMinor, expected);
  assert.equal(expected, 2500 - 150 - 200);
});

// ---------------------------------------------------------------------------
// Workbench
// ---------------------------------------------------------------------------

async function workbenchWorld() {
  const detail = nativeDetail(COMPANY_A, { order: { shippingAddress: {} } });
  const w = world({ nativeOrders: [detail] });
  await w.ops.projector.projectNative(COMPANY_A, detail);
  const order = (await w.store.unifiedOrders.list(COMPANY_A))[0];
  await w.ops.exceptions.scanOrder(COMPANY_A, order);
  const exception = (await w.store.exceptions.list(COMPANY_A)).find((e) => e.exceptionType === "invalid_address");
  return { ...w, order, exception, owner: { userId: OWNER, chatbotOwnerId: OWNER } };
}

test("only the chatbot owner can run the workbench tools", async () => {
  const w = await workbenchWorld();
  await assert.rejects(() => w.ops.workbench.execute(COMPANY_A, CHATBOT, { userId: STRANGER, chatbotOwnerId: OWNER }, "seller_order_workbench_list", {}), (e) => e.status === 422);
  await assert.rejects(() => w.ops.workbench.execute(COMPANY_A, CHATBOT, { userId: null, chatbotOwnerId: OWNER }, "seller_order_workbench_list", {}), (e) => e.status === 422);
});

test("the list tool returns scoped orders with their open exceptions, and filters", async () => {
  const w = await workbenchWorld();
  const all = await w.ops.workbench.execute(COMPANY_A, CHATBOT, w.owner, "seller_order_workbench_list", { limit: 500 });
  assert.equal(all.data.items.length, 1);
  assert.equal(all.data.items[0].open_exceptions[0].type, "invalid_address");
  const exceptionsOnly = await w.ops.workbench.list(COMPANY_A, CHATBOT, { exceptions_only: true });
  assert.equal(exceptionsOnly.items.length, 1);
  const none = await w.ops.workbench.list(COMPANY_A, CHATBOT, { search: "no-such-order" });
  assert.equal(none.items.length, 0);
  const otherCompany = await w.ops.workbench.list(COMPANY_B, CHATBOT, {});
  assert.equal(otherCompany.items.length, 0);
});

test("the sync tool refuses to run without explicit seller approval", async () => {
  const w = await workbenchWorld();
  await assert.rejects(() => w.ops.workbench.execute(COMPANY_A, CHATBOT, w.owner, "seller_order_workbench_sync", { seller_approved: false }), (e) => e.status === 422);
  const ok = await w.ops.workbench.execute(COMPANY_A, CHATBOT, w.owner, "seller_order_workbench_sync", { seller_approved: true });
  assert.equal(typeof ok.data.projection.total_projected, "number");
});

test("a refund is proposed for approval only, is idempotent, and is capped at the refundable amount", async () => {
  const w = await workbenchWorld();
  const proposal = await w.ops.workbench.prepareRefundProposal(COMPANY_A, CHATBOT, w.order.id, w.exception.id, 1000, "Damaged on arrival", "refund-key-1", OWNER);
  assert.equal(proposal.status, "awaiting_approval");
  assert.equal(proposal.amount, 1000);
  assert.ok(proposal.expiresAt.getTime() > START.getTime(), "the proposal expires later");
  assert.equal(w.calls.http, 0, "no provider was called");
  const replay = await w.ops.workbench.prepareRefundProposal(COMPANY_A, CHATBOT, w.order.id, w.exception.id, 1000, "Damaged on arrival", "refund-key-1", OWNER);
  assert.equal(replay.id, proposal.id);
  await assert.rejects(() => w.ops.workbench.prepareRefundProposal(COMPANY_A, CHATBOT, w.order.id, null, 900, "Damaged on arrival", "refund-key-1", OWNER), (e) => e.status === 422 && /different/.test(e.message));
  await assert.rejects(() => w.ops.workbench.prepareRefundProposal(COMPANY_A, CHATBOT, w.order.id, null, 99_999, "Too much", "refund-key-2", OWNER), (e) => e.status === 422);
});

test("a customer contact is drafted from order facts and is not sent", async () => {
  const w = await workbenchWorld();
  const draft = await w.ops.workbench.prepareCustomerContact(COMPANY_A, CHATBOT, w.order.id, w.exception.id, "WhatsApp", "contact-1", OWNER);
  assert.equal(draft.status, "prepared");
  assert.equal(draft.proposal.channel, "whatsapp");
  assert.match(draft.proposal.draft, /Hello Alex/);
  assert.match(draft.proposal.draft, new RegExp(w.order.sourceOrderId));
  assert.equal(w.calls.http, 0);
});

test("acknowledging an exception twice with the same key changes it once", async () => {
  const w = await workbenchWorld();
  const first = await w.ops.workbench.acknowledge(COMPANY_A, CHATBOT, w.order.id, w.exception.id, OWNER, "ack-1");
  const second = await w.ops.workbench.acknowledge(COMPANY_A, CHATBOT, w.order.id, w.exception.id, OWNER, "ack-1");
  assert.equal(second.id, first.id);
  const trail = await w.ops.exceptions.auditTrail(COMPANY_A, CHATBOT, w.exception.id);
  assert.equal(trail.filter((e) => e.eventType === "acknowledged").length, 1);
});

test("a workbench write with an empty idempotency key is refused", async () => {
  const w = await workbenchWorld();
  await assert.rejects(() => w.ops.workbench.acknowledge(COMPANY_A, CHATBOT, w.order.id, w.exception.id, OWNER, "   "), (e) => e.status === 422);
  assert.equal(w.ops.workbench.toolDefinitions().length, 4);
});

// ---------------------------------------------------------------------------
// Drizzle queries and tables
// ---------------------------------------------------------------------------

const drizzleDb = drizzle({ client: { query: async () => ({ rows: [], rowCount: 0 }) } });

function assertCompanyScoped(rendered, companyId) {
  if (/^insert /i.test(rendered.sql)) {
    assert.match(rendered.sql, /"company_id"/, `insert without company_id: ${rendered.sql}`);
  } else {
    assert.match(rendered.sql, /"company_id" = \$\d+/, `query without company predicate: ${rendered.sql}`);
  }
  assert.ok(rendered.params.includes(companyId), `company id not bound: ${rendered.sql}`);
}

test("every hot-path query filters by company_id and binds the company", () => {
  const cases = [
    ["unifiedOrderByKey", queries.unifiedOrderByKey(drizzleDb, COMPANY_A, CHATBOT, "ebay", "connection:c", "EB-1")],
    ["unifiedOrdersForChatbot", queries.unifiedOrdersForChatbot(drizzleDb, COMPANY_A, CHATBOT, 25)],
    ["marketplaceOrderByExternalId", queries.marketplaceOrderByExternalId(drizzleDb, COMPANY_A, CONNECTION, "EB-1")],
    ["openConflictsForConnection", queries.openConflictsForConnection(drizzleDb, COMPANY_A, CHATBOT, CONNECTION)],
    ["conflictStatusUpdate", queries.conflictStatusUpdate(drizzleDb, COMPANY_A, "conf-1", "resolved")],
    ["openExceptionsForOrder", queries.openExceptionsForOrder(drizzleDb, COMPANY_A, "order-1")],
    ["settlementEntryByKey", queries.settlementEntryByKey(drizzleDb, COMPANY_A, CHATBOT, "ebay", "connection:c", "E1")],
  ];
  for (const [name, query] of cases) {
    const rendered = render(query);
    assert.doesNotThrow(() => assertCompanyScoped(rendered, COMPANY_A), name);
    assert.equal(rendered.params.includes(COMPANY_B), false, `${name} must not bind another company`);
  }
});

test("the settlement insert writes company_id from the caller, not from the row", () => {
  const rendered = render(
    queries.insertSettlementEntry(drizzleDb, COMPANY_A, {
      chatbotId: CHATBOT, unifiedOrderId: "o1", provider: "ebay", sourceScope: "s", externalEntryId: "E1",
      entryType: "fee", amount: 300, currency: "AUD", sourceHash: "h", companyId: COMPANY_B,
    }),
  );
  assertCompanyScoped(rendered, COMPANY_A);
  assert.equal(rendered.params.includes(COMPANY_B), false);
});

test("every table has company_id, a composite primary key, and every unique index includes company_id", () => {
  const tables = Object.entries(dbTables).filter(([, value]) => value && typeof value === "object" && Symbol.for("drizzle:Name") in value);
  assert.ok(tables.length >= 15, `expected the order-ops tables, found ${tables.length}`);
  for (const [name, table] of tables) {
    const config = getTableConfig(table);
    const columns = config.columns.map((c) => c.name);
    assert.ok(columns.includes("company_id"), `${name} has no company_id`);
    const pk = config.primaryKeys[0];
    assert.ok(pk && pk.columns.some((c) => c.name === "company_id"), `${name} primary key lacks company_id`);
    for (const index of config.indexes) {
      const names = index.config.columns.map((c) => c.name);
      assert.ok(names.includes("company_id"), `${name} index ${index.config.name} lacks company_id`);
    }
  }
});

test("the migration draft lists every table and every unique constraint scopes by company", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../../server/modules/chatbot/db/migrations-draft/0310_commerce_order_ops.sql", import.meta.url), "utf8");
  const tables = Object.entries(dbTables).filter(([, value]) => value && typeof value === "object" && Symbol.for("drizzle:Name") in value);
  for (const [, table] of tables) {
    const name = getTableConfig(table).name;
    assert.match(sql, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${name}\\b`), `migration missing ${name}`);
  }
  const uniques = sql.match(/CREATE UNIQUE INDEX[^;]*;/g) ?? [];
  assert.ok(uniques.length > 0);
  for (const statement of uniques) assert.match(statement, /company_id/, statement);
  assert.match(sql, /DRAFT\. NOT APPLIED/);
});
