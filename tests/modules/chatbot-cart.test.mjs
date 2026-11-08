// Cart and checkout slice tests (node:test). No database, no Express, no node_modules.
// Covers the conversation-scoped cart, integer-cent totals, quantity bounds, checkout submission with
// idempotency keys, the per-conversation and per-customer spend limit, closed-state rules, and company isolation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CartError,
  createCartModule,
  createMemoryCartCatalog,
  createMemoryCartStorage,
  computeTotals,
  evaluateSpendLimit,
  lineTotalMinor,
} from "../../server/modules/chatbot/cart/index.ts";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";

// ---------- fixtures ----------

const COMPANY_A = "5b1d2c1e-7a3f-4c8e-9f10-1a2b3c4d5e6f";
const COMPANY_B = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const TEE = { variantId: "var-tee", productId: "prod-tee", chatbotId: "bot-1", sku: "TEE-M", name: "Tee", currency: "AUD", unitPriceMinor: 1999, active: true };
const MUG = { variantId: "var-mug", productId: "prod-mug", chatbotId: "bot-1", sku: "MUG", name: "Mug", currency: "AUD", unitPriceMinor: 501, active: true };
const CAP_USD = { variantId: "var-cap", productId: "prod-cap", chatbotId: "bot-1", sku: "CAP", name: "Cap", currency: "USD", unitPriceMinor: 1200, active: true };
const RETIRED = { variantId: "var-old", productId: "prod-old", chatbotId: "bot-1", sku: "OLD", name: "Old", currency: "AUD", unitPriceMinor: 900, active: false };
const OTHER_BOT = { variantId: "var-other", productId: "prod-other", chatbotId: "bot-2", sku: "OTH", name: "Other", currency: "AUD", unitPriceMinor: 700, active: true };

const START = new Date("2026-11-08T09:00:00Z");

function setup({ enabled = true } = {}) {
  const storage = createMemoryCartStorage();
  const catalog = createMemoryCartCatalog();
  for (const variant of [TEE, MUG, CAP_USD, RETIRED, OTHER_BOT]) {
    catalog.add(COMPANY_A, variant);
  }
  catalog.add(COMPANY_B, TEE);
  const clock = { at: START };
  const mod = createCartModule({ storage, catalog, enabled, now: () => clock.at });
  return { mod, storage, catalog, clock };
}

const scope = (overrides = {}) => ({
  companyId: COMPANY_A,
  chatbotId: "bot-1",
  conversationId: "conv-1",
  ...overrides,
});

/** Builds a cart holding three tees and one mug: 3 * 1999 + 501 = 6498 minor units. */
async function filledCart(mod, ctx = scope()) {
  const cart = await mod.carts.getOrCreateCart(ctx);
  await mod.carts.addLine(ctx.companyId, cart.id, { variantId: "var-tee", quantity: 3 });
  return mod.carts.addLine(ctx.companyId, cart.id, { variantId: "var-mug", quantity: 1 });
}

async function openWithContact(mod, cartId, companyId = COMPANY_A) {
  const checkout = await mod.checkouts.openCheckout(companyId, cartId);
  return mod.checkouts.updateContact(companyId, checkout.id, { email: "buyer@example.com", name: "Buyer" });
}

const isCode = (code) => (error) => error instanceof CartError && error.code === code;

// ---------- feature flag ----------

test("the cart and checkout feature is off by default and every entry point refuses", async () => {
  const storage = createMemoryCartStorage();
  const catalog = createMemoryCartCatalog();
  const mod = createCartModule({ storage, catalog });

  assert.equal(mod.enabled, false);
  await assert.rejects(mod.carts.getOrCreateCart(scope()), (error) => error.code === "feature_disabled" && error.status === 404);
  await assert.rejects(mod.checkouts.openCheckout(COMPANY_A, "cart-x"), isCode("feature_disabled"));
});

// ---------- quantity ----------

test("quantity cannot go below 1", async () => {
  const { mod } = setup();
  const cart = await mod.carts.getOrCreateCart(scope());

  for (const quantity of [0, -1, 1.5, 1000, Number.NaN]) {
    await assert.rejects(
      mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity }),
      isCode("validation"),
      `addLine should reject quantity ${quantity}`,
    );
  }

  const added = await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 2 });
  const lineKey = added.lines[0].lineKey;

  await assert.rejects(mod.carts.setLineQuantity(COMPANY_A, cart.id, lineKey, 0), isCode("validation"));
  await assert.rejects(mod.carts.setLineQuantity(COMPANY_A, cart.id, lineKey, -3), isCode("validation"));

  const reduced = await mod.carts.setLineQuantity(COMPANY_A, cart.id, lineKey, 1);
  assert.equal(reduced.lines[0].quantity, 1, "a quantity of exactly 1 is allowed");

  const removed = await mod.carts.removeLine(COMPANY_A, cart.id, lineKey);
  assert.equal(removed.lines.length, 0, "removal is a separate operation, not quantity 0");
});

test("quantity cannot exceed 999 even when repeat adds merge into one line", async () => {
  const { mod } = setup();
  const cart = await mod.carts.getOrCreateCart(scope());
  const full = await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 999 });
  assert.equal(full.lines[0].quantity, 999);

  await assert.rejects(mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 1 }), isCode("validation"));

  const after = await mod.carts.getCart(COMPANY_A, cart.id);
  assert.equal(after.version, full.version, "a rejected add leaves the cart unchanged");
  assert.equal(after.lines[0].quantity, 999);
});

// ---------- totals ----------

test("totals are integer cents", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);

  assert.equal(cart.subtotalMinor, 3 * 1999 + 501);
  assert.equal(cart.totalMinor, 6498, "6498 cents, i.e. 64.98 AUD");
  assert.ok(Number.isInteger(cart.subtotalMinor) && Number.isInteger(cart.totalMinor));
  assert.deepEqual(cart.lines.map((line) => line.lineTotalMinor), [5997, 501]);
  assert.equal(cart.currency, "AUD");
});

test("money helpers keep integer cents and clamp discounts to the subtotal", () => {
  const totals = computeTotals([
    { quantity: 3, unitPriceMinor: 1999 },
    { quantity: 1, unitPriceMinor: 501 },
  ]);
  assert.deepEqual(totals, { itemCount: 4, subtotalMinor: 6498, discountMinor: 0, totalMinor: 6498 });

  const clamped = computeTotals([{ quantity: 1, unitPriceMinor: 500 }], 10_000);
  assert.equal(clamped.discountMinor, 500, "a discount larger than the subtotal is clamped");
  assert.equal(clamped.totalMinor, 0);

  assert.equal(lineTotalMinor(1999, 3), 5997);
  assert.throws(() => lineTotalMinor(12.5, 1), isCode("validation"), "a fractional price is rejected, not rounded");
});

test("updating, removing and clearing recompute totals", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);
  const teeKey = cart.lines[0].lineKey;

  const updated = await mod.carts.setLineQuantity(COMPANY_A, cart.id, teeKey, 2);
  assert.equal(updated.subtotalMinor, 2 * 1999 + 501);
  assert.equal(updated.lines[0].lineTotalMinor, 3998);

  const removed = await mod.carts.removeLine(COMPANY_A, cart.id, teeKey);
  assert.equal(removed.totalMinor, 501);

  const cleared = await mod.carts.clear(COMPANY_A, cart.id);
  assert.equal(cleared.totalMinor, 0);
  assert.equal(cleared.lines.length, 0);
  assert.equal(cleared.currency, "AUD", "clearing keeps the currency the cart was started in");
});

test("the same cart idempotency key replays once and rejects a different body", async () => {
  const { mod } = setup();
  const cart = await mod.carts.getOrCreateCart(scope());
  const first = await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 2 }, "add-1");
  const replay = await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 2 }, "add-1");

  assert.equal(replay.lines[0].quantity, 2, "the replayed add is not applied twice");
  assert.equal(replay.version, first.version);

  await assert.rejects(
    mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 5 }, "add-1"),
    isCode("idempotency_conflict"),
  );
});

// ---------- cart scope and catalog ----------

test("the cart is conversation-scoped and rejects unavailable or mixed-currency variants", async () => {
  const { mod } = setup();
  const first = await mod.carts.getOrCreateCart(scope());
  const same = await mod.carts.getOrCreateCart(scope());
  const other = await mod.carts.getOrCreateCart(scope({ conversationId: "conv-2" }));

  assert.equal(same.id, first.id, "one active cart per conversation");
  assert.notEqual(other.id, first.id, "a second conversation gets its own cart");

  await mod.carts.addLine(COMPANY_A, first.id, { variantId: "var-tee" });
  await assert.rejects(mod.carts.addLine(COMPANY_A, first.id, { variantId: "var-cap" }), isCode("currency_mismatch"));
  await assert.rejects(mod.carts.addLine(COMPANY_A, first.id, { variantId: "var-old" }), isCode("variant_unavailable"));
  await assert.rejects(mod.carts.addLine(COMPANY_A, first.id, { variantId: "var-other" }), isCode("variant_unavailable"));
  await assert.rejects(mod.carts.addLine(COMPANY_A, first.id, { variantId: "var-missing" }), isCode("variant_unavailable"));
});

// ---------- checkout ----------

test("opening a checkout twice returns the same open checkout", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);
  const first = await mod.checkouts.openCheckout(COMPANY_A, cart.id);
  const second = await mod.checkouts.openCheckout(COMPANY_A, cart.id);
  assert.equal(second.id, first.id);
  assert.equal(second.status, "open");
});

test("an empty cart cannot be checked out, and a missing contact blocks submission", async () => {
  const { mod } = setup();
  const empty = await mod.carts.getOrCreateCart(scope());
  await assert.rejects(mod.checkouts.openCheckout(COMPANY_A, empty.id), isCode("empty_cart"));

  const cart = await filledCart(mod);
  const checkout = await mod.checkouts.openCheckout(COMPANY_A, cart.id);
  await assert.rejects(mod.checkouts.updateContact(COMPANY_A, checkout.id, {}), isCode("contact_required"));
  await assert.rejects(mod.checkouts.updateContact(COMPANY_A, checkout.id, { email: "not-an-email" }), isCode("validation"));
  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "no-contact" }),
    isCode("contact_required"),
  );
});

test("duplicate checkout submission with the same idempotency key returns the same result", async () => {
  const { mod, storage } = setup();
  const cart = await filledCart(mod);
  const checkout = await openWithContact(mod, cart.id);

  const first = await mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "submit-1" });
  const second = await mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "submit-1" });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.checkout.id, first.checkout.id);
  assert.deepEqual(second.orderRequest, first.orderRequest, "the replay returns the stored order request");
  assert.equal(first.checkout.status, "submitted");
  assert.equal(first.orderRequest.idempotencyKey, `checkout:${checkout.id}`);
  assert.equal(first.orderRequest.totalMinor, 6498);
  assert.equal(first.orderRequest.lines.length, 2);

  const stored = await storage.getCart(COMPANY_A, cart.id);
  assert.equal(stored.status, "converted", "a submitted checkout freezes its cart");

  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "submit-1", expectedCartVersion: 99 }),
    isCode("idempotency_conflict"),
    "a reused key with a different body is refused",
  );
});

test("concurrent duplicate submissions with the same key create one order request", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);
  const checkout = await openWithContact(mod, cart.id);

  const [a, b] = await Promise.all([
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "race" }),
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "race" }),
  ]);

  assert.deepEqual(a.orderRequest, b.orderRequest);
  assert.equal([a.replayed, b.replayed].filter(Boolean).length, 1, "exactly one call did the work");
});

test("a stale cart version blocks submission and leaves the checkout open", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);
  const checkout = await openWithContact(mod, cart.id);
  const staleVersion = cart.version;

  await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-mug", quantity: 1 });

  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "stale", expectedCartVersion: staleVersion }),
    isCode("cart_version_mismatch"),
  );
  const still = await mod.checkouts.getCheckout(COMPANY_A, checkout.id);
  assert.equal(still.status, "open");

  const fresh = await mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "fresh", expectedCartVersion: staleVersion + 1 });
  assert.equal(fresh.orderRequest.totalMinor, 6498 + 501, "the submitted total reflects the latest cart");
});

// ---------- spend limit ----------

test("spend limit blocks an over-limit checkout and allows it once the cap is raised", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);
  const checkout = await openWithContact(mod, cart.id);

  await mod.checkouts.setSpendLimit(COMPANY_A, {
    scopeType: "conversation",
    scopeId: "conv-1",
    currency: "AUD",
    maxOrderMinor: 5000,
  });

  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "blocked" }),
    (error) => error.code === "spend_limit_exceeded" && /max order value/.test(error.message),
  );
  assert.equal((await mod.checkouts.getCheckout(COMPANY_A, checkout.id)).status, "open");
  assert.equal((await mod.carts.getCart(COMPANY_A, cart.id)).status, "active", "a blocked submit does not freeze the cart");

  await mod.checkouts.setSpendLimit(COMPANY_A, {
    scopeType: "conversation",
    scopeId: "conv-1",
    currency: "AUD",
    maxOrderMinor: 7000,
  });
  const allowed = await mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "blocked" });
  assert.equal(allowed.replayed, false, "the earlier blocked attempt was not recorded, so the same key now works");
});

test("a per-customer daily limit accumulates across conversations and resets on a new day", async () => {
  const { mod, clock } = setup();
  await mod.checkouts.setSpendLimit(COMPANY_A, {
    scopeType: "customer",
    scopeId: "cust-1",
    currency: "AUD",
    dailyLimitMinor: 10_000,
  });

  const first = await filledCart(mod, scope({ conversationId: "conv-1", customerId: "cust-1" }));
  const firstCheckout = await openWithContact(mod, first.id);
  await mod.checkouts.submitCheckout(COMPANY_A, firstCheckout.id, { idempotencyKey: "d1" });

  const second = await filledCart(mod, scope({ conversationId: "conv-2", customerId: "cust-1" }));
  const secondCheckout = await openWithContact(mod, second.id);
  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, secondCheckout.id, { idempotencyKey: "d2" }),
    (error) => error.code === "spend_limit_exceeded" && /daily spend limit/.test(error.message),
  );

  // The earlier checkout has passed its 30 minute TTL, so the next day starts with a fresh checkout.
  clock.at = new Date("2026-11-09T09:00:00Z");
  const reopened = await openWithContact(mod, second.id);
  assert.notEqual(reopened.id, secondCheckout.id, "the stale checkout was replaced");
  const nextDay = await mod.checkouts.submitCheckout(COMPANY_A, reopened.id, { idempotencyKey: "d2" });
  assert.equal(nextDay.checkout.status, "submitted", "the daily total starts again on a new UTC day");
});

test("evaluateSpendLimit blocks a currency mismatch before checking any cap", () => {
  const decision = evaluateSpendLimit(100, "USD", { currency: "AUD", maxOrderMinor: null, dailyLimitMinor: null, spentTodayMinor: 0 });
  assert.deepEqual(decision, { allowed: false, reason: "currency_mismatch", remainingDailyMinor: null });
});

// ---------- closed states ----------

test("a closed checkout cannot be edited, and its cart cannot be changed after submission", async () => {
  const { mod } = setup();
  const cart = await filledCart(mod);
  const checkout = await openWithContact(mod, cart.id);
  await mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "closed-1" });

  await assert.rejects(
    mod.checkouts.updateContact(COMPANY_A, checkout.id, { email: "changed@example.com" }),
    isCode("checkout_closed"),
  );
  await assert.rejects(mod.checkouts.cancelCheckout(COMPANY_A, checkout.id), isCode("checkout_closed"));
  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "closed-2" }),
    isCode("checkout_closed"),
    "a new key on a submitted checkout is refused",
  );
  await assert.rejects(mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-mug" }), isCode("cart_closed"));

  const cancelled = await mod.checkouts.openCheckout(COMPANY_A, (await filledCart(mod, scope({ conversationId: "conv-3" }))).id);
  await mod.checkouts.cancelCheckout(COMPANY_A, cancelled.id);
  await assert.rejects(
    mod.checkouts.updateContact(COMPANY_A, cancelled.id, { email: "late@example.com" }),
    isCode("checkout_closed"),
    "a cancelled checkout cannot be edited either",
  );
});

test("an open checkout expires after its TTL and then refuses edits", async () => {
  const { mod, clock } = setup();
  const cart = await filledCart(mod);
  const checkout = await openWithContact(mod, cart.id);

  clock.at = new Date(START.getTime() + 31 * 60 * 1000);

  await assert.rejects(mod.checkouts.updateContact(COMPANY_A, checkout.id, { email: "late@example.com" }), isCode("checkout_expired"));
  const stored = await mod.checkouts.getCheckout(COMPANY_A, checkout.id);
  assert.equal(stored.status, "expired", "the expiry is persisted, not only reported");
  await assert.rejects(
    mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "late" }),
    isCode("checkout_closed"),
  );
});

// ---------- company isolation ----------

test("company isolation: one tenant cannot read, change or be limited by another tenant's rows", async () => {
  const { mod, storage } = setup();
  const cartA = await filledCart(mod, scope({ conversationId: "conv-iso" }));
  const checkoutA = await openWithContact(mod, cartA.id);
  await mod.checkouts.setSpendLimit(COMPANY_A, { scopeType: "conversation", scopeId: "conv-iso", currency: "AUD", maxOrderMinor: 1000 });

  // Company B gets its own cart for the same conversation id.
  const cartB = await mod.carts.getOrCreateCart(scope({ companyId: COMPANY_B, conversationId: "conv-iso" }));
  assert.notEqual(cartB.id, cartA.id);
  assert.equal(cartB.companyId, COMPANY_B);
  assert.equal(cartB.lines.length, 0);

  // Company B cannot reach company A's rows by id.
  await assert.rejects(mod.carts.getCart(COMPANY_B, cartA.id), isCode("not_found"));
  await assert.rejects(mod.carts.addLine(COMPANY_B, cartA.id, { variantId: "var-tee" }), isCode("not_found"));
  await assert.rejects(mod.carts.clear(COMPANY_B, cartA.id), isCode("not_found"));
  await assert.rejects(mod.checkouts.openCheckout(COMPANY_B, cartA.id), isCode("not_found"));
  await assert.rejects(mod.checkouts.getCheckout(COMPANY_B, checkoutA.id), isCode("not_found"));
  await assert.rejects(mod.checkouts.updateContact(COMPANY_B, checkoutA.id, { email: "x@example.com" }), isCode("not_found"));
  await assert.rejects(mod.checkouts.submitCheckout(COMPANY_B, checkoutA.id, { idempotencyKey: "steal" }), isCode("not_found"));
  await assert.rejects(mod.checkouts.cancelCheckout(COMPANY_B, checkoutA.id), isCode("not_found"));

  // Storage itself refuses to cross the tenant line.
  assert.equal(await storage.getCart(COMPANY_B, cartA.id), null);
  assert.equal((await storage.findActiveCart(COMPANY_B, "conv-iso")).id, cartB.id);

  // Company A's untouched rows are unchanged by the failed attempts.
  const aAfter = await mod.carts.getCart(COMPANY_A, cartA.id);
  assert.equal(aAfter.status, "active");
  assert.equal(aAfter.lines.length, 2);
  assert.equal((await mod.checkouts.getCheckout(COMPANY_A, checkoutA.id)).status, "open");

  // A's conversation cap does not apply to B's checkout of the same conversation id.
  const bCart = await mod.carts.addLine(COMPANY_B, cartB.id, { variantId: "var-tee", quantity: 2 });
  const bCheckout = await mod.checkouts.openCheckout(COMPANY_B, bCart.id);
  await mod.checkouts.updateContact(COMPANY_B, bCheckout.id, { phone: "+61 400 000 000" });
  const bResult = await mod.checkouts.submitCheckout(COMPANY_B, bCheckout.id, { idempotencyKey: "b-1" });
  assert.equal(bResult.checkout.status, "submitted");
  assert.equal(bResult.orderRequest.companyId, COMPANY_B);

  // Requests without a company scope fail closed.
  await assert.rejects(mod.carts.getCart("not-a-company", cartA.id), (error) => error instanceof ChatbotError && error.status === 403);
});

// ---------- transactions (integration fix 3) ----------

/** Wraps the memory storage and counts transaction() calls, so each mutation can be seen to open one. */
function countingStorage() {
  const inner = createMemoryCartStorage();
  const counter = { transactions: 0 };
  const storage = {
    ...inner,
    transaction(companyId, fn) {
      counter.transactions += 1;
      return inner.transaction(companyId, fn);
    },
  };
  return { storage, counter };
}

test("every cart and checkout mutation runs inside storage.transaction()", async () => {
  const { storage, counter } = countingStorage();
  const catalog = createMemoryCartCatalog();
  for (const variant of [TEE, MUG]) catalog.add(COMPANY_A, variant);
  const clock = { at: START };
  const mod = createCartModule({ storage, catalog, enabled: true, now: () => clock.at });

  const cart = await mod.carts.getOrCreateCart(scope());
  const afterCreate = counter.transactions;
  assert.equal(afterCreate, 1, "getOrCreateCart opens one transaction");

  const added = await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-tee", quantity: 1 });
  const line = added.lines[0];
  assert.equal(counter.transactions, afterCreate + 1, "addLine opens one transaction");
  await mod.carts.setLineQuantity(COMPANY_A, cart.id, line.lineKey, 2);
  await mod.carts.removeLine(COMPANY_A, cart.id, line.lineKey);
  await mod.carts.clear(COMPANY_A, cart.id);
  assert.equal(counter.transactions, afterCreate + 4, "setLineQuantity, removeLine and clear each open one transaction");

  const before = counter.transactions;
  await mod.carts.addLine(COMPANY_A, cart.id, { variantId: "var-mug", quantity: 1 });
  const checkout = await mod.checkouts.openCheckout(COMPANY_A, cart.id);
  await mod.checkouts.updateContact(COMPANY_A, checkout.id, { email: "buyer@example.com" });
  await mod.checkouts.submitCheckout(COMPANY_A, checkout.id, { idempotencyKey: "tx-check" });
  assert.equal(counter.transactions, before + 4, "addLine, openCheckout, updateContact and submitCheckout each open one transaction");
});

test("an expired checkout is still marked expired when the refusal is returned", async () => {
  const { mod, storage, clock } = setup();
  const cart = await filledCart(mod);
  const checkout = await mod.checkouts.openCheckout(COMPANY_A, cart.id);
  clock.at = new Date(START.getTime() + 31 * 60 * 1000);
  await assert.rejects(mod.checkouts.updateContact(COMPANY_A, checkout.id, { email: "late@example.com" }), isCode("checkout_expired"));
  const stored = await storage.getCheckout(COMPANY_A, checkout.id);
  assert.equal(stored.status, "expired", "the expiry write must survive the refusal, as it did before the transaction was added");
});
