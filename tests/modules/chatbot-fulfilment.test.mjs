// Fulfilment, inventory and dispatch tests (node:test). No database, no Express.
// Covers reservation limits, release and expiry, commit, adjustments, partial fulfilment, the
// over-fulfilment guard, the dispatch state machine, idempotency, tracking, and company isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import {
  FULFILMENT_FLAG,
  createFulfilmentModule,
  createMemoryFulfilmentStorage,
  isFulfilmentEnabled,
} from "../../server/modules/chatbot/fulfilment/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

// ---------- fixtures ----------

function harness({ requireTrackingForDelivery = false } = {}) {
  const clock = { t: new Date("2026-11-08T09:00:00Z") };
  let seq = 0;
  const storage = createMemoryFulfilmentStorage();
  const mod = createFulfilmentModule({
    storage,
    env: { [FULFILMENT_FLAG]: "true" },
    clock: { now: () => new Date(clock.t), newId: () => `id-${++seq}` },
    requireTrackingForDelivery,
  });
  return {
    storage,
    inventory: mod.inventory,
    fulfilment: mod.fulfilment,
    advanceMinutes(minutes) {
      clock.t = new Date(clock.t.getTime() + minutes * 60_000);
    },
  };
}

async function addLocation(h, companyId, id = "loc-1", active = true) {
  await h.storage.saveLocation(companyId, { id, companyId, code: id, name: id, active, priority: 100 });
  return id;
}

/** Receives units into a location, so the stock row exists with a known quantity. */
async function receive(h, companyId, units, { variant = "v1", location = "loc-1" } = {}) {
  await addLocation(h, companyId, location);
  return h.inventory.adjust(companyId, { variantId: variant, delta: units, reason: "receive", locationId: location });
}

/** Reserves and commits units for a cart, the way checkout does. */
async function reserveAndCommit(h, companyId, units, { variant = "v1", location = "loc-1", key = "cart-1" } = {}) {
  const reservation = await h.inventory.reserve(companyId, {
    holderId: key,
    variantId: variant,
    quantity: units,
    idempotencyKey: `res-${key}-${units}-${variant}`,
    holderQuantity: units,
    locationId: location,
  });
  return h.inventory.commit(companyId, reservation.id);
}

async function registerOrder(h, companyId, id, quantity, { variant = "v1", lineId = `${id}-line` } = {}) {
  return h.fulfilment.registerOrder(companyId, {
    id,
    reference: `SO-${id}`,
    lines: [{ id: lineId, variantId: variant, productId: "p1", sku: "SKU-1", name: "Widget", quantity }],
  });
}

// ---------- tests ----------

test("fulfilment module stays off unless the flag is exactly true", () => {
  const storage = createMemoryFulfilmentStorage();
  assert.throws(() => createFulfilmentModule({ storage, env: {} }), (error) => error instanceof ChatbotError && error.status === 404);
  assert.throws(
    () => createFulfilmentModule({ storage, env: { [FULFILMENT_FLAG]: "TRUE" } }),
    (error) => error instanceof ChatbotError && error.status === 404,
  );
  assert.equal(isFulfilmentEnabled({}), false);
  assert.equal(isFulfilmentEnabled({ [FULFILMENT_FLAG]: "true" }), true);
});

test("a reservation cannot exceed available stock and a failed attempt changes nothing", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);

  const first = await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 3, idempotencyKey: "r1", holderQuantity: 10, locationId: "loc-1",
  });
  assert.equal(first.status, "active");

  await assert.rejects(
    h.inventory.reserve(COMPANY_A, {
      holderId: "cart-2", variantId: "v1", quantity: 3, idempotencyKey: "r2", holderQuantity: 10, locationId: "loc-1",
    }),
    (error) => error.status === 422 && error.message === "Only 2 unit(s) are currently available.",
  );

  const view = await h.inventory.availability(COMPANY_A, "v1", "loc-1");
  assert.equal(view.reserved, 3);
  assert.equal(view.available, 2);
});

test("backorders are allowed only where the stock row permits them", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 1);
  await assert.rejects(
    h.inventory.reserve(COMPANY_A, {
      holderId: "cart-1", variantId: "v1", quantity: 2, idempotencyKey: "r1", holderQuantity: 2, locationId: "loc-1",
    }),
    /Only 1 unit\(s\) are currently available/,
  );

  const stock = await h.storage.getStock(COMPANY_A, "v1", "loc-1");
  await h.storage.saveStock(COMPANY_A, { ...stock, allowBackorder: true });
  const reservation = await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 2, idempotencyKey: "r1", holderQuantity: 2, locationId: "loc-1",
  });
  assert.equal(reservation.quantity, 2);
});

test("a holder cannot reserve more than it holds in the cart", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 10);
  await assert.rejects(
    h.inventory.reserve(COMPANY_A, {
      holderId: "cart-1", variantId: "v1", quantity: 3, idempotencyKey: "r1", holderQuantity: 2, locationId: "loc-1",
    }),
    /exceeds the quantity currently held in the cart/,
  );
});

test("reserve is idempotent per key and rejects a different payload under the same key", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 10);
  const input = { holderId: "cart-1", variantId: "v1", quantity: 2, idempotencyKey: "r1", holderQuantity: 2, locationId: "loc-1" };
  const first = await h.inventory.reserve(COMPANY_A, input);
  const replay = await h.inventory.reserve(COMPANY_A, input);
  assert.equal(replay.id, first.id);
  assert.equal((await h.inventory.availability(COMPANY_A, "v1", "loc-1")).reserved, 2);

  await assert.rejects(
    h.inventory.reserve(COMPANY_A, { ...input, quantity: 1 }),
    (error) => error.status === 409,
  );
});

test("release restores stock once and only the holder can release by cart", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  const reservation = await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 4, idempotencyKey: "r1", holderQuantity: 4, locationId: "loc-1",
  });
  assert.equal((await h.inventory.availability(COMPANY_A, "v1", "loc-1")).available, 1);

  await assert.rejects(
    h.inventory.releaseForHolder(COMPANY_A, "cart-other", reservation.id),
    /does not belong to this cart/,
  );

  const released = await h.inventory.releaseForHolder(COMPANY_A, "cart-1", reservation.id);
  assert.equal(released.status, "released");
  let view = await h.inventory.availability(COMPANY_A, "v1", "loc-1");
  assert.equal(view.reserved, 0);
  assert.equal(view.available, 5);

  await h.inventory.release(COMPANY_A, reservation.id);
  view = await h.inventory.availability(COMPANY_A, "v1", "loc-1");
  assert.equal(view.available, 5, "a second release must not restore stock twice");
});

test("an expired reservation returns its units, and commit after expiry fails but keeps the expiry", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  const reservation = await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 4, idempotencyKey: "r1", holderQuantity: 4, locationId: "loc-1", ttlMinutes: 1,
  });

  h.advanceMinutes(2);
  await assert.rejects(h.inventory.commit(COMPANY_A, reservation.id), /expired before it could be committed/);

  const view = await h.inventory.availability(COMPANY_A, "v1", "loc-1");
  assert.equal(view.reserved, 0);
  assert.equal(view.committed, 0);
  assert.equal(view.available, 5);
  assert.equal((await h.storage.getReservation(COMPANY_A, reservation.id)).status, "expired");
});

test("expiry sweep expires only due reservations", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 1, idempotencyKey: "due", holderQuantity: 1, locationId: "loc-1", ttlMinutes: 1,
  });
  await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-2", variantId: "v1", quantity: 1, idempotencyKey: "later", holderQuantity: 1, locationId: "loc-1", ttlMinutes: 30,
  });
  h.advanceMinutes(5);
  assert.equal(await h.inventory.expireDue(COMPANY_A), 1);
  assert.equal((await h.inventory.availability(COMPANY_A, "v1", "loc-1")).reserved, 1);
});

test("commit moves reserved units into committed and holds them against adjustments", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  const committed = await reserveAndCommit(h, COMPANY_A, 3);
  assert.equal(committed.status, "committed");

  const view = await h.inventory.availability(COMPANY_A, "v1", "loc-1");
  assert.equal(view.reserved, 0);
  assert.equal(view.committed, 3);
  assert.equal(view.available, 2);

  await assert.rejects(
    h.inventory.adjust(COMPANY_A, { variantId: "v1", delta: -3, reason: "shrink", locationId: "loc-1" }),
    /below reserved, committed, or damaged/,
  );
  const adjustment = await h.inventory.adjust(COMPANY_A, { variantId: "v1", delta: -2, reason: "shrink", locationId: "loc-1" });
  assert.equal(adjustment.balanceAfter, 3);
});

test("adjustments respect expected version and are idempotent per key", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  const before = await h.inventory.availability(COMPANY_A, "v1", "loc-1");

  await assert.rejects(
    h.inventory.adjust(COMPANY_A, { variantId: "v1", delta: 1, reason: "count", locationId: "loc-1", expectedVersion: before.version - 1 }),
    /Inventory changed after it was loaded/,
  );

  const first = await h.inventory.adjust(COMPANY_A, { variantId: "v1", delta: 1, reason: "count", locationId: "loc-1", idempotencyKey: "adj-1" });
  const replay = await h.inventory.adjust(COMPANY_A, { variantId: "v1", delta: 1, reason: "count", locationId: "loc-1", idempotencyKey: "adj-1" });
  assert.equal(replay.id, first.id);
  assert.equal((await h.inventory.availability(COMPANY_A, "v1", "loc-1")).quantity, 6);

  await assert.rejects(
    h.inventory.adjust(COMPANY_A, { variantId: "v1", delta: 2, reason: "count", locationId: "loc-1", idempotencyKey: "adj-1" }),
    (error) => error.status === 409,
  );
});

test("a physical fulfilment needs committed stock at its location, not just reserved stock", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await registerOrder(h, COMPANY_A, "order-1", 3);

  const reservation = await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 3, idempotencyKey: "r1", holderQuantity: 3, locationId: "loc-1",
  });
  await assert.rejects(
    h.fulfilment.create(COMPANY_A, {
      orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 3 }], idempotencyKey: "f0", locationId: "loc-1",
    }),
    /Only 0 committed unit\(s\)/,
  );

  await h.inventory.commit(COMPANY_A, reservation.id);
  const fulfilment = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 3 }], idempotencyKey: "f1", locationId: "loc-1",
  });
  assert.equal(fulfilment.status, "pending");
  assert.equal((await h.storage.getStock(COMPANY_A, "v1", "loc-1")).allocated, 3);
});

test("a fulfilment cannot exceed the committed units even when the order is larger", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await reserveAndCommit(h, COMPANY_A, 2);
  await registerOrder(h, COMPANY_A, "order-1", 3);

  await assert.rejects(
    h.fulfilment.create(COMPANY_A, {
      orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 3 }], idempotencyKey: "f1", locationId: "loc-1",
    }),
    /Only 2 committed unit\(s\) of variant v1/,
  );
});

test("partial fulfilment ships in stages, ships stock out, and reports the aggregate", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await reserveAndCommit(h, COMPANY_A, 5);
  await registerOrder(h, COMPANY_A, "order-1", 5);

  const first = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 2 }], idempotencyKey: "f1", locationId: "loc-1",
  });
  await h.fulfilment.markShipped(COMPANY_A, first.id, { carrier: "AusPost", trackingNumber: "TRK1" });

  let summary = await h.fulfilment.summaryForOrder(COMPANY_A, "order-1");
  assert.equal(summary.status, "partially_fulfilled");
  assert.equal(summary.fulfilledQuantity, 2);

  let stock = await h.storage.getStock(COMPANY_A, "v1", "loc-1");
  assert.equal(stock.quantity, 3, "shipped units leave the building");
  assert.equal(stock.committed, 3);
  assert.equal(stock.allocated, 0);

  const second = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 3 }], idempotencyKey: "f2", locationId: "loc-1",
  });
  await h.fulfilment.markShipped(COMPANY_A, second.id);
  summary = await h.fulfilment.summaryForOrder(COMPANY_A, "order-1");
  assert.equal(summary.status, "fulfilled");

  await h.fulfilment.markDelivered(COMPANY_A, first.id);
  summary = await h.fulfilment.summaryForOrder(COMPANY_A, "order-1");
  assert.equal(summary.status, "fulfilled", "one parcel delivered is not the whole order delivered");
  assert.equal(summary.deliveredQuantity, 2);

  await h.fulfilment.markDelivered(COMPANY_A, second.id);
  summary = await h.fulfilment.summaryForOrder(COMPANY_A, "order-1");
  assert.equal(summary.status, "delivered");
  assert.equal(summary.deliveredQuantity, 5);
});

test("a fulfilment cannot exceed what was ordered, and cancelling frees the quantity", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await reserveAndCommit(h, COMPANY_A, 3);
  await registerOrder(h, COMPANY_A, "order-1", 3);

  const first = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 2 }], idempotencyKey: "f1", locationId: "loc-1",
  });
  await assert.rejects(
    h.fulfilment.create(COMPANY_A, {
      orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 2 }], idempotencyKey: "f2", locationId: "loc-1",
    }),
    /Only 1 unit\(s\) remain unfulfilled for order line order-1-line/,
  );
  await assert.rejects(
    h.fulfilment.create(COMPANY_A, {
      orderId: "order-1",
      items: [{ orderLineId: "order-1-line", quantity: 2 }, { orderLineId: "order-1-line", quantity: 2 }],
      idempotencyKey: "f3",
      locationId: "loc-1",
    }),
    /Only 1 unit\(s\) remain unfulfilled for order line order-1-line/,
  );

  await h.fulfilment.cancel(COMPANY_A, first.id, "customer changed mind");
  assert.equal((await h.storage.getStock(COMPANY_A, "v1", "loc-1")).allocated, 0);

  const retry = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 3 }], idempotencyKey: "f4", locationId: "loc-1",
  });
  assert.equal(retry.status, "pending");
});

test("dispatch transitions follow the state machine", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await reserveAndCommit(h, COMPANY_A, 1);
  await registerOrder(h, COMPANY_A, "order-1", 1);
  const f = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 1 }], idempotencyKey: "f1", locationId: "loc-1",
  });

  await assert.rejects(h.fulfilment.markDelivered(COMPANY_A, f.id), /cannot transition from pending to delivered/);
  await h.fulfilment.markProcessing(COMPANY_A, f.id);
  await h.fulfilment.markShipped(COMPANY_A, f.id);
  await assert.rejects(h.fulfilment.cancel(COMPANY_A, f.id), /cannot transition from shipped to cancelled/);
  await h.fulfilment.markDelivered(COMPANY_A, f.id);
  await assert.rejects(h.fulfilment.markShipped(COMPANY_A, f.id, { trackingNumber: "X" }), /cannot transition from delivered to shipped/);
});

test("fulfilment creation is idempotent per key and rejects a changed request", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await reserveAndCommit(h, COMPANY_A, 2);
  await registerOrder(h, COMPANY_A, "order-1", 2);
  const input = { orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 1 }], idempotencyKey: "f1", locationId: "loc-1" };

  const first = await h.fulfilment.create(COMPANY_A, input);
  const replay = await h.fulfilment.create(COMPANY_A, input);
  assert.equal(replay.id, first.id);
  assert.equal((await h.storage.getStock(COMPANY_A, "v1", "loc-1")).allocated, 1, "a replay must not allocate twice");

  await assert.rejects(
    h.fulfilment.create(COMPANY_A, { ...input, items: [{ orderLineId: "order-1-line", quantity: 2 }] }),
    (error) => error.status === 409,
  );
});

test("physical fulfilments need a location, while digital fulfilments never touch stock", async () => {
  const h = harness();
  await registerOrder(h, COMPANY_A, "order-1", 1);
  await assert.rejects(
    h.fulfilment.create(COMPANY_A, { orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 1 }], idempotencyKey: "p1" }),
    /locationId is required/,
  );

  const digital = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 1 }], idempotencyKey: "d1", methodType: "digital",
  });
  const shipped = await h.fulfilment.markShipped(COMPANY_A, digital.id);
  assert.equal(shipped.status, "shipped");
  assert.equal(await h.storage.getStock(COMPANY_A, "v1", "loc-1"), null);
});

test("tracking can be required for delivery when the flag is set", async () => {
  const h = harness({ requireTrackingForDelivery: true });
  await receive(h, COMPANY_A, 5);
  await reserveAndCommit(h, COMPANY_A, 1);
  await registerOrder(h, COMPANY_A, "order-1", 1);
  const f = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 1 }], idempotencyKey: "f1", locationId: "loc-1",
  });

  await assert.rejects(h.fulfilment.markShipped(COMPANY_A, f.id), /A tracking number is required/);
  const shipped = await h.fulfilment.markShipped(COMPANY_A, f.id, { trackingNumber: "TRK9" });
  assert.equal(shipped.trackingNumber, "TRK9");
});

test("company isolation: one company cannot see, change or expire another company's stock and orders", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  await h.storage.saveLocation(COMPANY_B, { id: "loc-1", companyId: COMPANY_B, code: "loc-1", name: "B", active: true, priority: 100 });
  await registerOrder(h, COMPANY_A, "order-1", 1);
  await reserveAndCommit(h, COMPANY_A, 1, { key: "cart-committed" });
  const reservation = await h.inventory.reserve(COMPANY_A, {
    holderId: "cart-1", variantId: "v1", quantity: 2, idempotencyKey: "rA", holderQuantity: 2, locationId: "loc-1", ttlMinutes: 1,
  });
  const fulfilment = await h.fulfilment.create(COMPANY_A, {
    orderId: "order-1", items: [{ orderLineId: "order-1-line", quantity: 1 }], idempotencyKey: "fA", locationId: "loc-1",
  });

  // Same variant id and location id, different company: stock is separate.
  const bView = await h.inventory.availability(COMPANY_B, "v1", "loc-1");
  assert.equal(bView.quantity, 0);
  await assert.rejects(
    h.inventory.reserve(COMPANY_B, {
      holderId: "cart-b", variantId: "v1", quantity: 1, idempotencyKey: "rB", holderQuantity: 1, locationId: "loc-1",
    }),
    /Only 0 unit\(s\) are currently available/,
  );

  // Another company's ids are not found, rather than leaking or mutating the row.
  await assert.rejects(h.inventory.release(COMPANY_B, reservation.id), (error) => error.status === 404);
  await assert.rejects(h.fulfilment.summaryForOrder(COMPANY_B, "order-1"), (error) => error.status === 404);
  await assert.rejects(h.fulfilment.get(COMPANY_B, fulfilment.id), (error) => error.status === 404);
  await assert.rejects(h.fulfilment.markShipped(COMPANY_B, fulfilment.id), (error) => error.status === 404);
  assert.equal((await h.storage.getReservation(COMPANY_A, reservation.id)).status, "active");
  assert.equal((await h.fulfilment.get(COMPANY_A, fulfilment.id)).status, "pending");

  // Expiry sweep for B does not touch A's due reservation.
  h.advanceMinutes(2);
  assert.equal(await h.inventory.expireDue(COMPANY_B), 0);
  assert.equal((await h.storage.getReservation(COMPANY_A, reservation.id)).status, "active");

  // An idempotency key is scoped to its company: B's request with A's key creates B's own record.
  await h.storage.saveLocation(COMPANY_B, { id: "loc-1", companyId: COMPANY_B, code: "loc-1", name: "B", active: true, priority: 100 });
  await h.fulfilment.registerOrder(COMPANY_B, { id: "order-1", lines: [{ id: "b-line", variantId: "v1", name: "B", quantity: 1 }] });
  await assert.rejects(
    h.fulfilment.create(COMPANY_B, {
      orderId: "order-1", items: [{ orderLineId: "b-line", quantity: 1 }], idempotencyKey: "fA", locationId: "loc-1",
    }),
    /Only 0 committed unit\(s\)/,
  );

  // A missing or malformed tenant fails closed.
  await assert.rejects(h.inventory.availability("not-a-uuid", "v1", "loc-1"), (error) => error.status === 403);
});

test("a transaction that throws rolls back every write it made", async () => {
  const h = harness();
  await receive(h, COMPANY_A, 5);
  const before = await h.storage.getStock(COMPANY_A, "v1", "loc-1");

  await assert.rejects(
    h.storage.transaction(COMPANY_A, async (tx) => {
      await tx.saveStock(COMPANY_A, { ...before, quantity: 999 });
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await h.storage.getStock(COMPANY_A, "v1", "loc-1")).quantity, 5);
});
