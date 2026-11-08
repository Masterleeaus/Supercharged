// Chatbot native orders: Drizzle storage tests, plus the M1 and M2 fixes (node:test).
// No database is reached. Queries are rendered with PgDialect.sqlToQuery(query.getSQL()) and checked for a
// company_id predicate and the company id in the params. A stub client answers statements without a connection.
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import { createOrderService } from "../../server/modules/chatbot/orders/order-service.ts";
import { createMemoryOrderStorage, REFUND_RECORD_REQUIRED } from "../../server/modules/chatbot/orders/order-storage.ts";
import { OrderError } from "../../server/modules/chatbot/orders/order-errors.ts";
import { canTransitionReturn, assertReturnTransition, REFUNDABLE_RETURN_STATUSES } from "../../server/modules/chatbot/orders/lifecycle.ts";
import { computeOrderTotals } from "../../server/modules/chatbot/orders/totals.ts";
import { DrizzleOrderStorage } from "../../server/modules/chatbot/db/orders-storage.ts";
import {
  chatbotCommerceCouponUsages,
  chatbotCommerceCoupons,
  chatbotCommerceOrderEvents,
  chatbotCommerceOrderItems,
  chatbotCommerceOrders,
  chatbotCommerceReturnItems,
  chatbotCommerceReturns,
} from "../../server/modules/chatbot/db/orders.ts";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHATBOT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHECKOUT_A = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-08T10:00:00.000Z");

// The storage interface, copied from order-storage.ts. The tests fail if either side changes alone.
const INTERFACE_METHODS = [
  "transaction",
  "findReturnForUpdate",
  "findOrderForUpdate",
  "createOrder",
  "findOrder",
  "findOrderByCheckout",
  "listOrdersForSession",
  "updateOrder",
  "listOrderItems",
  "findOrderItem",
  "updateOrderItem",
  "createReturn",
  "findReturn",
  "listReturns",
  "listReturnItems",
  "updateReturn",
  "appendOrderEvent",
  "listOrderEvents",
  "createCoupon",
  "findCouponById",
  "findCouponByCode",
  "listCouponUsages",
  "listCartCouponUsages",
  "findCouponUsage",
  "insertCouponUsage",
  "updateCouponUsage",
  "listReservedCouponUsages",
];

const dialect = new PgDialect();

function render(query) {
  return dialect.sqlToQuery(query.getSQL());
}

function defaultRespond(text) {
  // Insert and update statements with RETURNING get one row back, as a real database would.
  return /^(insert|update)/i.test(text) && /returning/i.test(text) ? [{}] : [];
}

function harness(respond = defaultRespond) {
  const captured = [];
  const executed = [];
  const client = {
    query: async (config) => {
      executed.push(config.text);
      return { rows: respond(config.text), rowCount: 0 };
    },
  };
  const storage = new DrizzleOrderStorage(drizzle({ client }), { now: () => NOW, onQuery: (query) => captured.push(query) });
  return { storage, captured, executed };
}

function assertScoped(rendered, companyId) {
  if (/^insert /i.test(rendered.sql)) {
    assert.match(rendered.sql, /"company_id"/, `insert without company_id: ${rendered.sql}`);
  } else {
    assert.match(rendered.sql, /"company_id" = \$\d+/, `statement without company_id predicate: ${rendered.sql}`);
  }
  assert.ok(rendered.params.includes(companyId), `company id missing from params: ${rendered.sql}`);
}

const ORDER_ID = "order-1";
const ITEM_ID = "item-1";
const RETURN_ID = "return-1";
const COUPON_ID = "coupon-1";
const USAGE_ID = "usage-1";
const CART_ID = "cart-1";

/** One scenario per interface method. Each takes the company id so the same call can be made for any tenant. */
const SCENARIOS = [
  [
    "createOrder",
    (s, c) =>
      s.createOrder(
        c,
        {
          orderNumber: "O-1",
          chatbotId: CHATBOT_A,
          cartId: CART_ID,
          checkoutId: CHECKOUT_A,
          paymentIntentId: null,
          customerIdentityId: null,
          conversationId: null,
          sessionId: "session-1",
          source: "internal",
          status: "confirmed",
          fulfillmentStatus: "unfulfilled",
          currency: "AUD",
          subtotal: 3000,
          discountTotal: 0,
          taxTotal: 300,
          shippingTotal: 300,
          total: 3600,
          refundedTotal: 0,
          customerSnapshot: {},
          billingAddress: {},
          shippingAddress: {},
          paymentSnapshot: {},
          metadata: {},
          placedAt: NOW,
          confirmedAt: NOW,
          completedAt: null,
          cancelledAt: null,
        },
        [
          {
            productId: "p1",
            variantId: "v1",
            sku: "SKU-1",
            name: "Filter",
            variantName: null,
            quantity: 2,
            fulfilledQuantity: 0,
            returnedQuantity: 0,
            listUnitPrice: 1000,
            unitPrice: 1000,
            discountTotal: 0,
            taxTotal: 200,
            lineTotal: 2200,
            metadata: {},
          },
        ],
      ),
  ],
  ["findOrder", (s, c) => s.findOrder(c, ORDER_ID)],
  ["findOrderForUpdate", (s, c) => s.findOrderForUpdate(c, ORDER_ID)],
  ["findReturnForUpdate", (s, c) => s.findReturnForUpdate(c, RETURN_ID)],
  ["transaction", (s, c) => s.transaction(c, async (tx) => tx.findOrder(c, ORDER_ID))],
  ["findOrderByCheckout", (s, c) => s.findOrderByCheckout(c, CHECKOUT_A)],
  ["listOrdersForSession", (s, c) => s.listOrdersForSession(c, { chatbotId: CHATBOT_A, sessionId: "session-1", customerIdentityId: "ci-1" }, 10, 0)],
  ["updateOrder", (s, c) => s.updateOrder(c, ORDER_ID, { status: "processing" })],
  ["listOrderItems", (s, c) => s.listOrderItems(c, ORDER_ID)],
  ["findOrderItem", (s, c) => s.findOrderItem(c, ITEM_ID)],
  ["updateOrderItem", (s, c) => s.updateOrderItem(c, ITEM_ID, { returnedQuantity: 1 })],
  [
    "createReturn",
    (s, c) =>
      s.createReturn(
        c,
        {
          rmaNumber: "RMA-1",
          orderId: ORDER_ID,
          customerIdentityId: null,
          status: "requested",
          reasonCode: null,
          reason: null,
          requestedResolution: "refund",
          requestedAmount: 1100,
          refundedAmount: 0,
          currency: "AUD",
          quantitiesReleased: false,
          paymentRefunds: [],
          metadata: {},
          approvedAt: null,
          receivedAt: null,
          resolvedAt: null,
          cancelledAt: null,
        },
        [{ orderItemId: ITEM_ID, quantity: 1, reasonCode: null, condition: null, amount: 1100, metadata: {} }],
      ),
  ],
  ["findReturn", (s, c) => s.findReturn(c, RETURN_ID)],
  ["listReturns", (s, c) => s.listReturns(c, ORDER_ID)],
  ["listReturnItems", (s, c) => s.listReturnItems(c, RETURN_ID)],
  ["updateReturn", (s, c) => s.updateReturn(c, RETURN_ID, { status: "approved", approvedAt: NOW })],
  [
    "appendOrderEvent",
    (s, c) =>
      s.appendOrderEvent(c, {
        orderId: ORDER_ID,
        eventType: "order.status_changed",
        actorType: "system",
        actorId: null,
        beforeState: null,
        afterState: { status: "processing" },
        metadata: {},
      }),
  ],
  ["listOrderEvents", (s, c) => s.listOrderEvents(c, ORDER_ID)],
  [
    "createCoupon",
    (s, c) =>
      s.createCoupon(c, {
        chatbotId: CHATBOT_A,
        code: "SAVE10",
        type: "percentage",
        value: 1000,
        minimumAmount: 0,
        maxDiscountAmount: null,
        active: true,
        startsAt: null,
        endsAt: null,
        currency: null,
        channels: [],
        firstOrderOnly: false,
        usageLimit: null,
        usageLimitPerCustomer: null,
        appliesTo: "cart",
        targetIds: [],
        stackable: true,
      }),
  ],
  ["findCouponById", (s, c) => s.findCouponById(c, COUPON_ID)],
  ["findCouponByCode", (s, c) => s.findCouponByCode(c, CHATBOT_A, "SAVE10")],
  ["listCouponUsages", (s, c) => s.listCouponUsages(c, COUPON_ID)],
  ["listCartCouponUsages", (s, c) => s.listCartCouponUsages(c, CART_ID)],
  ["findCouponUsage", (s, c) => s.findCouponUsage(c, COUPON_ID, CART_ID)],
  [
    "insertCouponUsage",
    (s, c) =>
      s.insertCouponUsage(c, {
        couponId: COUPON_ID,
        cartId: CART_ID,
        customerIdentityId: null,
        status: "reserved",
        channel: "web",
        currency: "AUD",
        reservedAt: NOW,
        redeemedAt: null,
        releasedAt: null,
        expiresAt: NOW,
      }),
  ],
  ["updateCouponUsage", (s, c) => s.updateCouponUsage(c, USAGE_ID, { status: "redeemed", redeemedAt: NOW })],
  ["listReservedCouponUsages", (s, c) => s.listReservedCouponUsages(c, 5)],
];

// ---------- fixtures for the memory service (M1 and M2) ----------

function clockAt(date) {
  const state = { current: new Date(date) };
  return { now: () => new Date(state.current) };
}

function makeService() {
  const clock = clockAt(NOW);
  let counter = 0;
  const storage = createMemoryOrderStorage({ now: clock.now });
  const service = createOrderService({
    storage,
    enabled: true,
    now: clock.now,
    randomHex: () => (++counter).toString(16).padStart(8, "0"),
    publisher: { publish() {} },
  });
  return { service, storage };
}

async function placeOrder(service, companyId = COMPANY_A) {
  const lines = [
    { productId: "p1", variantId: "v1", sku: "SKU-1", name: "Filter", quantity: 2, listUnitPrice: 1000, unitPrice: 1000, discountTotal: 0, taxTotal: 200, lineTotal: 2200 },
  ];
  const totals = computeOrderTotals(lines, 300);
  return service.createOrderFromCheckout(companyId, {
    checkoutId: CHECKOUT_A,
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

async function fulfilledOrder(service, companyId = COMPANY_A) {
  const detail = await placeOrder(service, companyId);
  await service.transitionOrder(companyId, detail.order.id, "processing");
  await service.transitionOrder(companyId, detail.order.id, "fulfilled");
  return service.getOrder(companyId, detail.order.id);
}

// ---------- M2: return lifecycle approved -> refunded ----------

test("M2: the return table allows approved -> refunded, as PHP recordRefund does", () => {
  assert.equal(canTransitionReturn("approved", "refunded"), true);
  assert.equal(assertReturnTransition("approved", "refunded"), "refunded");
  assert.ok(REFUNDABLE_RETURN_STATUSES.includes("approved"), "approved must stay a refundable status");
});

test("M2: the new edge does not open any other return transition", () => {
  assert.equal(canTransitionReturn("requested", "refunded"), false);
  assert.equal(canTransitionReturn("in_transit", "refunded"), false);
  assert.equal(canTransitionReturn("rejected", "refunded"), false);
  assert.equal(canTransitionReturn("cancelled", "refunded"), false);
  assert.equal(canTransitionReturn("refunded", "approved"), false);
  assert.equal(canTransitionReturn("approved", "requested"), false);
  assert.throws(() => assertReturnTransition("requested", "refunded"), OrderError);
});

test("M2: a service refund of an approved return reaches refunded, and the order follows", async () => {
  const { service } = makeService();
  const order = await fulfilledOrder(service);
  const ret = await service.requestReturn(COMPANY_A, order.order.id, {
    items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    resolution: "refund",
  });
  await service.transitionReturn(COMPANY_A, ret.returnRecord.id, "approved");
  const refunded = await service.recordRefund(COMPANY_A, ret.returnRecord.id, ret.returnRecord.requestedAmount);
  assert.equal(refunded.returnRecord.status, "refunded");
  // The return is smaller than the order total, so the order is partly refunded, not fully.
  assert.equal((await service.getOrder(COMPANY_A, order.order.id)).order.status, "partially_refunded");
});

// ---------- M1: no refunded order without a refund record ----------

test("M1: transitionOrder cannot move a confirmed order to refunded with no refund record", async () => {
  const { service } = makeService();
  const id = (await placeOrder(service)).order.id;
  await assert.rejects(
    () => service.transitionOrder(COMPANY_A, id, "refunded"),
    (error) => error instanceof OrderError && error.message === REFUND_RECORD_REQUIRED,
  );
  const after = await service.getOrder(COMPANY_A, id);
  assert.equal(after.order.status, "confirmed", "a refused transition must not change the order");
  assert.equal(after.events.length, 1, "a refused transition must not append an event");
});

test("M1: the memory store refuses refunded when no return of the order has a refunded amount", async () => {
  const { storage } = makeService();
  const order = (await storage.createOrder(COMPANY_A, { ...orderInsertFixture() }, [])).order;
  await assert.rejects(() => storage.updateOrder(COMPANY_A, order.id, { status: "refunded" }), /without a refund record/);
  assert.equal((await storage.findOrder(COMPANY_A, order.id)).status, "confirmed");
});

test("M1: a refunded amount on one of the order's returns allows refunded", async () => {
  const { storage } = makeService();
  const order = (await storage.createOrder(COMPANY_A, orderInsertFixture(), [])).order;
  const ret = (await storage.createReturn(COMPANY_A, returnInsertFixture(order.id), [])).returnRecord;
  await storage.updateReturn(COMPANY_A, ret.id, { refundedAmount: 500 });
  const updated = await storage.updateOrder(COMPANY_A, order.id, { status: "refunded", refundedTotal: 500 });
  assert.equal(updated.status, "refunded");
});

test("M1: a refund on another order does not count", async () => {
  const { storage } = makeService();
  const first = (await storage.createOrder(COMPANY_A, orderInsertFixture(), [])).order;
  const second = (await storage.createOrder(COMPANY_A, { ...orderInsertFixture(), checkoutId: "10000000-0000-4000-8000-000000000002" }, [])).order;
  const ret = (await storage.createReturn(COMPANY_A, returnInsertFixture(first.id), [])).returnRecord;
  await storage.updateReturn(COMPANY_A, ret.id, { refundedAmount: 500 });
  await assert.rejects(() => storage.updateOrder(COMPANY_A, second.id, { status: "refunded" }), /without a refund record/);
});

test("M1: the Drizzle guard is one UPDATE whose WHERE holds an EXISTS on a refunded return", async () => {
  const { storage, captured } = harness();
  await storage.updateOrder(COMPANY_A, ORDER_ID, { status: "refunded" });
  const sql = render(captured[0]).sql;
  assert.match(sql, /^update "chatbot_commerce_orders"/i);
  assert.match(sql, /exists \(select 1 from "chatbot_commerce_returns"/i);
  assert.match(sql, /"chatbot_commerce_returns"\."refunded_amount" > 0/);
  const { params } = render(captured[0]);
  // The order predicate and the EXISTS subquery are both scoped to the company.
  assert.equal(params.filter((value) => value === COMPANY_A).length, 2, "order and return predicates must both be company-scoped");
});

test("M1: the Drizzle guard is not added to ordinary status changes", async () => {
  const { storage, captured } = harness();
  await storage.updateOrder(COMPANY_A, ORDER_ID, { status: "processing" });
  assert.doesNotMatch(render(captured[0]).sql, /exists/i);
});

test("M1: the Drizzle store refuses refunded when the guarded update changes no row and the order exists", async () => {
  const { storage } = harness((text) => {
    if (/^update/i.test(text)) return [];
    if (/^select/i.test(text)) return [{}];
    return [];
  });
  await assert.rejects(
    storage.updateOrder(COMPANY_A, ORDER_ID, { status: "refunded" }),
    (error) => error instanceof OrderError && error.message === REFUND_RECORD_REQUIRED,
  );
});

test("M1: the Drizzle store returns null, not an error, when the order is missing", async () => {
  const { storage } = harness((text) => (/^(update|select)/i.test(text) ? [] : []));
  assert.equal(await storage.updateOrder(COMPANY_A, ORDER_ID, { status: "refunded" }), null);
});

// ---------- interface parity and scope ----------

test("DrizzleOrderStorage implements every OrderStorage method and nothing else", () => {
  const own = Object.getOwnPropertyNames(DrizzleOrderStorage.prototype).filter((name) => name !== "constructor" && name !== "q");
  assert.deepEqual([...own].sort(), [...INTERFACE_METHODS].sort());
});

test("the memory store exposes the same method list as the interface", () => {
  const keys = Object.keys(createMemoryOrderStorage()).sort();
  assert.deepEqual(keys, [...INTERFACE_METHODS].sort());
});

test("every SCENARIO covers one interface method", () => {
  assert.deepEqual(SCENARIOS.map(([name]) => name).sort(), [...INTERFACE_METHODS].sort());
});

test("every statement from every method filters by company_id and carries the company id", async () => {
  for (const [name, call] of SCENARIOS) {
    const { storage, captured } = harness();
    await call(storage, COMPANY_A);
    assert.ok(captured.length > 0, `${name} produced no statement`);
    for (const query of captured) assertScoped(render(query), COMPANY_A);
  }
});

test("no statement carries the other company's id", async () => {
  for (const [name, call] of SCENARIOS) {
    const { storage, captured } = harness();
    await call(storage, COMPANY_A);
    for (const query of captured) {
      assert.ok(!render(query).params.includes(COMPANY_B), `${name} leaked company B`);
    }
  }
});

test("a missing or malformed company id is refused before any statement runs", async () => {
  for (const [name, call] of SCENARIOS) {
    for (const bad of [undefined, "", "not-a-uuid"]) {
      const { storage, captured } = harness();
      await assert.rejects(call(storage, bad), (err) => err instanceof ChatbotError && err.status === 403, name);
      assert.equal(captured.length, 0, `${name} ran a statement without a company`);
    }
  }
});

test("the memory store isolates companies: an order in A is invisible to B", async () => {
  const { storage } = makeService();
  const order = (await storage.createOrder(COMPANY_A, orderInsertFixture(), [])).order;
  assert.equal(await storage.findOrder(COMPANY_B, order.id), null);
  assert.deepEqual(await storage.listOrdersForSession(COMPANY_B, { chatbotId: CHATBOT_A, sessionId: "session-1", customerIdentityId: null }, 10, 0), []);
});

// ---------- statement shapes ----------

test("a session listing matches the customer identity only when one is given", async () => {
  const withIdentity = harness();
  await withIdentity.storage.listOrdersForSession(COMPANY_A, { chatbotId: CHATBOT_A, sessionId: "s", customerIdentityId: "ci-1" }, 10, 0);
  const withWhere = render(withIdentity.captured[0]).sql.split(" where ")[1];
  assert.match(withWhere, /"customer_identity_id" = \$\d+/);

  const sessionOnly = harness();
  await sessionOnly.storage.listOrdersForSession(COMPANY_A, { chatbotId: CHATBOT_A, sessionId: "s", customerIdentityId: null }, 10, 0);
  const onlyWhere = render(sessionOnly.captured[0]).sql.split(" where ")[1];
  assert.doesNotMatch(onlyWhere, /"customer_identity_id"/);
});

test("the event sequence is computed inside the insert, scoped to the company", async () => {
  const { storage, captured } = harness();
  await storage.appendOrderEvent(COMPANY_A, {
    orderId: ORDER_ID,
    eventType: "order.status_changed",
    actorType: "system",
    actorId: null,
    beforeState: null,
    afterState: {},
    metadata: {},
  });
  const sql = render(captured[0]).sql;
  assert.match(sql, /^insert into "chatbot_commerce_order_events"/i);
  assert.match(sql, /\(select coalesce\(max\("chatbot_commerce_order_events"\."sequence"\), 0\) \+ 1 from "chatbot_commerce_order_events" where "chatbot_commerce_order_events"\."company_id" = \$\d+\)/);
});

test("a repeated checkout is refused with 409 when the insert conflicts", async () => {
  const { storage } = harness((text) => (/^insert into "chatbot_commerce_orders"/i.test(text) ? [] : defaultRespond(text)));
  await assert.rejects(
    storage.createOrder(COMPANY_A, orderInsertFixture(), []),
    (error) => error instanceof OrderError && error.status === 409,
  );
});

test("a repeated coupon code for the same chatbot is refused with 409", async () => {
  const { storage } = harness((text) => (/^insert into "chatbot_commerce_coupons"/i.test(text) ? [] : defaultRespond(text)));
  await assert.rejects(
    storage.createCoupon(COMPANY_A, couponInsertFixture()),
    (error) => error instanceof OrderError && error.status === 409,
  );
});

test("a repeated coupon usage for the same cart is refused with 409", async () => {
  const { storage } = harness((text) => (/^insert into "chatbot_commerce_coupon_usages"/i.test(text) ? [] : defaultRespond(text)));
  await assert.rejects(
    storage.insertCouponUsage(COMPANY_A, usageInsertFixture()),
    (error) => error instanceof OrderError && error.status === 409,
  );
});

// ---------- append-only event log ----------

const EVENT_MUTATOR = /event/i;
const MUTATION_WORD = /(update|delete|remove|patch|replace|set|upsert|truncate|clear)/i;

test("append-only: the memory store has no method that updates or deletes an event", () => {
  const { storage } = makeService();
  const offenders = Object.keys(storage).filter((name) => EVENT_MUTATOR.test(name) && MUTATION_WORD.test(name));
  assert.deepEqual(offenders, []);
  // The only event methods are append and list.
  assert.deepEqual(Object.keys(storage).filter((name) => EVENT_MUTATOR.test(name)).sort(), ["appendOrderEvent", "listOrderEvents"]);
});

test("append-only: the Drizzle store has no method that updates or deletes an event", () => {
  const names = Object.getOwnPropertyNames(DrizzleOrderStorage.prototype);
  const offenders = names.filter((name) => EVENT_MUTATOR.test(name) && MUTATION_WORD.test(name));
  assert.deepEqual(offenders, []);
  assert.deepEqual(names.filter((name) => EVENT_MUTATOR.test(name)).sort(), ["appendOrderEvent", "listOrderEvents"]);
});

test("append-only: no statement against the event table is an UPDATE or DELETE", async () => {
  const { storage, captured } = harness();
  await storage.appendOrderEvent(COMPANY_A, {
    orderId: ORDER_ID,
    eventType: "x",
    actorType: "system",
    actorId: null,
    beforeState: null,
    afterState: null,
    metadata: {},
  });
  await storage.listOrderEvents(COMPANY_A, ORDER_ID);
  for (const query of captured) {
    const text = render(query).sql;
    if (!text.includes('"chatbot_commerce_order_events"')) continue;
    assert.match(text, /^(insert into|select)\b/i, `event table touched by: ${text}`);
  }
});

// ---------- schema ----------

const ORDER_TABLES = [
  chatbotCommerceOrders,
  chatbotCommerceOrderItems,
  chatbotCommerceOrderEvents,
  chatbotCommerceReturns,
  chatbotCommerceReturnItems,
  chatbotCommerceCoupons,
  chatbotCommerceCouponUsages,
];

test("every orders table is named with the chatbot_ prefix and carries a NOT NULL company_id", () => {
  for (const table of ORDER_TABLES) {
    const config = getTableConfig(table);
    assert.match(config.name, /^chatbot_/, `${config.name} is not chatbot_ prefixed`);
    const column = config.columns.find((col) => col.name === "company_id");
    assert.ok(column, `${config.name} has no company_id`);
    assert.equal(column.notNull, true, `${config.name}.company_id must be NOT NULL`);
  }
});

test("the coupon tables use the names the pricing slice must not clash with", () => {
  assert.equal(getTableConfig(chatbotCommerceCoupons).name, "chatbot_commerce_coupons");
  assert.equal(getTableConfig(chatbotCommerceCouponUsages).name, "chatbot_commerce_coupon_usages");
});

test("every foreign key on an orders table is company-scoped", () => {
  for (const table of ORDER_TABLES) {
    const config = getTableConfig(table);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      assert.equal(ref.columns[0].name, "company_id", `${config.name} FK ${fk.getName()} is not company-scoped`);
      assert.equal(ref.foreignColumns[0].name, "company_id", `${config.name} FK ${fk.getName()} points outside the company`);
    }
  }
});

test("uniqueness is per company for checkout, coupon code, coupon usage and event sequence", () => {
  const uniqueColumns = (table) =>
    getTableConfig(table).indexes.filter((index) => index.config.unique).map((index) => index.config.columns.map((col) => col.name));
  assert.ok(uniqueColumns(chatbotCommerceOrders).some((cols) => JSON.stringify(cols) === JSON.stringify(["company_id", "checkout_id"])));
  assert.ok(uniqueColumns(chatbotCommerceCoupons).some((cols) => JSON.stringify(cols) === JSON.stringify(["company_id", "chatbot_id", "code"])));
  assert.ok(uniqueColumns(chatbotCommerceCouponUsages).some((cols) => JSON.stringify(cols) === JSON.stringify(["company_id", "coupon_id", "cart_id"])));
  assert.ok(uniqueColumns(chatbotCommerceOrderEvents).some((cols) => JSON.stringify(cols) === JSON.stringify(["company_id", "sequence"])));
  for (const table of ORDER_TABLES) {
    for (const cols of uniqueColumns(table)) {
      assert.equal(cols[0], "company_id", `${getTableConfig(table).name} has a unique key that is not company-scoped`);
    }
  }
});

test("money columns are 53-bit integers in minor units, never floating point", () => {
  const moneyColumns = {
    chatbot_commerce_orders: ["subtotal", "discount_total", "tax_total", "shipping_total", "total", "refunded_total"],
    chatbot_commerce_order_items: ["list_unit_price", "unit_price", "discount_total", "tax_total", "line_total"],
    chatbot_commerce_returns: ["requested_amount", "refunded_amount"],
    chatbot_commerce_return_items: ["amount"],
    chatbot_commerce_coupons: ["value", "minimum_amount", "max_discount_amount"],
  };
  const tables = { chatbot_commerce_orders: chatbotCommerceOrders, chatbot_commerce_order_items: chatbotCommerceOrderItems, chatbot_commerce_returns: chatbotCommerceReturns, chatbot_commerce_return_items: chatbotCommerceReturnItems, chatbot_commerce_coupons: chatbotCommerceCoupons };
  for (const [tableName, names] of Object.entries(moneyColumns)) {
    const config = getTableConfig(tables[tableName]);
    for (const name of names) {
      const column = config.columns.find((col) => col.name === name);
      assert.ok(column, `${tableName}.${name} missing`);
      assert.equal(column.columnType, "PgBigInt53", `${tableName}.${name} must be a bigint in minor units`);
    }
  }
  for (const table of ORDER_TABLES) {
    for (const column of getTableConfig(table).columns) {
      assert.doesNotMatch(column.columnType, /Real|DoublePrecision|Numeric/, `${getTableConfig(table).name}.${column.name} is floating point`);
    }
  }
});

test("the Drizzle store opens a transaction for a multi-row write", async () => {
  const { storage, executed } = harness();
  await storage.createOrder(COMPANY_A, orderInsertFixture(), [
    { productId: null, variantId: null, sku: null, name: "x", variantName: null, quantity: 1, fulfilledQuantity: 0, returnedQuantity: 0, listUnitPrice: 0, unitPrice: 0, discountTotal: 0, taxTotal: 0, lineTotal: 0, metadata: {} },
  ]);
  assert.ok(executed.some((text) => /^begin/i.test(text)), "createOrder must run inside a transaction");
});

// ---------- fixtures used above ----------

function orderInsertFixture() {
  return {
    orderNumber: "O-1",
    chatbotId: CHATBOT_A,
    cartId: CART_ID,
    checkoutId: CHECKOUT_A,
    paymentIntentId: null,
    customerIdentityId: null,
    conversationId: null,
    sessionId: "session-1",
    source: "internal",
    status: "confirmed",
    fulfillmentStatus: "unfulfilled",
    currency: "AUD",
    subtotal: 3000,
    discountTotal: 0,
    taxTotal: 0,
    shippingTotal: 0,
    total: 3000,
    refundedTotal: 0,
    customerSnapshot: {},
    billingAddress: {},
    shippingAddress: {},
    paymentSnapshot: {},
    metadata: {},
    placedAt: NOW,
    confirmedAt: NOW,
    completedAt: null,
    cancelledAt: null,
  };
}

function returnInsertFixture(orderId) {
  return {
    rmaNumber: `RMA-${orderId}`,
    orderId,
    customerIdentityId: null,
    status: "approved",
    reasonCode: null,
    reason: null,
    requestedResolution: "refund",
    requestedAmount: 500,
    refundedAmount: 0,
    currency: "AUD",
    quantitiesReleased: false,
    paymentRefunds: [],
    metadata: {},
    approvedAt: NOW,
    receivedAt: null,
    resolvedAt: null,
    cancelledAt: null,
  };
}

function couponInsertFixture() {
  return {
    chatbotId: CHATBOT_A,
    code: "SAVE10",
    type: "percentage",
    value: 1000,
    minimumAmount: 0,
    maxDiscountAmount: null,
    active: true,
    startsAt: null,
    endsAt: null,
    currency: null,
    channels: [],
    firstOrderOnly: false,
    usageLimit: null,
    usageLimitPerCustomer: null,
    appliesTo: "cart",
    targetIds: [],
    stackable: true,
  };
}

function usageInsertFixture() {
  return {
    couponId: COUPON_ID,
    cartId: CART_ID,
    customerIdentityId: null,
    status: "reserved",
    channel: "web",
    currency: "AUD",
    reservedAt: NOW,
    redeemedAt: null,
    releasedAt: null,
    expiresAt: NOW,
  };
}

// ---------- H-1: a refund is one transaction with row locks ----------

/**
 * Positional row for the driver. Drizzle reads node-postgres rows by column position, so the stub builds an array
 * in the order of the SELECT or RETURNING list, taking each value from the fixture by camelCase name.
 */
function rowsFor(text, fixture) {
  const list = /^select (.+?) from /is.exec(text)?.[1] ?? /returning (.+)$/is.exec(text)?.[1];
  if (!list) return [];
  const cols = list.split(",").map((c) => c.trim().replace(/"/g, ""));
  return [cols.map((c) => fixture[c.replace(/_([a-z])/g, (_, x) => x.toUpperCase())])];
}

/** Drizzle service over a stub client. Reads and writes of the return and order answer the given fixtures. */
function refundHarness(order, ret) {
  const captured = [];
  const executed = [];
  const respond = (text) => {
    if (/^select .* from "chatbot_commerce_returns"/i.test(text)) return rowsFor(text, ret);
    if (/^select .* from "chatbot_commerce_orders"/i.test(text)) return rowsFor(text, order);
    if (/^update "chatbot_commerce_returns"/i.test(text)) return rowsFor(text, ret);
    if (/^update "chatbot_commerce_orders"/i.test(text)) return rowsFor(text, order);
    if (/^select .* from "chatbot_commerce_return_items"/i.test(text)) return [];
    if (/^insert/i.test(text) && /returning/i.test(text)) return rowsFor(text, {});
    return [];
  };
  const client = {
    query: async (config) => {
      executed.push(config.text);
      return { rows: respond(config.text), rowCount: 0 };
    },
  };
  const storage = new DrizzleOrderStorage(drizzle({ client }), { now: () => NOW, onQuery: (query) => captured.push(query) });
  const service = createOrderService({ storage, enabled: true, now: () => NOW, publisher: { publish() {} } });
  return { service, captured, executed };
}

const REFUND_RETURN = {
  id: RETURN_ID,
  companyId: COMPANY_A,
  orderId: ORDER_ID,
  status: "approved",
  requestedAmount: 1000,
  refundedAmount: 0,
  paymentRefunds: [],
  metadata: {},
  quantitiesReleased: false,
};

const REFUND_ORDER = {
  id: ORDER_ID,
  companyId: COMPANY_A,
  status: "confirmed",
  fulfillmentStatus: "fulfilled",
  currency: "AUD",
  total: 3000,
  refundedTotal: 0,
  customerSnapshot: {},
  billingAddress: {},
  shippingAddress: {},
  paymentSnapshot: {},
  metadata: {},
};

test("H-1: the Drizzle refund locks the return row and then the order row, with FOR UPDATE in the rendered SQL", async () => {
  const { service, captured, executed } = refundHarness(REFUND_ORDER, REFUND_RETURN);
  await service.recordRefund(COMPANY_A, RETURN_ID, 400);
  const forUpdate = captured.map((query) => render(query).sql).filter((sql) => /for update/i.test(sql));
  assert.equal(forUpdate.length, 2, `expected two locking reads, got ${forUpdate.length}`);
  assert.match(forUpdate[0], /"chatbot_commerce_returns"/, "the return must be locked first");
  assert.match(forUpdate[1], /"chatbot_commerce_orders"/, "the order must be locked second");
  for (const sql of forUpdate) assert.match(sql, /"company_id" = \$\d+/, "a locking read must carry the company predicate");
});

test("H-1: the Drizzle refund writes both rows inside one transaction, after both locks, and commits", async () => {
  const { service, executed } = refundHarness(REFUND_ORDER, REFUND_RETURN);
  await service.recordRefund(COMPANY_A, RETURN_ID, 400);
  const at = (pattern) => executed.findIndex((text) => pattern.test(text));
  const begin = at(/^begin/i);
  const lockReturn = at(/chatbot_commerce_returns".*for update/i);
  const lockOrder = at(/chatbot_commerce_orders".*for update/i);
  const writeReturn = at(/^update "chatbot_commerce_returns"/i);
  const writeOrder = at(/^update "chatbot_commerce_orders"/i);
  const commit = at(/^commit/i);
  assert.ok(begin >= 0 && commit > begin, "the refund must run between begin and commit");
  assert.ok(lockReturn > begin && lockOrder > lockReturn, "both locks must be taken inside the transaction");
  assert.ok(writeReturn > lockOrder && writeOrder > writeReturn, "both writes must follow both locks");
  assert.ok(commit > writeOrder, "the commit must come after both writes");
});

test("H-1: the refunded total is checked against the order total on the locked row, and a refusal writes nothing", async () => {
  const nearlyRefunded = { ...REFUND_ORDER, refundedTotal: 2900 };
  const { service, executed } = refundHarness(nearlyRefunded, REFUND_RETURN);
  await assert.rejects(() => service.recordRefund(COMPANY_A, RETURN_ID, 200), /exceed the order total/);
  assert.ok(executed.some((text) => /chatbot_commerce_orders".*for update/i.test(text)), "the order must be locked before the check");
  assert.ok(!executed.some((text) => /^update /i.test(text)), "a refused refund must not write either row");
  assert.ok(executed.some((text) => /^rollback/i.test(text)), "a refused refund must roll back");
});

test("H-1: the memory store rolls back every write in a transaction whose callback throws", async () => {
  const storage = createMemoryOrderStorage({ now: () => NOW });
  const bundle = await storage.createOrder(COMPANY_A, orderInsertFixture(), []);
  await assert.rejects(
    () =>
      storage.transaction(COMPANY_A, async (tx) => {
        await tx.updateOrder(COMPANY_A, bundle.order.id, { refundedTotal: 500 });
        throw new OrderError("stop");
      }),
    /stop/,
  );
  assert.equal((await storage.findOrder(COMPANY_A, bundle.order.id)).refundedTotal, 0);
});
