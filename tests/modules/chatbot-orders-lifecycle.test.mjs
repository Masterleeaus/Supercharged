// Lifecycle history tests (node:test). In-memory storage only, no database.
// Covers: each order or return status change writes exactly one order-events row (company_id, sequence,
// before and after status), the row commits or rolls back with the status change, the M1 refund guard,
// illegal moves write nothing, and company isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { createOrderService } from "../../server/modules/chatbot/orders/order-service.ts";
import {
  createMemoryOrderStorage,
  REFUND_RECORD_REQUIRED,
  writeOrderTransition,
  writeReturnTransition,
  ORDER_STATUS_EVENT,
  RETURN_STATUS_EVENT,
} from "../../server/modules/chatbot/orders/order-storage.ts";
import { OrderError } from "../../server/modules/chatbot/orders/order-errors.ts";
import { computeOrderTotals } from "../../server/modules/chatbot/orders/totals.ts";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHATBOT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-11-08T10:00:00.000Z");

function makeHarness() {
  let clock = new Date(NOW);
  let counter = 0;
  const storage = createMemoryOrderStorage({ now: () => new Date(clock) });
  const service = createOrderService({
    storage,
    enabled: true,
    now: () => new Date(clock),
    randomHex: () => (++counter).toString(16).padStart(8, "0"),
    publisher: { publish() {} },
  });
  return {
    storage,
    service,
    tick() {
      clock = new Date(clock.getTime() + 1000);
    },
  };
}

let checkoutSeq = 0;
async function placeOrder(service, companyId = COMPANY_A) {
  checkoutSeq += 1;
  const lines = [
    { productId: "p1", variantId: "v1", sku: "SKU-1", name: "Filter", quantity: 2, listUnitPrice: 1000, unitPrice: 1000, discountTotal: 0, taxTotal: 200, lineTotal: 2200 },
  ];
  const totals = computeOrderTotals(lines, 300);
  return service.createOrderFromCheckout(companyId, {
    checkoutId: `20000000-0000-4000-8000-${String(checkoutSeq).padStart(12, "0")}`,
    checkoutStatus: "completed",
    chatbotId: CHATBOT_A,
    cartId: "cart-1",
    paymentIntentId: null,
    customerIdentityId: "cust-1",
    conversationId: "conv-1",
    sessionId: "session-1",
    currency: "AUD",
    shippingTotal: 300,
    reportedTotals: totals,
    lines,
  });
}

/** Runs one lifecycle write inside a storage transaction, as the service is expected to. */
function transitionOrderInTx(storage, companyId, orderId, to, input) {
  return storage.transaction(companyId, (tx) => writeOrderTransition(tx, companyId, orderId, to, input));
}

test("an order status change writes exactly one event with company_id and before and after status", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  const before = await storage.listOrderEvents(COMPANY_A, orderId);

  const result = await transitionOrderInTx(storage, COMPANY_A, orderId, "processing", { actorType: "staff", actorId: "u-1" });

  const after = await storage.listOrderEvents(COMPANY_A, orderId);
  assert.equal(after.length, before.length + 1);
  const event = after.at(-1);
  assert.equal(event.id, result.event.id);
  assert.equal(event.companyId, COMPANY_A);
  assert.equal(event.orderId, orderId);
  assert.equal(event.eventType, ORDER_STATUS_EVENT);
  assert.deepEqual(event.beforeState, { status: "confirmed" });
  assert.deepEqual(event.afterState, { status: "processing" });
  assert.equal(event.actorType, "staff");
  assert.equal(event.actorId, "u-1");
  assert.equal(typeof event.sequence, "number");
  assert.equal((await storage.findOrder(COMPANY_A, orderId)).status, "processing");
});

test("event sequence increases by one for each transition in a company", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  await transitionOrderInTx(storage, COMPANY_A, orderId, "processing");
  await transitionOrderInTx(storage, COMPANY_A, orderId, "fulfilled");
  await transitionOrderInTx(storage, COMPANY_A, orderId, "completed");

  const events = (await storage.listOrderEvents(COMPANY_A, orderId)).filter((e) => e.eventType === ORDER_STATUS_EVENT);
  assert.deepEqual(
    events.map((e) => [e.beforeState.status, e.afterState.status]),
    [["confirmed", "processing"], ["processing", "fulfilled"], ["fulfilled", "completed"]],
  );
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].sequence, events[i - 1].sequence + 1);
  }
});

test("the status change and its event roll back together when the transaction fails", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  const eventsBefore = await storage.listOrderEvents(COMPANY_A, orderId);

  await assert.rejects(
    storage.transaction(COMPANY_A, async (tx) => {
      await writeOrderTransition(tx, COMPANY_A, orderId, "processing");
      throw new Error("simulated failure after the transition");
    }),
    /simulated failure/,
  );

  assert.equal((await storage.findOrder(COMPANY_A, orderId)).status, "confirmed");
  assert.equal((await storage.listOrderEvents(COMPANY_A, orderId)).length, eventsBefore.length);

  // The sequence is not consumed by the rolled-back event, so the next committed event reuses it.
  const committed = await transitionOrderInTx(storage, COMPANY_A, orderId, "processing");
  assert.equal(committed.event.sequence, eventsBefore.at(-1).sequence + 1);
});

test("an illegal move is refused and writes no event", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  const eventsBefore = await storage.listOrderEvents(COMPANY_A, orderId);

  await assert.rejects(transitionOrderInTx(storage, COMPANY_A, orderId, "completed"), (error) => error instanceof OrderError);
  await assert.rejects(transitionOrderInTx(storage, COMPANY_A, orderId, "confirmed"), (error) => error instanceof OrderError);

  assert.equal((await storage.findOrder(COMPANY_A, orderId)).status, "confirmed");
  assert.equal((await storage.listOrderEvents(COMPANY_A, orderId)).length, eventsBefore.length);
});

test("M1 refund guard: moving to refunded without a refund record writes nothing", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  await transitionOrderInTx(storage, COMPANY_A, orderId, "processing");
  await transitionOrderInTx(storage, COMPANY_A, orderId, "fulfilled");
  const eventsBefore = await storage.listOrderEvents(COMPANY_A, orderId);

  await assert.rejects(transitionOrderInTx(storage, COMPANY_A, orderId, "refunded"), (error) => {
    assert.equal(error.message, REFUND_RECORD_REQUIRED);
    return true;
  });

  assert.equal((await storage.findOrder(COMPANY_A, orderId)).status, "fulfilled");
  assert.equal((await storage.listOrderEvents(COMPANY_A, orderId)).length, eventsBefore.length);
});

test("a return status change writes one event on the order with the return id and before and after status", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  await transitionOrderInTx(storage, COMPANY_A, orderId, "processing");
  await transitionOrderInTx(storage, COMPANY_A, orderId, "fulfilled");
  const ret = await service.requestReturn(COMPANY_A, orderId, {
    items: [{ orderItemId: detail.items[0].id, quantity: 1 }],
    resolution: "refund",
  });
  const eventsBefore = await storage.listOrderEvents(COMPANY_A, orderId);

  const result = await storage.transaction(COMPANY_A, (tx) => writeReturnTransition(tx, COMPANY_A, ret.returnRecord.id, "approved"));

  const events = await storage.listOrderEvents(COMPANY_A, orderId);
  assert.equal(events.length, eventsBefore.length + 1);
  const event = events.at(-1);
  assert.equal(event.id, result.event.id);
  assert.equal(event.companyId, COMPANY_A);
  assert.equal(event.eventType, RETURN_STATUS_EVENT);
  assert.deepEqual(event.beforeState, { returnId: ret.returnRecord.id, status: "requested" });
  assert.deepEqual(event.afterState, { returnId: ret.returnRecord.id, status: "approved" });
  assert.equal((await storage.findReturn(COMPANY_A, ret.returnRecord.id)).status, "approved");
});

test("a return cannot be moved to refunded through the lifecycle write, and writes nothing", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  const orderId = detail.order.id;
  await transitionOrderInTx(storage, COMPANY_A, orderId, "processing");
  await transitionOrderInTx(storage, COMPANY_A, orderId, "fulfilled");
  const ret = await service.requestReturn(COMPANY_A, orderId, {
    items: [{ orderItemId: detail.items[0].id, quantity: 1 }],
    resolution: "refund",
  });
  await storage.transaction(COMPANY_A, (tx) => writeReturnTransition(tx, COMPANY_A, ret.returnRecord.id, "approved"));
  const eventsBefore = await storage.listOrderEvents(COMPANY_A, orderId);

  await assert.rejects(
    storage.transaction(COMPANY_A, (tx) => writeReturnTransition(tx, COMPANY_A, ret.returnRecord.id, "refunded")),
    /refund endpoint/,
  );

  assert.equal((await storage.findReturn(COMPANY_A, ret.returnRecord.id)).status, "approved");
  assert.equal((await storage.listOrderEvents(COMPANY_A, orderId)).length, eventsBefore.length);
});

test("company isolation: another company cannot move the order or write an event on it", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service, COMPANY_A);
  const orderId = detail.order.id;
  const eventsBefore = await storage.listOrderEvents(COMPANY_A, orderId);

  await assert.rejects(transitionOrderInTx(storage, COMPANY_B, orderId, "processing"), (error) => {
    assert.equal(error.status, 404);
    return true;
  });

  assert.equal((await storage.findOrder(COMPANY_A, orderId)).status, "confirmed");
  assert.equal((await storage.listOrderEvents(COMPANY_A, orderId)).length, eventsBefore.length);
  assert.deepEqual(await storage.listOrderEvents(COMPANY_B, orderId), []);
});

test("writes need a company id", async () => {
  const { storage, service } = makeHarness();
  const detail = await placeOrder(service);
  await assert.rejects(() => storage.transaction("", (tx) => writeOrderTransition(tx, "", detail.order.id, "processing")));
});
