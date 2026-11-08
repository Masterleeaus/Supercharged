// Native orders module tests (node:test). No database, no Express, no node_modules.
// Covers lifecycle transitions, integer-minor-unit totals, coupon expiry and usage limits,
// the append-only order event log, return quantity limits, company isolation and the feature flag.
// The storage is async (integration fix 1), so the service and the storage are awaited throughout.
import test from "node:test";
import assert from "node:assert/strict";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import { createOrderService } from "../../server/modules/chatbot/orders/order-service.ts";
import { createMemoryOrderStorage, REFUND_RECORD_REQUIRED } from "../../server/modules/chatbot/orders/order-storage.ts";
import { OrderError } from "../../server/modules/chatbot/orders/order-errors.ts";
import { canTransitionOrder, canTransitionReturn, ORDER_STATUSES } from "../../server/modules/chatbot/orders/lifecycle.ts";
import { computeLineTotals, computeOrderTotals } from "../../server/modules/chatbot/orders/totals.ts";
import { prorateHalfUp, percentageOf, assertMinorUnits } from "../../server/modules/chatbot/orders/money.ts";
import { nativeOrdersEnabled } from "../../server/modules/chatbot/orders/index.ts";

// ---------- fixtures ----------

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHATBOT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHATBOT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-11-08T10:00:00.000Z");

function clockAt(date) {
  const state = { current: new Date(date) };
  return { now: () => new Date(state.current), set: (next) => { state.current = new Date(next); } };
}

function makeService({ enabled = true, start = NOW, storage: storageOverride } = {}) {
  const clock = clockAt(start);
  let counter = 0;
  const storage = storageOverride ?? createMemoryOrderStorage({ now: clock.now });
  const service = createOrderService({
    storage,
    enabled,
    now: clock.now,
    randomHex: () => (++counter).toString(16).padStart(8, "0"),
    publisher: { publish() {} },
  });
  return { service, storage, clock };
}

let checkoutSeq = 0;
function checkoutFixture(overrides = {}) {
  checkoutSeq += 1;
  const lines = overrides.lines ?? [
    { productId: "p1", variantId: "v1", sku: "SKU-1", name: "Filter", quantity: 2, listUnitPrice: 1000, unitPrice: 1000, discountTotal: 0, taxTotal: 200, lineTotal: 2200 },
    { productId: "p2", variantId: "v2", sku: "SKU-2", name: "Bolt", quantity: 1, listUnitPrice: 500, unitPrice: 500, discountTotal: 0, taxTotal: 50, lineTotal: 550 },
  ];
  const totals = computeOrderTotals(lines, overrides.shippingTotal ?? 300);
  return {
    checkoutId: `10000000-0000-4000-8000-${String(checkoutSeq).padStart(12, "0")}`,
    checkoutStatus: "completed",
    chatbotId: CHATBOT_A,
    cartId: "cart-1",
    paymentIntentId: null,
    customerIdentityId: "cust-1",
    conversationId: "conv-1",
    sessionId: "session-1",
    currency: "AUD",
    shippingTotal: overrides.shippingTotal ?? 300,
    reportedTotals: overrides.reportedTotals ?? totals,
    lines,
    ...overrides,
    lines: overrides.lines ?? lines,
  };
}

async function placeOrder(service, companyId = COMPANY_A, overrides = {}) {
  return service.createOrderFromCheckout(companyId, checkoutFixture(overrides));
}

async function fulfilledOrder(service, companyId = COMPANY_A) {
  const detail = await placeOrder(service, companyId);
  await service.transitionOrder(companyId, detail.order.id, "processing");
  await service.transitionOrder(companyId, detail.order.id, "fulfilled");
  return service.getOrder(companyId, detail.order.id);
}

async function couponRecord(service, overrides = {}) {
  return service.createCoupon(COMPANY_A, {
    chatbotId: CHATBOT_A,
    code: "SAVE10",
    type: "percentage",
    value: 1000,
    ...overrides,
  });
}

function cartFor(overrides = {}) {
  return {
    subtotal: 3000,
    lines: [
      { lineKey: "l1", productId: "p1", variantId: "v1", categoryId: "cat-1", grossTotal: 2000, discountTotal: 0 },
      { lineKey: "l2", productId: "p2", variantId: "v2", categoryId: "cat-2", grossTotal: 1000, discountTotal: 0 },
    ],
    currency: "AUD",
    channel: "web",
    completedOrderCount: 0,
    cartId: "cart-1",
    customerIdentityId: "cust-1",
    ...overrides,
  };
}

// ---------- lifecycle ----------

test("valid order transitions are accepted and recorded", async () => {
  const { service } = makeService();
  const detail = await placeOrder(service);
  const id = detail.order.id;
  assert.equal(detail.order.status, "confirmed");
  assert.equal((await service.transitionOrder(COMPANY_A, id, "processing")).order.status, "processing");
  assert.equal((await service.transitionOrder(COMPANY_A, id, "fulfilled")).order.status, "fulfilled");
  assert.equal((await service.transitionOrder(COMPANY_A, id, "completed")).order.status, "completed");
  assert.ok((await service.getOrder(COMPANY_A, id)).order.completedAt instanceof Date);
});

test("invalid order transitions are rejected with a 422 and leave the order unchanged", async () => {
  const { service } = makeService();
  const id = (await placeOrder(service)).order.id;
  for (const bad of ["fulfilled", "pending", "completed", "bogus-status"]) {
    await assert.rejects(() => service.transitionOrder(COMPANY_A, id, bad), (error) => error instanceof OrderError && error.status === 422);
  }
  assert.equal((await service.getOrder(COMPANY_A, id)).order.status, "confirmed");
  assert.equal((await service.getOrder(COMPANY_A, id)).events.length, 1, "rejected transitions must not append events");
});

test("cancelled and refunded are terminal in the order state machine", () => {
  for (const terminal of ["cancelled", "refunded"]) {
    for (const target of ORDER_STATUSES) {
      assert.equal(canTransitionOrder(terminal, target), false, `${terminal} -> ${target} must be invalid`);
    }
  }
  assert.equal(canTransitionOrder("confirmed", "cancelled"), true);
  assert.equal(canTransitionOrder("pending", "fulfilled"), false);
  assert.equal(canTransitionOrder("constructor", "pending"), false, "prototype keys must not count as states");
});

test("return state machine: only listed transitions are valid and rejected is terminal", () => {
  assert.equal(canTransitionReturn("requested", "approved"), true);
  assert.equal(canTransitionReturn("requested", "refunded"), false);
  assert.equal(canTransitionReturn("rejected", "approved"), false);
  assert.equal(canTransitionReturn("exchanged", "refunded"), false);
  assert.equal(canTransitionReturn("approved", "refunded"), true, "approved -> refunded is the recordRefund path (M2)");
});

test("transitioning to the current status is a no-op with no new event", async () => {
  const { service } = makeService();
  const id = (await placeOrder(service)).order.id;
  const again = await service.transitionOrder(COMPANY_A, id, "confirmed");
  assert.equal(again.events.length, 1);
});

test("returns cannot be transitioned to refunded directly", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], resolution: "refund" });
  await service.transitionReturn(COMPANY_A, ret.returnRecord.id, "approved");
  await assert.rejects(() => service.transitionReturn(COMPANY_A, ret.returnRecord.id, "refunded"), /refund endpoint/);
});

// ---------- M1: refund record guard, enforced in the service ----------

test("M1: transitionOrder refuses refunded with no refund record, using the in-memory storage", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  await assert.rejects(
    () => service.transitionOrder(COMPANY_A, order.order.id, "refunded"),
    (error) => error instanceof OrderError && error.message === REFUND_RECORD_REQUIRED,
  );
  const after = await service.getOrder(COMPANY_A, order.order.id);
  assert.equal(after.order.status, "fulfilled", "the refused move must leave the order unchanged");
  assert.equal(after.events.some((event) => event.eventType === "order.status_changed" && event.afterState?.status === "refunded"), false);
});

test("M1: the service refuses before any storage write, so the guard does not depend on the storage", async () => {
  const memory = createMemoryOrderStorage({ now: () => NOW });
  const writes = [];
  // A storage with no guard of its own: it records every updateOrder call and then delegates.
  const unguarded = {
    ...memory,
    updateOrder: async (companyId, orderId, patch) => {
      writes.push({ companyId, orderId, patch });
      return memory.updateOrder(companyId, orderId, patch);
    },
  };
  const { service } = makeService({ storage: unguarded });
  const order = await fulfilledOrder(service);
  const writesBefore = writes.length;
  await assert.rejects(() => service.transitionOrder(COMPANY_A, order.order.id, "refunded"), /without a refund record/);
  assert.equal(writes.length, writesBefore, "transitionOrder must not reach updateOrder when no refund record exists");
});

test("M1: transitionOrder allows refunded once a return of the order carries a refund amount", async () => {
  const { service, storage } = makeService();
  const order = await fulfilledOrder(service);
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], resolution: "refund" });
  await service.transitionReturn(COMPANY_A, ret.returnRecord.id, "approved");
  await storage.updateReturn(COMPANY_A, ret.returnRecord.id, { refundedAmount: 1 });
  const moved = await service.transitionOrder(COMPANY_A, order.order.id, "refunded");
  assert.equal(moved.order.status, "refunded");
});

// ---------- money and totals ----------

test("line totals are computed in integer minor units", () => {
  const line = computeLineTotals({ quantity: 3, unitPrice: 333, discountTotal: 99, taxTotal: 50, lineTotal: 950 });
  assert.deepEqual(line, { grossTotal: 999, netBeforeTax: 900, lineTotal: 950 });
  for (const value of [line.grossTotal, line.netBeforeTax, line.lineTotal]) {
    assert.ok(Number.isSafeInteger(value));
  }
});

test("money inputs reject floats, NaN, unsafe integers and strings", () => {
  for (const bad of [10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "1000", -1]) {
    assert.throws(() => computeLineTotals({ quantity: 1, unitPrice: bad, discountTotal: 0, taxTotal: 0, lineTotal: 0 }), OrderError);
  }
  assert.throws(() => assertMinorUnits(0.1 + 0.2, "x"), OrderError);
});

test("a line total that disagrees with net plus tax is refused", () => {
  assert.throws(
    () => computeLineTotals({ quantity: 2, unitPrice: 1000, discountTotal: 100, taxTotal: 190, lineTotal: 2000 }),
    /does not equal net plus tax 2090/,
  );
});

test("order totals sum lines and shipping exactly, with no rounding drift", () => {
  const totals = computeOrderTotals(
    [
      { quantity: 1, unitPrice: 1000, discountTotal: 0, taxTotal: 91, lineTotal: 1091 },
      { quantity: 3, unitPrice: 333, discountTotal: 99, taxTotal: 50, lineTotal: 950 },
    ],
    300,
  );
  assert.deepEqual(totals, { subtotal: 1999, discountTotal: 99, taxTotal: 141, shippingTotal: 300, total: 2341 });
});

test("checkout whose reported totals drift from the recomputed totals is refused", async () => {
  const { service } = makeService();
  const fixture = checkoutFixture();
  fixture.reportedTotals = { ...fixture.reportedTotals, total: fixture.reportedTotals.total + 1 };
  await assert.rejects(() => service.createOrderFromCheckout(COMPANY_A, fixture), /total .* does not match/);
});

test("proration rounds halves up using integers, not floats", () => {
  assert.equal(prorateHalfUp(1001, 1, 2), 501);
  assert.equal(prorateHalfUp(999, 1, 3), 333);
  assert.equal(prorateHalfUp(1, 1, 2), 1);
  assert.equal(percentageOf(999, 1000), 100);
  assert.equal(percentageOf(1000, 1250), 125);
});

test("a return refund amount is prorated from the line total, rounding half up", async () => {
  const { service } = makeService();
  const lines = [{ productId: "p1", variantId: "v1", sku: "S", name: "Odd", quantity: 2, listUnitPrice: 500, unitPrice: 500, discountTotal: 0, taxTotal: 1, lineTotal: 1001 }];
  const order = await placeOrder(service, COMPANY_A, { lines, shippingTotal: 0 });
  await service.transitionOrder(COMPANY_A, order.order.id, "processing");
  await service.transitionOrder(COMPANY_A, order.order.id, "fulfilled");
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], resolution: "refund" });
  assert.equal(ret.returnRecord.requestedAmount, 501);
});

// ---------- coupons ----------

test("an expired coupon is rejected in strict mode and ignored otherwise", async () => {
  const { service, clock } = makeService();
  await couponRecord(service, { endsAt: new Date("2026-11-01T00:00:00.000Z") });
  assert.equal(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor()), null);
  await assert.rejects(() => service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor(), { strict: true }), /invalid or unavailable/);
  clock.set("2026-10-31T00:00:00.000Z");
  assert.ok(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor(), { strict: true }));
});

test("a coupon that has not started yet is invalid", async () => {
  const { service } = makeService();
  await couponRecord(service, { startsAt: new Date("2026-12-01T00:00:00.000Z") });
  assert.equal(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor()), null);
});

test("coupon codes are normalised and discounts apply only to eligible lines", async () => {
  const { service } = makeService();
  await couponRecord(service, { code: "  save10 ", appliesTo: "products", targetIds: ["p2"], value: 1000 });
  const quote = await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor(), { strict: true });
  assert.equal(quote.eligibleAmount, 1000);
  assert.equal(quote.discount, 100);
});

test("a percentage coupon is capped by its maximum discount", async () => {
  const { service } = makeService();
  await couponRecord(service, { value: 5000, maxDiscountAmount: 400 });
  const quote = await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor(), { strict: true });
  assert.equal(quote.discount, 400);
});

test("minimum amount, currency, channel and first-order rules are enforced", async () => {
  const { service } = makeService();
  await couponRecord(service, { minimumAmount: 5000, channels: ["web"], currency: "AUD", firstOrderOnly: true });
  const strict = { strict: true };
  await assert.rejects(() => service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor(), strict), /minimum purchase/);
  await assert.rejects(() => service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ subtotal: 6000, currency: "USD" }), strict), /this currency/);
  await assert.rejects(() => service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ subtotal: 6000, channel: "app" }), strict), /this channel/);
  await assert.rejects(() => service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ subtotal: 6000, completedOrderCount: 1 }), strict), /first order/);
  assert.ok(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ subtotal: 6000 }), strict), "a cart meeting every rule is accepted");
});

test("a coupon's global usage limit counts redeemed usages from other carts only", async () => {
  const { service } = makeService();
  const coupon = await couponRecord(service, { usageLimit: 1 });
  await service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-x", currency: "AUD", customerIdentityId: "cust-x" });
  await service.redeemCartCoupons(COMPANY_A, "cart-x");
  assert.equal(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ cartId: "cart-y" })), null);
  assert.ok(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ cartId: "cart-x" }), { strict: true }), "a cart's own usage is excluded");
});

test("the per-customer usage limit is enforced", async () => {
  const { service } = makeService();
  const coupon = await couponRecord(service, { usageLimitPerCustomer: 1 });
  await service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-x", customerIdentityId: "cust-1", currency: "AUD" });
  await assert.rejects(
    () => service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-y", customerIdentityId: "cust-1", currency: "AUD" }),
    /for this customer/,
  );
  assert.ok(await service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-z", customerIdentityId: "cust-2", currency: "AUD" }));
});

test("an expired reservation no longer counts toward the usage limit", async () => {
  const { service, clock } = makeService();
  const coupon = await couponRecord(service, { usageLimit: 1 });
  await service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-x", currency: "AUD" });
  assert.equal(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ cartId: "cart-y" })), null);
  clock.set("2026-11-08T11:00:00.000Z");
  assert.ok(await service.quoteCoupon(COMPANY_A, CHATBOT_A, "SAVE10", cartFor({ cartId: "cart-y" }), { strict: true }));
});

test("the expiry sweep marks due reservations expired and redeem skips them", async () => {
  const { service, clock } = makeService();
  const coupon = await couponRecord(service);
  await service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-x", currency: "AUD" });
  clock.set("2026-11-08T10:45:00.000Z");
  assert.equal(await service.redeemCartCoupons(COMPANY_A, "cart-x"), 0, "an expired reservation cannot be redeemed");
  assert.equal(await service.expireDueCouponUsages(COMPANY_A), 1);
  assert.equal(await service.expireDueCouponUsages(COMPANY_A), 0);
});

test("reserving a second coupon on the same cart releases the first", async () => {
  const { service } = makeService();
  const first = await couponRecord(service, { code: "FIRST" });
  const second = await couponRecord(service, { code: "SECOND" });
  await service.reserveCoupon(COMPANY_A, first.id, { cartId: "cart-x", currency: "AUD" });
  await service.reserveCoupon(COMPANY_A, second.id, { cartId: "cart-x", currency: "AUD" });
  assert.equal((await service.reserveCoupon(COMPANY_A, first.id, { cartId: "cart-x", currency: "AUD" })).status, "reserved");
  assert.equal(await service.releaseCartCoupons(COMPANY_A, "cart-x"), 1, "only the reserved usage is released");
});

// ---------- order event log ----------

test("the order event log is append-only and returned events cannot be mutated", async () => {
  const { service, storage } = makeService();
  const id = (await placeOrder(service)).order.id;
  await service.transitionOrder(COMPANY_A, id, "processing");
  const events = (await service.getOrder(COMPANY_A, id)).events;
  assert.deepEqual(events.map((event) => event.eventType), ["order.created", "order.status_changed"]);
  assert.ok(events[1].sequence > events[0].sequence, "sequence increases");
  assert.throws(() => {
    events[0].eventType = "tampered";
  }, TypeError);
  assert.equal((await service.getOrder(COMPANY_A, id)).events[0].eventType, "order.created");
  for (const name of ["updateOrderEvent", "deleteOrderEvent", "updateOrderEvents"]) {
    assert.equal(storage[name], undefined, `storage must not expose ${name}`);
  }
});

test("failed operations never append to the event log", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const before = (await service.getOrder(COMPANY_A, order.order.id)).events.length;
  await assert.rejects(() => service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 99 }], resolution: "refund" }));
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).events.length, before);
});

test("checkout materialisation is idempotent and writes one order.created event", async () => {
  const { service } = makeService();
  const fixture = checkoutFixture();
  const first = await service.createOrderFromCheckout(COMPANY_A, fixture);
  const second = await service.createOrderFromCheckout(COMPANY_A, fixture);
  assert.equal(second.order.id, first.order.id);
  assert.equal(second.events.filter((event) => event.eventType === "order.created").length, 1);
});

test("only a completed checkout can become an order", async () => {
  const { service } = makeService();
  await assert.rejects(() => service.createOrderFromCheckout(COMPANY_A, checkoutFixture({ checkoutStatus: "pending" })), /completed checkout/);
});

// ---------- returns ----------

test("a return cannot exceed the ordered quantity in a single request", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  await assert.rejects(
    () => service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 3 }], resolution: "refund" }),
    /exceeds the remaining returnable quantity/,
  );
});

test("duplicate lines for one item are summed before the ordered-quantity check", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const item = order.items[1];
  assert.equal(item.quantity, 1);
  await assert.rejects(
    () => service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: item.id, quantity: 1 }, { orderItemId: item.id, quantity: 1 }], resolution: "refund" }),
    /exceeds/,
  );
});

test("returned quantity accumulates across returns and blocks the next over-return", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const item = order.items[0];
  await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: item.id, quantity: 1 }], resolution: "refund" });
  await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: item.id, quantity: 1 }], resolution: "refund" });
  await assert.rejects(
    () => service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: item.id, quantity: 1 }], resolution: "refund" }),
    /exceeds/,
  );
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).items[0].returnedQuantity, 2);
});

test("a rejected return releases its quantities exactly once", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const item = order.items[0];
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: item.id, quantity: 2 }], resolution: "refund" });
  await service.transitionReturn(COMPANY_A, ret.returnRecord.id, "rejected");
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).items[0].returnedQuantity, 0);
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).returns[0].returnRecord.quantitiesReleased, true);
});

test("returns are refused before fulfilment and for unsupported resolutions", async () => {
  const { service } = makeService();
  const detail = await placeOrder(service);
  await assert.rejects(() => service.requestReturn(COMPANY_A, detail.order.id, { items: [{ orderItemId: detail.items[0].id, quantity: 1 }], resolution: "refund" }), /after fulfilment/);
  const order = await fulfilledOrder(service);
  await assert.rejects(() => service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], resolution: "cash" }), /Unsupported return resolution/);
});

test("a refund cannot exceed the outstanding requested return amount", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[1].id, quantity: 1 }], resolution: "refund" });
  await service.transitionReturn(COMPANY_A, ret.returnRecord.id, "approved");
  await assert.rejects(() => service.recordRefund(COMPANY_A, ret.returnRecord.id, 551), /outstanding requested/);
  const partial = await service.recordRefund(COMPANY_A, ret.returnRecord.id, 200);
  assert.equal(partial.returnRecord.status, "approved");
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).order.status, "partially_refunded");
  const full = await service.recordRefund(COMPANY_A, ret.returnRecord.id, 350);
  assert.equal(full.returnRecord.status, "refunded");
  assert.equal(full.returnRecord.refundedAmount, 550);
});

test("a refund cannot exceed the order total even if return rows say otherwise", async () => {
  const { service, storage } = makeService();
  const order = await fulfilledOrder(service);
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 2 }], resolution: "refund" });
  await service.transitionReturn(COMPANY_A, ret.returnRecord.id, "approved");
  await storage.updateOrder(COMPANY_A, order.order.id, { refundedTotal: order.order.total - 1 });
  await assert.rejects(() => service.recordRefund(COMPANY_A, ret.returnRecord.id, 2), /exceed the order total/);
});

test("a refund is refused while the return is only requested", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const ret = await service.requestReturn(COMPANY_A, order.order.id, { items: [{ orderItemId: order.items[1].id, quantity: 1 }], resolution: "refund" });
  await assert.rejects(() => service.recordRefund(COMPANY_A, ret.returnRecord.id, 100), /approved or received/);
});

// ---------- company isolation and scope ----------

test("company B cannot read, list, transition or return against company A's order", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service, COMPANY_A);
  await assert.rejects(() => service.getOrder(COMPANY_B, order.order.id), (e) => e instanceof OrderError && e.status === 404);
  assert.deepEqual(await service.listOrdersForSession(COMPANY_B, { chatbotId: CHATBOT_A, sessionId: "session-1" }), []);
  await assert.rejects(() => service.transitionOrder(COMPANY_B, order.order.id, "completed"), (e) => e.status === 404);
  await assert.rejects(
    () => service.requestReturn(COMPANY_B, order.order.id, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], resolution: "refund" }),
    (e) => e.status === 404,
  );
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).order.status, "fulfilled");
});

test("company B cannot use company A's order item in its own return", async () => {
  const { service } = makeService();
  const orderA = await fulfilledOrder(service, COMPANY_A);
  const orderB = await fulfilledOrder(service, COMPANY_B);
  await assert.rejects(
    () => service.requestReturn(COMPANY_B, orderB.order.id, { items: [{ orderItemId: orderA.items[0].id, quantity: 1 }], resolution: "refund" }),
    /not found/,
  );
});

test("company B cannot see or reserve company A's coupons, usages or return records", async () => {
  const { service } = makeService();
  const coupon = await couponRecord(service);
  await service.reserveCoupon(COMPANY_A, coupon.id, { cartId: "cart-x", currency: "AUD" });
  assert.equal(await service.quoteCoupon(COMPANY_B, CHATBOT_A, "SAVE10", cartFor()), null);
  await assert.rejects(() => service.reserveCoupon(COMPANY_B, coupon.id, { cartId: "cart-x", currency: "AUD" }), (e) => e.status === 404);
  assert.equal(await service.releaseCartCoupons(COMPANY_B, "cart-x"), 0);
  assert.equal(await service.redeemCartCoupons(COMPANY_B, "cart-x"), 0);
});

test("a same checkout id in two companies yields two independent orders", async () => {
  const { service } = makeService();
  const fixture = checkoutFixture();
  const a = await service.createOrderFromCheckout(COMPANY_A, fixture);
  const b = await service.createOrderFromCheckout(COMPANY_B, fixture);
  assert.notEqual(a.order.id, b.order.id);
  assert.equal(a.order.companyId, COMPANY_A);
  assert.equal(b.order.companyId, COMPANY_B);
});

test("every storage call fails closed without a valid company id", async () => {
  const { service, storage } = makeService();
  for (const bad of [undefined, null, "", "not-a-uuid", 42]) {
    await assert.rejects(() => storage.findOrder(bad, "x"), ChatbotError);
    await assert.rejects(() => service.getOrder(bad, "x"), ChatbotError);
  }
});

test("a session other than the order's session, with no matching customer, cannot read the order", async () => {
  const { service } = makeService();
  const order = (await placeOrder(service)).order;
  const scope = { chatbotId: CHATBOT_A, sessionId: "session-1" };
  assert.equal((await service.getOrderForSession(COMPANY_A, scope, order.id)).order.id, order.id);
  await assert.rejects(() => service.getOrderForSession(COMPANY_A, { chatbotId: CHATBOT_A, sessionId: "session-2" }, order.id), (e) => e.status === 404);
  await assert.rejects(() => service.getOrderForSession(COMPANY_A, { chatbotId: CHATBOT_B, sessionId: "session-1" }, order.id), (e) => e.status === 404);
  assert.equal((await service.getOrderForSession(COMPANY_A, { chatbotId: CHATBOT_A, sessionId: "session-2", customerIdentityId: "cust-1" }, order.id)).order.id, order.id);
});

// ---------- feature flag ----------

test("the module is off by default and every method refuses to run", async () => {
  const { service } = makeService({ enabled: false });
  await assert.rejects(() => service.createOrderFromCheckout(COMPANY_A, checkoutFixture()), (e) => e.status === 503);
  await assert.rejects(() => service.getOrder(COMPANY_A, "x"), (e) => e.status === 503);
  await assert.rejects(() => service.expireDueCouponUsages(COMPANY_A), (e) => e.status === 503);
});

test("the feature flag reads only the exact string true", () => {
  assert.equal(nativeOrdersEnabled({}), false);
  assert.equal(nativeOrdersEnabled({ CHATBOT_NATIVE_ORDERS_ENABLED: "1" }), false);
  assert.equal(nativeOrdersEnabled({ CHATBOT_NATIVE_ORDERS_ENABLED: "TRUE" }), false);
  assert.equal(nativeOrdersEnabled({ CHATBOT_NATIVE_ORDERS_ENABLED: "true" }), true);
});
