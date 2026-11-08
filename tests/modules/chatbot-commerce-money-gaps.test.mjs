// Commerce money gaps: coupons, tax exemptions, BNPL cancel and webhook, recurring rental, and the money Drizzle store.
// No network. Providers are in-process fakes that throw if the HTTP client is ever used. The Drizzle cases run only
// when MONEY_GAPS_DATABASE_URL points at a scratch Postgres that has 0101_commerce_money.sql and the gap draft applied.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-commerce-money-gaps.test.mjs
import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as M from "../../server/modules/chatbot/commerce/money/index.ts";
import {
  createDrizzleBnplLifecycleStorage,
  createDrizzleCouponStorage,
  createDrizzleHireStorage,
  createDrizzlePaymentStorage,
  createDrizzleRecurringStorage,
  createDrizzleTaxExemptionStorage,
} from "../../server/modules/chatbot/commerce/money/drizzle-store.ts";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-09T00:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const FLAGS = {
  [CONTRACT_FLAGS.BNPL_ENABLED]: "true",
  [CONTRACT_FLAGS.RENTAL_HIRE_ENABLED]: "true",
};
const DB_URL = process.env.MONEY_GAPS_DATABASE_URL;
const dbTest = DB_URL ? test : test.skip;

/** HTTP client for tests that must never reach the network. */
const noNetwork = async () => {
  throw new Error("network call attempted");
};

const USAGE_LIMIT = "The coupon usage limit has been reached.";
const CUSTOMER_LIMIT = "The coupon usage limit for this customer has been reached.";

async function refused(promise, message) {
  await assert.rejects(
    promise,
    (error) => error instanceof M.MoneyError && error.code === "validation" && error.message === message,
    `expected refusal: ${message}`,
  );
}

async function refusedWith(promise, code) {
  await assert.rejects(promise, (error) => error instanceof M.MoneyError && error.code === code, `expected MoneyError ${code}`);
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

const LINES = [{ lineKey: "l1", productId: "p1", variantId: "v1", categoryId: "c1", amountMinor: 999 }];

function couponFixture() {
  const clock = { now: NOW };
  const storage = M.createMemoryCouponStorage();
  const service = M.createCouponService({ storage, now: () => clock.now, reservationTtlMinutes: 30 });
  return { clock, storage, service };
}

function quoteInput(overrides = {}) {
  return {
    companyId: COMPANY_A,
    code: "SAVE10",
    lines: LINES,
    subtotalMinor: 999,
    shippingMinor: 500,
    currency: "AUD",
    channel: "web",
    customerRef: "cust-a",
    completedOrderCount: 0,
    cartId: null,
    ...overrides,
  };
}

async function seedCoupon(storage, code, fields, companyId = COMPANY_A) {
  const record = M.buildCouponRecord(companyId, `cpn-${code}`, { code, ...fields });
  assert.equal(await storage.insertCoupon(record), true);
  return record;
}

test("a coupon past its usage limit is refused, and a redeemed use still counts", async () => {
  const { storage, service } = couponFixture();
  await seedCoupon(storage, "SAVE10", { type: "percentage", value: 1000, usageLimit: 1 });

  const first = await service.reserve(quoteInput({ cartId: "cart-1", customerRef: "cust-a" }));
  assert.equal(first.quote.discountMinor, 100, "10 percent of 999 cents is 100 cents");

  await refused(service.reserve(quoteInput({ cartId: "cart-2", customerRef: "cust-b" })), USAGE_LIMIT);
  await refused(service.quote(quoteInput({ cartId: "cart-2", customerRef: "cust-b" })), USAGE_LIMIT);

  assert.equal(await service.redeemCart(COMPANY_A, "cart-1"), 1);
  await refused(service.reserve(quoteInput({ cartId: "cart-3", customerRef: "cust-c" })), USAGE_LIMIT);

  const again = await service.reserve(quoteInput({ cartId: "cart-1", customerRef: "cust-a" }));
  assert.equal(again.usage.status, "redeemed", "a cart's own redeemed use is not counted against itself");
});

test("a per-customer limit refuses that customer only", async () => {
  const { storage, service } = couponFixture();
  await seedCoupon(storage, "ONCE", { type: "fixed", value: 200, usageLimitPerCustomer: 1 });

  await service.reserve(quoteInput({ code: "ONCE", cartId: "cart-1", customerRef: "cust-a" }));
  await refused(service.reserve(quoteInput({ code: "ONCE", cartId: "cart-2", customerRef: "cust-a" })), CUSTOMER_LIMIT);
  const other = await service.reserve(quoteInput({ code: "ONCE", cartId: "cart-3", customerRef: "cust-b" }));
  assert.equal(other.quote.discountMinor, 200);
});

test("an expired reservation no longer counts toward the limit", async () => {
  const { clock, storage, service } = couponFixture();
  await seedCoupon(storage, "LIMIT1", { type: "fixed", value: 100, usageLimit: 1 });

  await service.reserve(quoteInput({ code: "LIMIT1", cartId: "cart-1" }));
  clock.now = new Date(NOW.getTime() + 31 * 60_000);
  const second = await service.reserve(quoteInput({ code: "LIMIT1", cartId: "cart-2", customerRef: "cust-b" }));
  assert.equal(second.usage.status, "reserved");
  assert.equal(await service.expireDue(COMPANY_A), 1, "the first reservation is marked expired");
});

test("percentage, fixed, cap and free-shipping maths stay in whole cents", async () => {
  const { storage, service } = couponFixture();
  await seedCoupon(storage, "PCT", { type: "percentage", value: 1000 });
  await seedCoupon(storage, "FIX", { type: "fixed", value: 5000 });
  await seedCoupon(storage, "CAP", { type: "percentage", value: 1500, maxDiscountMinor: 150 });
  await seedCoupon(storage, "SHIP", { type: "free_shipping", value: 0 });

  const pct = await service.quote(quoteInput({ code: "PCT" }));
  assert.equal(pct.discountMinor, 100);
  assert.equal([...pct.lineShares.values()].reduce((sum, value) => sum + value, 0), 100, "line shares add up to the discount");

  const fix = await service.quote(quoteInput({ code: "FIX" }));
  assert.equal(fix.discountMinor, 999, "a fixed discount never exceeds the eligible total");

  const cap = await service.quote(quoteInput({ code: "CAP", lines: [{ ...LINES[0], amountMinor: 1000 }], subtotalMinor: 1000 }));
  assert.equal(cap.discountMinor, 150, "15 percent of 1000 is capped at 150");

  const ship = await service.quote(quoteInput({ code: "SHIP" }));
  assert.equal(ship.discountMinor, 0);
  assert.equal(ship.shippingDiscountMinor, 500, "free shipping takes off the whole shipping amount");
});

test("window, currency, channel, minimum, first-order and product scope are each refused", async () => {
  const { clock, storage, service } = couponFixture();
  await seedCoupon(storage, "LATER", { type: "fixed", value: 100, startsAt: new Date(NOW.getTime() + 86_400_000) });
  await seedCoupon(storage, "MIN", { type: "fixed", value: 100, minimumMinor: 2000 });
  await seedCoupon(storage, "AUD", { type: "fixed", value: 100, currency: "AUD" });
  await seedCoupon(storage, "WEB", { type: "fixed", value: 100, channels: ["web"] });
  await seedCoupon(storage, "NEW", { type: "fixed", value: 100, firstOrderOnly: true });
  await seedCoupon(storage, "PROD", { type: "fixed", value: 100, appliesTo: "products", targetIds: ["p9"] });

  await refused(service.quote(quoteInput({ code: "LATER" })), "The coupon is invalid or unavailable.");
  await refused(service.quote(quoteInput({ code: "MIN" })), "The coupon minimum purchase has not been met.");
  await refused(service.quote(quoteInput({ code: "AUD", currency: "USD" })), "The coupon is not valid for this currency.");
  await refused(service.quote(quoteInput({ code: "WEB", channel: "whatsapp" })), "The coupon is not valid on this channel.");
  await refused(service.quote(quoteInput({ code: "NEW", completedOrderCount: 1 })), "The coupon is limited to a customer’s first order.");
  await refused(service.quote(quoteInput({ code: "PROD" })), "The coupon does not apply to the products in this cart.");

  clock.now = new Date(NOW.getTime() + 86_400_000);
  assert.equal((await service.quote(quoteInput({ code: "LATER" }))).discountMinor, 100, "the window opens on its start date");
});

test("a coupon from another company is absent", async () => {
  const { storage, service } = couponFixture();
  await seedCoupon(storage, "SAVE10", { type: "percentage", value: 1000 }, COMPANY_A);
  await refused(service.quote(quoteInput({ companyId: COMPANY_B })), "The coupon is invalid or unavailable.");
});

test("a blank code gives no coupon and no reservation", async () => {
  const { service } = couponFixture();
  assert.equal(await service.quote(quoteInput({ code: "   " })), null);
  assert.equal(await service.reserve(quoteInput({ code: null, cartId: "cart-1" })), null);
});

// ---------------------------------------------------------------------------
// Tax exemptions
// ---------------------------------------------------------------------------

test("a customer-bound exemption applies to that customer only", async () => {
  const storage = M.createMemoryTaxExemptionStorage();
  await storage.insert(M.buildTaxExemption(COMPANY_A, "tx-1", { customerRef: "cust-a" }, NOW));

  const a = await M.resolveTaxExemption(storage, COMPANY_A, { exemptionKey: null, customerRef: "cust-a" }, NOW);
  assert.equal(a.wholeOrder, true);
  assert.equal(a.taxClassExempt("default"), true);
  assert.equal(a.shippingExempt(), true);

  const b = await M.resolveTaxExemption(storage, COMPANY_A, { exemptionKey: null, customerRef: "cust-b" }, NOW);
  assert.equal(b.wholeOrder, false, "another customer pays tax");
  assert.equal(b.taxClassExempt("default"), false);

  const keyOnly = await M.resolveTaxExemption(storage, COMPANY_A, { exemptionKey: "CERT-1", customerRef: null }, NOW);
  assert.equal(keyOnly.wholeOrder, false, "the customer binding does not exempt a request that carries only a key");

  const otherCompany = await M.resolveTaxExemption(storage, COMPANY_B, { exemptionKey: null, customerRef: "cust-a" }, NOW);
  assert.equal(otherCompany.wholeOrder, false, "another company's exemption is absent");
});

test("a class exemption covers only that class, and expired or deactivated records do not apply", async () => {
  const storage = M.createMemoryTaxExemptionStorage();
  await storage.insert(M.buildTaxExemption(COMPANY_A, "tx-ship", { exemptionKey: "CERT-9", taxClass: "shipping" }, NOW));
  await storage.insert(M.buildTaxExemption(COMPANY_A, "tx-old", { exemptionKey: "CERT-9", endsAt: new Date(NOW.getTime() - 86_400_000) }, NOW));

  const subject = { exemptionKey: "CERT-9", customerRef: null };
  const decision = await M.resolveTaxExemption(storage, COMPANY_A, subject, NOW);
  assert.equal(decision.wholeOrder, false, "the expired whole-order record is ignored");
  assert.equal(decision.shippingExempt(), true);
  assert.equal(decision.taxClassExempt("default"), false);

  await storage.deactivate(COMPANY_A, "tx-ship", NOW);
  const after = await M.resolveTaxExemption(storage, COMPANY_A, subject, NOW);
  assert.equal(after.shippingExempt(), false, "a deactivated record stops applying");
});

test("an exemption decision changes the order tax: the exempt customer pays none, another customer pays", async () => {
  const provider = M.createInternalTaxProvider({
    zones: [{ id: "zone-au", name: "AU", countryCode: "AU", region: null, companyId: COMPANY_A, countries: ["AU"], regions: [], postcodePatterns: [], pricesIncludeTax: false, priority: 0, active: true }],
    rates: [
      { companyId: COMPANY_A, zoneId: "zone-au", taxClass: "default", rateBps: 1000, inclusive: false, label: "GST", active: true, priority: 0, appliesToProducts: true, appliesToShipping: false },
      { companyId: COMPANY_A, zoneId: "zone-au", taxClass: "shipping", rateBps: 1000, inclusive: false, label: "GST on shipping", active: true, priority: 0, appliesToProducts: false, appliesToShipping: true },
    ],
  });
  const storage = M.createMemoryTaxExemptionStorage();
  await storage.insert(M.buildTaxExemption(COMPANY_A, "tx-tax", { customerRef: "cust-a" }, NOW));
  const address = { countryCode: "AU", region: null, postcode: "3000" };

  const run = async (customerRef) => {
    const decision = await M.resolveTaxExemption(storage, COMPANY_A, { exemptionKey: null, customerRef }, NOW);
    return M.calculateOrderTax(provider, COMPANY_A, {
      lines: [{ lineId: "l1", taxClass: "default", quantity: 1, amountMinor: 1000, exempt: decision.taxClassExempt("default") }],
      shippingMinor: 500,
      pricesIncludeTax: false,
      address,
      exempt: decision.wholeOrder,
      shippingExempt: decision.shippingExempt(),
    });
  };

  assert.equal((await run("cust-a")).taxTotalMinor, 0, "the exempt customer pays no tax on goods or shipping");
  assert.equal((await run("cust-b")).taxTotalMinor, 150, "10 percent of 1000 plus 10 percent of 500");
});

test("an exemption record needs exactly one binding", () => {
  assert.throws(() => M.buildTaxExemption(COMPANY_A, "x", {}, NOW), (error) => error instanceof M.MoneyError);
  assert.throws(() => M.buildTaxExemption(COMPANY_A, "x", { exemptionKey: "K", customerRef: "c" }, NOW), (error) => error instanceof M.MoneyError);
});

// ---------------------------------------------------------------------------
// BNPL cancel and webhook
// ---------------------------------------------------------------------------

const BNPL_CODE = "fake-bnpl";
const WEBHOOK_SECRET = "whsec_test_only";
const CREDS = { webhook_secret: WEBHOOK_SECRET };

function bnplFixture(cancelStatus = "cancelled") {
  const storage = M.createMemoryBnplLifecycleStorage();
  const calls = { cancel: 0 };
  const provider = {
    code: BNPL_CODE,
    async checkEligibility() {
      return noNetwork();
    },
    async createOffer() {
      return noNetwork();
    },
    async cancelOffer(companyId, offerId) {
      calls.cancel += 1;
      return { id: offerId, companyId, orderRef: "ORD-1", providerCode: BNPL_CODE, status: cancelStatus, amountMinor: 10000, currency: "AUD", installmentCount: 4, hostedCheckoutUrl: null, createdAt: NOW };
    },
    async verifyWebhook(_companyId, input, credentials) {
      return M.verifyPaymentWebhookSignature(input, credentials.webhook_secret, NOW_SECONDS);
    },
  };
  const service = M.createBnplLifecycleService({ storage, provider, env: FLAGS, now: () => NOW });
  return { storage, provider, service, calls };
}

async function seedOffer(storage, id, status, companyId = COMPANY_A) {
  const ok = await storage.insert({
    companyId,
    idempotencyKey: `key-${id}`,
    requestHash: "c".repeat(64),
    offer: { id, companyId, orderRef: "ORD-1", providerCode: BNPL_CODE, status, amountMinor: 10000, currency: "AUD", installmentCount: 4, hostedCheckoutUrl: null, createdAt: NOW },
    schedule: [],
    merchantFeeMinor: 0,
  });
  assert.equal(ok, true);
}

function bnplBody(eventId, offerId, status) {
  return JSON.stringify({ id: eventId, type: "offer.updated", data: { offer_id: offerId, status } });
}

function signed(body, secret = WEBHOOK_SECRET, timestamp = NOW_SECONDS) {
  return { rawBody: body, signature: M.signPaymentWebhook(body, secret, timestamp), timestamp: String(timestamp) };
}

test("a BNPL webhook with a bad signature is refused and stores nothing", async () => {
  const { storage, service } = bnplFixture();
  await seedOffer(storage, "off-1", "accepted");
  const body = bnplBody("evt-1", "off-1", "active");

  await refusedWith(service.receiveWebhook(COMPANY_A, signed(body, "wrong-secret"), CREDS), "forbidden");
  await refusedWith(service.receiveWebhook(COMPANY_A, signed(body), {}), "forbidden");
  await refusedWith(service.receiveWebhook(COMPANY_A, { ...signed(body), signature: null }, CREDS), "forbidden");

  const tampered = { ...signed(body), rawBody: bnplBody("evt-1", "off-1", "completed") };
  await refusedWith(service.receiveWebhook(COMPANY_A, tampered, CREDS), "forbidden");

  assert.equal((await storage.getOffer(COMPANY_A, "off-1")).offer.status, "accepted", "the offer did not move");
  const key = M.paymentWebhookEventKey(`bnpl:${BNPL_CODE}`, "evt-1", body);
  assert.equal(await storage.findWebhookEvent(COMPANY_A, `bnpl:${BNPL_CODE}`, key), null, "a refused webhook is not recorded");
});

test("a valid BNPL webhook moves the offer once, and a replay is recognised", async () => {
  const { storage, service } = bnplFixture();
  await seedOffer(storage, "off-2", "accepted");
  const body = bnplBody("evt-2", "off-2", "active");

  assert.equal(await service.receiveWebhook(COMPANY_A, signed(body), CREDS), "processed");
  assert.equal((await storage.getOffer(COMPANY_A, "off-2")).offer.status, "active");
  assert.equal(await service.receiveWebhook(COMPANY_A, signed(body), CREDS), "replayed");
});

test("a BNPL webhook that would move an offer backwards is ignored, and an unknown offer is unmatched", async () => {
  const { storage, service } = bnplFixture();
  await seedOffer(storage, "off-3", "active");
  await seedOffer(storage, "off-4", "accepted", COMPANY_A);

  assert.equal(await service.receiveWebhook(COMPANY_A, signed(bnplBody("evt-3", "off-3", "eligible")), CREDS), "ignored");
  assert.equal((await storage.getOffer(COMPANY_A, "off-3")).offer.status, "active");

  assert.equal(await service.receiveWebhook(COMPANY_B, signed(bnplBody("evt-4", "off-4", "active")), CREDS), "unmatched", "another company cannot move this offer");
  assert.equal((await storage.getOffer(COMPANY_A, "off-4")).offer.status, "accepted");
});

test("cancelling an eligible offer calls the provider once, and a repeat is a no-op", async () => {
  const { storage, service, calls } = bnplFixture();
  await seedOffer(storage, "off-5", "eligible");

  assert.equal(await service.cancelOffer(COMPANY_A, "off-5", CREDS, noNetwork), "cancelled");
  assert.equal(await service.cancelOffer(COMPANY_A, "off-5", CREDS, noNetwork), "cancelled");
  assert.equal(calls.cancel, 1);
  assert.equal((await storage.getOffer(COMPANY_A, "off-5")).offer.status, "cancelled");
});

test("an active BNPL plan cannot be cancelled, and an unconfirmed provider cancel changes nothing", async () => {
  const active = bnplFixture();
  await seedOffer(active.storage, "off-6", "active");
  await refusedWith(active.service.cancelOffer(COMPANY_A, "off-6", CREDS, noNetwork), "state");
  assert.equal(active.calls.cancel, 0);

  const unconfirmed = bnplFixture("accepted");
  await seedOffer(unconfirmed.storage, "off-7", "accepted");
  await refusedWith(unconfirmed.service.cancelOffer(COMPANY_A, "off-7", CREDS, noNetwork), "state");
  assert.equal((await unconfirmed.storage.getOffer(COMPANY_A, "off-7")).offer.status, "accepted");
});

test("BNPL cancel is refused when BNPL is off", async () => {
  const storage = M.createMemoryBnplLifecycleStorage();
  const provider = { code: BNPL_CODE, verifyWebhook: async () => false, cancelOffer: async () => null };
  const service = M.createBnplLifecycleService({ storage, provider, env: {}, now: () => NOW });
  await refusedWith(service.cancelOffer(COMPANY_A, "off-x", CREDS, noNetwork), "disabled");
});

// ---------------------------------------------------------------------------
// Recurring rental bookings
// ---------------------------------------------------------------------------

const ITEM = {
  companyId: COMPANY_A,
  id: "item-1",
  sku: "MIC-1",
  name: "Microphone",
  currency: "AUD",
  dailyRateMinor: 1000,
  depositMinor: 5000,
  lateFeePerDayMinor: 500,
  lateFeeCapMinor: null,
  graceDays: 0,
  active: true,
};

function hireFixture() {
  const storage = M.createMemoryRecurringStorage([ITEM]);
  let n = 0;
  const service = M.createRecurringRentalService({ storage, env: FLAGS, now: () => NOW, newId: () => `n${++n}` });
  return { storage, service };
}

function seriesInput(overrides = {}) {
  return {
    companyId: COMPANY_A,
    itemId: "item-1",
    customerRef: "cust-a",
    startsOn: "2026-12-01",
    frequency: "weekly",
    durationDays: 2,
    occurrences: 3,
    idempotencyKey: "rent-1",
    ...overrides,
  };
}

test("occurrences are spaced by the interval and inclusive of their duration", () => {
  assert.deepEqual(M.occurrenceDates("2026-12-01", 7, 2, 3), [
    { startsOn: "2026-12-01", endsOn: "2026-12-02" },
    { startsOn: "2026-12-08", endsOn: "2026-12-09" },
    { startsOn: "2026-12-15", endsOn: "2026-12-16" },
  ]);
});

test("a recurring rental books every occurrence and prices each one", async () => {
  const { storage, service } = hireFixture();
  const result = await service.book(seriesInput());
  assert.equal(result.bookings.length, 3);
  assert.ok(result.bookings.every((booking) => booking.seriesId === result.series.id));
  assert.equal(result.totalRentalMinor, 6000, "3 occurrences of 2 days at 1000 cents a day");
  assert.equal(result.totalDepositMinor, 15000, "each occurrence carries its own deposit");
  assert.equal(storage.bookings.size, 3);
});

test("a recurring rental does not overlap another, and a refused series writes nothing", async () => {
  const { storage, service } = hireFixture();
  await service.book(seriesInput());

  // Starts on the second day of the first occurrence (12-01 to 12-02), so it clashes.
  await refusedWith(service.book(seriesInput({ idempotencyKey: "rent-2", startsOn: "2026-12-02" })), "conflict");
  assert.equal(storage.bookings.size, 3, "the refused series left no occurrence behind");

  // 12-03..12-04 and 12-10..12-11 fall between the booked days, so this series is clear.
  const clear = await service.book(seriesInput({ idempotencyKey: "rent-3", startsOn: "2026-12-03", occurrences: 2 }));
  assert.equal(clear.bookings.length, 2);
  assert.equal(storage.bookings.size, 5);
});

test("a recurring rental that clashes only on a later occurrence is refused as a whole", async () => {
  const { storage, service } = hireFixture();
  await service.book(seriesInput());
  // The first series holds 12-01..02, 12-08..09 and 12-15..16. This series' first occurrence (12-10) is clear,
  // and its second (12-15) lands on the held 12-15..16, so the whole series is refused.
  await refusedWith(service.book(seriesInput({ idempotencyKey: "rent-4", startsOn: "2026-12-10", frequency: "custom", customIntervalDays: 5, durationDays: 1, occurrences: 2 })), "conflict");
  assert.equal(storage.bookings.size, 3, "the clear first occurrence was not written either");
});

test("a recurring rental interval shorter than its rental is refused, since occurrences would overlap", async () => {
  const { service } = hireFixture();
  await refusedWith(service.book(seriesInput({ frequency: "custom", customIntervalDays: 1, durationDays: 2 })), "validation");
});

test("the same key and request replay the stored series, and a different request on the key is refused", async () => {
  const { storage, service } = hireFixture();
  const first = await service.book(seriesInput());
  const replay = await service.book(seriesInput());
  assert.equal(replay.replayed, true);
  assert.equal(replay.series.id, first.series.id);
  assert.equal(storage.bookings.size, 3, "a replay creates no bookings");
  await refusedWith(service.book(seriesInput({ occurrences: 4 })), "conflict");
});

test("recurring rental is refused when rental and hire is off", async () => {
  const storage = M.createMemoryRecurringStorage([ITEM]);
  const service = M.createRecurringRentalService({ storage, env: {}, now: () => NOW });
  await refusedWith(service.book(seriesInput()), "disabled");
});

// ---------------------------------------------------------------------------
// Drizzle store: tenancy and the transaction paths. Pure: no database needed.
// ---------------------------------------------------------------------------

test("the Drizzle stores treat a company id that is not a UUID as absent, without querying", async () => {
  const payments = createDrizzlePaymentStorage(null);
  assert.equal(await payments.getIntent("not-a-uuid", "pi_1"), null);
  const coupons = createDrizzleCouponStorage(null);
  assert.equal(await coupons.findCouponByCode("not-a-uuid", "SAVE10"), null);
  assert.equal(await coupons.redeemCart("not-a-uuid", "cart-1", NOW), 0);
  const exemptions = createDrizzleTaxExemptionStorage(null);
  assert.deepEqual(await exemptions.findMatching("not-a-uuid", { exemptionKey: "K", customerRef: null }, NOW), []);
});

// ---------------------------------------------------------------------------
// Drizzle store against a real Postgres (skipped unless MONEY_GAPS_DATABASE_URL is set)
// ---------------------------------------------------------------------------

const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 6 }) : null;
const db = pool ? drizzle(pool) : null;
after(async () => {
  if (pool) await pool.end();
});

async function resetDb() {
  await pool.query(`TRUNCATE commerce_coupon_usages, commerce_coupons, commerce_tax_exemptions, commerce_rental_series_bookings,
    commerce_rental_series, commerce_rental_bookings, commerce_rental_items, commerce_bnpl_offers, commerce_payment_intents,
    commerce_payment_operations, commerce_payment_webhook_events`);
  await pool.query(
    `INSERT INTO commerce_rental_items (company_id, id, sku, name, currency, daily_rate_minor, deposit_minor, late_fee_per_day_minor, late_fee_cap_minor, grace_days, active)
     VALUES ($1, 'item-1', 'MIC-1', 'Microphone', 'AUD', 1000, 5000, 500, NULL, 0, true)`,
    [COMPANY_A],
  );
}

function rawBooking(key, startsOn, endsOn) {
  return {
    companyId: COMPANY_A,
    id: `bk-${key}`,
    itemId: "item-1",
    customerRef: null,
    startsOn,
    endsOn,
    currency: "AUD",
    rentalMinor: 1000,
    depositMinor: 0,
    status: "reserved",
    returnedOn: null,
    lateDays: 0,
    lateFeeMinor: 0,
    depositReturnedMinor: 0,
    amountDueMinor: 0,
    requestHash: "d".repeat(64),
    idempotencyKey: `bk-key-${key}`,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

dbTest("Drizzle coupons: two carts racing for the last use, exactly one wins", async () => {
  await resetDb();
  const storage = createDrizzleCouponStorage(db);
  await storage.insertCoupon(M.buildCouponRecord(COMPANY_A, "cpn-race", { code: "RACE", type: "fixed", value: 100, usageLimit: 1 }));
  const service = M.createCouponService({ storage, now: () => NOW });

  const results = await Promise.allSettled([
    service.reserve(quoteInput({ code: "RACE", cartId: "cart-1", customerRef: "cust-a" })),
    service.reserve(quoteInput({ code: "RACE", cartId: "cart-2", customerRef: "cust-b" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loser = results.find((result) => result.status === "rejected");
  assert.equal(loser.reason.message, USAGE_LIMIT);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM commerce_coupon_usages WHERE status = 'reserved'");
  assert.equal(rows[0].n, 1);
});

dbTest("Drizzle coupons: releasing a cart and redeeming it move the usage through its states", async () => {
  await resetDb();
  const storage = createDrizzleCouponStorage(db);
  await storage.insertCoupon(M.buildCouponRecord(COMPANY_A, "cpn-states", { code: "STATE", type: "fixed", value: 100 }));
  const service = M.createCouponService({ storage, now: () => NOW });
  await service.reserve(quoteInput({ code: "STATE", cartId: "cart-9", customerRef: "cust-a" }));
  assert.equal(await service.releaseCart(COMPANY_A, "cart-9"), 1);
  const reserved = await service.reserve(quoteInput({ code: "STATE", cartId: "cart-9", customerRef: "cust-a" }));
  assert.equal(reserved.usage.status, "reserved");
  assert.equal(await service.redeemCart(COMPANY_A, "cart-9"), 1);
  assert.equal(await service.releaseCart(COMPANY_A, "cart-9"), 0, "a redeemed use is not released");
});

dbTest("Drizzle recurring: two overlapping series inserted at once, one is stored", async () => {
  await resetDb();
  const storage = createDrizzleRecurringStorage(db);
  const series = (key, startsOn) => ({
    companyId: COMPANY_A,
    id: `rser-${key}`,
    itemId: "item-1",
    customerRef: "cust-a",
    startsOn,
    frequency: "weekly",
    intervalDays: 7,
    durationDays: 2,
    occurrences: 2,
    currency: "AUD",
    status: "active",
    idempotencyKey: `series-${key}`,
    requestHash: "e".repeat(64),
    createdAt: NOW,
  });
  const results = await Promise.all([
    storage.insertSeries(series("a", "2026-12-01"), [
      rawBooking("a1", "2026-12-01", "2026-12-02"),
      rawBooking("a2", "2026-12-08", "2026-12-09"),
    ]),
    storage.insertSeries(series("b", "2026-12-02"), [
      rawBooking("b1", "2026-12-02", "2026-12-03"),
      rawBooking("b2", "2026-12-09", "2026-12-10"),
    ]),
  ]);
  assert.equal(results.filter((outcome) => outcome === "stored").length, 1);
  assert.equal(results.filter((outcome) => outcome === "overlap").length, 1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM commerce_rental_bookings");
  assert.equal(rows[0].n, 2, "only the stored series' occurrences exist");
});

dbTest("Drizzle hire bookings: the exclusion constraint refuses an overlap that bypasses the service check", async () => {
  await resetDb();
  const storage = createDrizzleHireStorage(db);
  assert.equal(await storage.insertBooking(rawBooking("x", "2026-12-01", "2026-12-03")), true);
  await assert.rejects(
    storage.insertBooking(rawBooking("y", "2026-12-03", "2026-12-04")),
    (error) => error instanceof M.MoneyError && error.code === "conflict",
  );
  assert.equal(await storage.insertBooking(rawBooking("z", "2026-12-04", "2026-12-05")), true, "a day after the first is free");
});

dbTest("Drizzle payments: duplicate keys are refused, a stale version is refused, and another company sees nothing", async () => {
  await resetDb();
  const storage = createDrizzlePaymentStorage(db);
  const intent = {
    companyId: COMPANY_A,
    id: "pi_1",
    providerName: "internal",
    providerIntentId: "pi_ext_1",
    idempotencyKey: "k-1",
    requestHash: "f".repeat(64),
    orderRef: "ORD-1",
    method: "card",
    currency: "AUD",
    amountMinor: 10000,
    authorizedMinor: 0,
    capturedMinor: 0,
    refundedMinor: 0,
    status: "requires_payment_method",
    customerRef: null,
    clientToken: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  assert.equal(await storage.insertIntent(intent), true);
  assert.equal(await storage.insertIntent({ ...intent, id: "pi_2", providerIntentId: "pi_ext_2" }), false, "same idempotency key");
  assert.equal(await storage.updateIntent(COMPANY_A, "pi_1", 5, { status: "requires_capture" }, NOW), false, "stale version");
  assert.equal(await storage.updateIntent(COMPANY_A, "pi_1", 0, { status: "requires_capture", authorizedMinor: 10000 }, NOW), true);
  const stored = await storage.getIntent(COMPANY_A, "pi_1");
  assert.equal(stored.status, "requires_capture");
  assert.equal(stored.version, 1);
  assert.equal(await storage.getIntent(COMPANY_B, "pi_1"), null);
});

dbTest("Drizzle BNPL: a signed webhook moves the stored offer, and a bad signature leaves it alone", async () => {
  await resetDb();
  const storage = createDrizzleBnplLifecycleStorage(db);
  const provider = {
    code: BNPL_CODE,
    verifyWebhook: async (_companyId, input, credentials) => M.verifyPaymentWebhookSignature(input, credentials.webhook_secret, NOW_SECONDS),
    cancelOffer: async () => null,
  };
  const service = M.createBnplLifecycleService({ storage, provider, env: FLAGS, now: () => NOW });
  await storage.insert({
    companyId: COMPANY_A,
    idempotencyKey: "bnpl-key-1",
    requestHash: "a".repeat(64),
    offer: { id: "off-db", companyId: COMPANY_A, orderRef: "ORD-9", providerCode: BNPL_CODE, status: "accepted", amountMinor: 10000, currency: "AUD", installmentCount: 4, hostedCheckoutUrl: null, createdAt: NOW },
    schedule: [],
    merchantFeeMinor: 0,
  });

  const body = bnplBody("evt-db", "off-db", "active");
  await refusedWith(service.receiveWebhook(COMPANY_A, signed(body, "nope"), CREDS), "forbidden");
  assert.equal((await storage.getOffer(COMPANY_A, "off-db")).offer.status, "accepted");

  assert.equal(await service.receiveWebhook(COMPANY_A, signed(body), CREDS), "processed");
  assert.equal((await storage.getOffer(COMPANY_A, "off-db")).offer.status, "active");
  assert.equal(await service.receiveWebhook(COMPANY_A, signed(body), CREDS), "replayed");
});

dbTest("Drizzle tax exemptions: a customer-bound record is found for its customer only", async () => {
  await resetDb();
  const storage = createDrizzleTaxExemptionStorage(db);
  await storage.insert(M.buildTaxExemption(COMPANY_A, "tx-db", { customerRef: "cust-a" }, NOW));
  const a = await M.resolveTaxExemption(storage, COMPANY_A, { exemptionKey: null, customerRef: "cust-a" }, NOW);
  const b = await M.resolveTaxExemption(storage, COMPANY_A, { exemptionKey: null, customerRef: "cust-b" }, NOW);
  assert.equal(a.wholeOrder, true);
  assert.equal(b.wholeOrder, false);
  const other = await M.resolveTaxExemption(storage, COMPANY_B, { exemptionKey: null, customerRef: "cust-a" }, NOW);
  assert.equal(other.wholeOrder, false);
});

// Recurring series cancel (owner decision 2026-11-09). Reserved occurrences are cancelled; active and returned ones are not.
test("cancelling a series cancels reserved occurrences and leaves an active one alone", async () => {
  const { storage, service } = hireFixture();
  const booked = await service.book(seriesInput());
  const ids = booked.bookings.map((booking) => booking.id);
  const middleKey = `${COMPANY_A}\u0000${ids[1]}`;
  storage.bookings.set(middleKey, { ...storage.bookings.get(middleKey), status: "active" });

  const result = await service.cancel(COMPANY_A, booked.series.id);

  assert.equal(result.series.status, "cancelled");
  assert.deepEqual([...result.cancelledBookingIds].sort(), [ids[0], ids[2]].sort());
  assert.equal(result.bookings.find((booking) => booking.id === ids[1]).status, "active");
  assert.equal(result.bookings.find((booking) => booking.id === ids[0]).status, "cancelled");
});

test("cancelling a series twice cancels nothing the second time", async () => {
  const { service } = hireFixture();
  const booked = await service.book(seriesInput());
  await service.cancel(COMPANY_A, booked.series.id);
  const again = await service.cancel(COMPANY_A, booked.series.id);
  assert.equal(again.series.status, "cancelled");
  assert.deepEqual(again.cancelledBookingIds, []);
});

test("a series from another company is not found", async () => {
  const { service } = hireFixture();
  const booked = await service.book(seriesInput());
  assert.equal(await service.cancel(COMPANY_B, booked.series.id), null);
});
