// Commerce money domain tests (node:test). No network: every provider is in-process or a fake, and the HTTP
// client passed around is one that throws if it is ever called.
// Covers payments, webhooks, BNPL, tax, shipping, pricing, rental hire, and the Drizzle queries and tables.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-commerce-money.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import * as M from "../../server/modules/chatbot/commerce/money/index.ts";
import {
  insertHireBookingQuery,
  insertPaymentIntentQuery,
  selectHoldingHireBookingsQuery,
  selectPaymentIntentByKeyQuery,
  updatePaymentIntentVersionQuery,
} from "../../server/modules/chatbot/commerce/money/drizzle-queries.ts";
import * as dbTables from "../../server/modules/chatbot/db/commerce-money.ts";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-08T00:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const dialect = new PgDialect();

const PAYMENTS_ON = { [CONTRACT_FLAGS.PAYMENTS_ENABLED]: "true" };
const ALL_ON = {
  [CONTRACT_FLAGS.PAYMENTS_ENABLED]: "true",
  [CONTRACT_FLAGS.BNPL_ENABLED]: "true",
  [CONTRACT_FLAGS.PRICING_RULES_ENABLED]: "true",
  [CONTRACT_FLAGS.RENTAL_HIRE_ENABLED]: "true",
};

/** HTTP client that fails the test if any code path reaches for the network. */
const noNetwork = async () => {
  throw new Error("network call attempted");
};

function sequence(prefix) {
  let n = 0;
  return () => `${prefix}${++n}`;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => error instanceof M.MoneyError && error.code === code, `expected MoneyError ${code}`);
}

function throwsWith(fn, code) {
  assert.throws(fn, (error) => error instanceof M.MoneyError && error.code === code, `expected MoneyError ${code}`);
}

/** Wraps a provider so the test can count the calls that reach it. */
function countingProvider(provider) {
  const calls = { createIntent: 0, refund: 0, capture: 0 };
  return {
    calls,
    provider: {
      ...provider,
      async createIntent(...args) {
        calls.createIntent += 1;
        return provider.createIntent(...args);
      },
      async refund(...args) {
        calls.refund += 1;
        return provider.refund(...args);
      },
      async capture(...args) {
        calls.capture += 1;
        return provider.capture(...args);
      },
    },
  };
}

function paymentFixture(env = PAYMENTS_ON) {
  const newId = sequence("id");
  const storage = M.createMemoryPaymentStorage();
  const counted = countingProvider(M.createInternalPaymentProvider({ now: () => NOW, newId }));
  const service = M.createPaymentService({ storage, provider: counted.provider, env, now: () => NOW, newId });
  return { storage, service, calls: counted.calls };
}

function intentInput(overrides = {}) {
  return {
    companyId: COMPANY_A,
    orderRef: "ORD-1001",
    amountMinor: 10_000,
    currency: "AUD",
    method: "card",
    description: null,
    idempotencyKey: "pay-create-1",
    customerRef: "cust-1",
    ...overrides,
  };
}

/** Creates an authorised intent for 10000 cents. */
async function authorisedIntent(fixture) {
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  return fixture.service.authorize(COMPANY_A, created.id, `auth-${created.id}`, noNetwork);
}

function signedWebhook(body, secret, timestamp = NOW_SECONDS) {
  return { rawBody: body, signature: M.signPaymentWebhook(body, secret, timestamp), timestamp: String(timestamp) };
}

// ---------------------------------------------------------------------------
// Money arithmetic
// ---------------------------------------------------------------------------

test("percentage discounts round half up to whole cents", () => {
  assert.equal(M.percentageOf(999, 1000), 100, "10 percent of 999 cents is 99.9, which rounds to 100");
  assert.equal(M.percentageOf(333, 1500), 50, "15 percent of 333 cents is 49.95, which rounds to 50");
  assert.equal(M.percentageOf(1234, 1000), 123, "10 percent of 1234 cents is 123.4, which rounds to 123");
  assert.equal(M.percentageOf(1000, 25000), 1000, "rates above 100 percent clamp to 100 percent");
  assert.ok(Number.isInteger(M.percentageOf(777, 333)), "a percentage is always a whole number of cents");
});

test("rounded division is half up and rejects negatives", () => {
  assert.equal(M.roundedDivide(5, 2), 3);
  assert.equal(M.roundedDivide(4, 2), 2);
  throwsWith(() => M.roundedDivide(-1, 2), "validation");
});

test("money inputs must be safe non-negative integers", () => {
  throwsWith(() => M.assertMinor(10.5, "Amount"), "validation");
  throwsWith(() => M.assertMinor(Number.MAX_SAFE_INTEGER + 2, "Amount"), "validation");
  throwsWith(() => M.assertPositiveMinor(0, "Amount"), "validation");
  throwsWith(() => M.normaliseCurrency("AU"), "validation");
  assert.equal(M.normaliseCurrency(" aud "), "AUD");
});

test("discount allocation splits a cart discount exactly across lines", () => {
  const shares = M.allocateDiscount(5, [
    { key: "a", amount: 3 },
    { key: "b", amount: 3 },
    { key: "c", amount: 4 },
  ]);
  const total = [...shares.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(total, 5, "the allocated total equals the requested discount");
  assert.equal(shares.get("a"), 2);
  assert.equal(shares.get("b"), 1);
  assert.equal(shares.get("c"), 2);
  for (const [key, amount] of [["a", 3], ["b", 3], ["c", 4]]) {
    assert.ok(shares.get(key) <= amount, "no line is discounted below zero");
  }
});

test("request hashes ignore key order", () => {
  assert.equal(M.hashRequest({ a: 1, b: { x: 1, y: 2 } }), M.hashRequest({ b: { y: 2, x: 1 }, a: 1 }));
  assert.notEqual(M.hashRequest({ a: 1 }), M.hashRequest({ a: 2 }));
});

test("keyed lock runs same-key work one at a time", async () => {
  const lock = M.createKeyedLock();
  const order = [];
  const slow = lock("k", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first");
  });
  const fast = lock("k", async () => {
    order.push("second");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["first", "second"]);
});

// ---------------------------------------------------------------------------
// Payment flags and intents
// ---------------------------------------------------------------------------

test("payments are off unless the flag is exactly the string true", async () => {
  for (const value of ["TRUE", "1", "yes", "on", undefined]) {
    const fixture = paymentFixture({ [CONTRACT_FLAGS.PAYMENTS_ENABLED]: value });
    await rejectsWith(fixture.service.createIntent(intentInput(), noNetwork), "disabled");
  }
});

test("a duplicate payment request with the same key creates one intent", async () => {
  const fixture = paymentFixture();
  const first = await fixture.service.createIntent(intentInput(), noNetwork);
  const second = await fixture.service.createIntent(intentInput(), noNetwork);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.id, first.id, "the replay returns the stored intent");
  assert.equal(fixture.calls.createIntent, 1, "the provider is called once");
  assert.equal(fixture.storage.intents.size, 1, "only one intent is stored");
});

test("the same key with a different request is refused", async () => {
  const fixture = paymentFixture();
  await fixture.service.createIntent(intentInput(), noNetwork);
  await rejectsWith(fixture.service.createIntent(intentInput({ amountMinor: 20_000 }), noNetwork), "conflict");
  assert.equal(fixture.calls.createIntent, 1);
});

test("a payment amount must be a whole number of minor units", async () => {
  const fixture = paymentFixture();
  await rejectsWith(fixture.service.createIntent(intentInput({ amountMinor: 10.5 }), noNetwork), "validation");
  await rejectsWith(fixture.service.createIntent(intentInput({ idempotencyKey: "" }), noNetwork), "validation");
});

test("a payment intent is invisible to another company", async () => {
  const fixture = paymentFixture();
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  assert.equal(await fixture.service.getIntent(COMPANY_B, created.id), null);
  await rejectsWith(fixture.service.authorize(COMPANY_B, created.id, "auth-x", noNetwork), "not_found");
});

test("capture cannot run before authorisation", async () => {
  const fixture = paymentFixture();
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  await rejectsWith(fixture.service.capture(COMPANY_A, created.id, 1000, "cap-early", noNetwork), "state");
});

test("capture cannot exceed the authorised amount", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  await rejectsWith(fixture.service.capture(COMPANY_A, authorised.id, 10_001, "cap-over", noNetwork), "validation");
});

test("a refund above the captured amount is refused before the provider is called", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  await fixture.service.capture(COMPANY_A, authorised.id, 6_000, "cap-1", noNetwork);

  await rejectsWith(fixture.service.refund(COMPANY_A, authorised.id, 6_001, "ref-over", null, noNetwork), "validation");
  assert.equal(fixture.calls.refund, 0, "the refused refund never reached the provider");

  const refund = await fixture.service.refund(COMPANY_A, authorised.id, 6_000, "ref-full", "customer request", noNetwork);
  assert.equal(refund.refundedTotalMinor, 6_000);
  assert.equal(fixture.calls.refund, 1);

  await rejectsWith(fixture.service.refund(COMPANY_A, authorised.id, 1, "ref-extra", null, noNetwork), "validation");
  assert.equal(fixture.calls.refund, 1, "nothing above the captured amount is refunded in total");
});

test("a refund needs something captured first", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  await rejectsWith(fixture.service.refund(COMPANY_A, authorised.id, 100, "ref-none", null, noNetwork), "state");
  assert.equal(fixture.calls.refund, 0);
});

test("a refund replay with the same key returns the stored result and moves no money twice", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  await fixture.service.capture(COMPANY_A, authorised.id, 5_000, "cap-1", noNetwork);

  const first = await fixture.service.refund(COMPANY_A, authorised.id, 1_000, "ref-1", null, noNetwork);
  const replay = await fixture.service.refund(COMPANY_A, authorised.id, 1_000, "ref-1", null, noNetwork);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.refundId, first.refundId);
  assert.equal(fixture.calls.refund, 1);
  assert.equal((await fixture.service.getIntent(COMPANY_A, authorised.id)).refundedMinor, 1_000);

  await rejectsWith(fixture.service.refund(COMPANY_A, authorised.id, 2_000, "ref-1", null, noNetwork), "conflict");
});

test("a captured payment cannot be cancelled", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  await fixture.service.capture(COMPANY_A, authorised.id, 1_000, "cap-1", noNetwork);
  await rejectsWith(fixture.service.cancel(COMPANY_A, authorised.id, "cancel-1", noNetwork), "state");
});

test("an authorised but uncaptured payment can be cancelled", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  const cancelled = await fixture.service.cancel(COMPANY_A, authorised.id, "cancel-1", noNetwork);
  assert.equal(cancelled.status, "canceled");
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test("signature check: a wrong secret, a stale timestamp, a missing secret and a bad header all fail closed", () => {
  const body = "[]";
  const good = { rawBody: body, signature: M.signPaymentWebhook(body, "whsec_a", NOW_SECONDS), timestamp: String(NOW_SECONDS) };
  assert.equal(M.verifyPaymentWebhookSignature(good, "whsec_a", NOW_SECONDS), true);
  assert.equal(M.verifyPaymentWebhookSignature(good, "whsec_b", NOW_SECONDS), false, "wrong secret");
  assert.equal(M.verifyPaymentWebhookSignature(good, undefined, NOW_SECONDS), false, "missing secret");
  assert.equal(M.verifyPaymentWebhookSignature(good, "", NOW_SECONDS), false, "empty secret");
  assert.equal(M.verifyPaymentWebhookSignature(good, "whsec_a", NOW_SECONDS + 301), false, "outside tolerance");
  assert.equal(M.verifyPaymentWebhookSignature({ ...good, rawBody: "[ ]" }, "whsec_a", NOW_SECONDS), false, "altered body");
  assert.equal(M.verifyPaymentWebhookSignature({ ...good, signature: "v1=abc" }, "whsec_a", NOW_SECONDS), false, "malformed header");
  assert.equal(M.verifyPaymentWebhookSignature({ ...good, timestamp: null }, "whsec_a", NOW_SECONDS), false, "missing timestamp");
});

test("a bad webhook signature is refused and changes nothing", async () => {
  const fixture = paymentFixture();
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  const body = JSON.stringify([{ id: "evt_bad", type: "payment_intent.canceled", payment_intent_id: created.providerIntentId, status: "canceled" }]);

  await rejectsWith(
    fixture.service.receiveWebhook(COMPANY_A, signedWebhook(body, "wrong_secret"), { webhook_secret: "whsec_live" }, noNetwork),
    "forbidden",
  );
  assert.equal((await fixture.service.getIntent(COMPANY_A, created.id)).status, "requires_payment_method");
  assert.equal(fixture.storage.intents.size, 1);
});

test("a webhook with no configured secret is refused", async () => {
  const fixture = paymentFixture();
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  const body = JSON.stringify([{ id: "evt_nosecret", payment_intent_id: created.providerIntentId, status: "canceled" }]);
  await rejectsWith(
    fixture.service.receiveWebhook(COMPANY_A, signedWebhook(body, "anything"), {}, noNetwork),
    "forbidden",
  );
});

test("a stale webhook is refused even when correctly signed", async () => {
  const fixture = paymentFixture();
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  const body = JSON.stringify([{ id: "evt_stale", payment_intent_id: created.providerIntentId, status: "canceled" }]);
  await rejectsWith(
    fixture.service.receiveWebhook(COMPANY_A, signedWebhook(body, "whsec_live", NOW_SECONDS - 400), { webhook_secret: "whsec_live" }, noNetwork),
    "forbidden",
  );
});

test("a valid cancel webhook is applied once, and its replay is ignored", async () => {
  const fixture = paymentFixture();
  const created = await fixture.service.createIntent(intentInput(), noNetwork);
  const body = JSON.stringify([{ id: "evt_1", type: "payment_intent.canceled", payment_intent_id: created.providerIntentId, status: "canceled" }]);
  const credentials = { webhook_secret: "whsec_live" };

  const first = await fixture.service.receiveWebhook(COMPANY_A, signedWebhook(body, "whsec_live"), credentials, noNetwork);
  assert.equal(first.processed, 1);
  assert.equal((await fixture.service.getIntent(COMPANY_A, created.id)).status, "canceled");

  const replay = await fixture.service.receiveWebhook(COMPANY_A, signedWebhook(body, "whsec_live"), credentials, noNetwork);
  assert.equal(replay.ignored, 1);
  assert.equal(replay.processed, 0);
});

test("a webhook cannot move money state, and cannot reach another company's intent", async () => {
  const fixture = paymentFixture();
  const authorised = await authorisedIntent(fixture);
  const credentials = { webhook_secret: "whsec_live" };

  const claimsSuccess = JSON.stringify([{ id: "evt_money", payment_intent_id: authorised.providerIntentId, status: "succeeded", amount_minor: 10_000 }]);
  const applied = await fixture.service.receiveWebhook(COMPANY_A, signedWebhook(claimsSuccess, "whsec_live"), credentials, noNetwork);
  assert.equal(applied.ignored, 1, "a success claim does not capture money");
  assert.equal((await fixture.service.getIntent(COMPANY_A, authorised.id)).capturedMinor, 0);

  const cross = JSON.stringify([{ id: "evt_cross", payment_intent_id: authorised.providerIntentId, status: "canceled" }]);
  const crossReceipt = await fixture.service.receiveWebhook(COMPANY_B, signedWebhook(cross, "whsec_live"), credentials, noNetwork);
  assert.equal(crossReceipt.unmatched, 1, "company B cannot match company A's intent");
  assert.equal((await fixture.service.getIntent(COMPANY_A, authorised.id)).status, "requires_capture");
});

// ---------------------------------------------------------------------------
// BNPL
// ---------------------------------------------------------------------------

const BNPL_POLICY = {
  code: "pay_later",
  displayName: "Pay Later",
  active: true,
  licenceReference: "LIC-123",
  termsUrl: "https://example.test/terms",
  hardshipUrl: "https://example.test/hardship",
  complaintsUrl: "https://example.test/complaints",
  supportedScopes: ["checkout"],
  supportedShoppingModes: ["native", "marketplace_assisted"],
  supportedCurrencies: ["AUD"],
  supportedCountries: ["AU"],
  supportedAccountTypes: [],
  minimumAmountMinor: 100,
  maximumAmountMinor: 500_000,
  installmentCounts: [3, 4],
  intervalDays: 14,
  firstPaymentDelayDays: 0,
  merchantFeeBps: 150,
};

const ELIGIBLE_INPUT = { amountMinor: 5_000, currency: "AUD", country: "AU", scope: "checkout", shoppingMode: "native", accountType: null };

test("BNPL eligibility follows the PHP check order", () => {
  const noLicence = { ...BNPL_POLICY, licenceReference: null };
  assert.equal(M.evaluateBnplEligibility(noLicence, ELIGIBLE_INPUT, true).reason, "licensed_provider_required");
  assert.equal(M.evaluateBnplEligibility(noLicence, ELIGIBLE_INPUT, false).eligible, true);
  assert.equal(M.evaluateBnplEligibility(BNPL_POLICY, { ...ELIGIBLE_INPUT, amountMinor: 50 }, true).reason, "amount_below_minimum");
  assert.equal(M.evaluateBnplEligibility(BNPL_POLICY, { ...ELIGIBLE_INPUT, country: "NZ" }, true).reason, "country_not_supported");

  const marketplace = M.evaluateBnplEligibility(BNPL_POLICY, { ...ELIGIBLE_INPUT, shoppingMode: "marketplace_assisted" }, true);
  assert.equal(marketplace.displayOnly, true);
  assert.equal(marketplace.availability, "marketplace_managed");
});

test("instalments split the amount, with the extra cents on the first instalments", () => {
  const rows = M.installmentSchedule(1_000, 3, 14, "2026-11-08");
  assert.deepEqual(rows.map((row) => row.amountMinor), [334, 333, 333]);
  assert.equal(rows.reduce((sum, row) => sum + row.amountMinor, 0), 1_000, "the rows always add up to the amount");
  assert.deepEqual(rows.map((row) => row.dueOn), ["2026-11-08", "2026-11-22", "2026-12-06"]);
});

test("the merchant fee rounds up to a whole cent", () => {
  assert.equal(M.merchantFeeMinor(1_001, 150), 16, "1.5 percent of 1001 cents is 15.015, which rounds up to 16");
  assert.equal(M.merchantFeeMinor(10_000, 150), 150);
});

test("a BNPL offer is created once per key through the injected provider", async () => {
  let calls = 0;
  const provider = {
    code: "pay_later",
    async createOffer(companyId, orderRef, amountMinor, currency, installmentCount) {
      calls += 1;
      return {
        id: "bnpl_offer_1",
        companyId,
        orderRef,
        providerCode: "pay_later",
        status: "eligible",
        amountMinor,
        currency,
        installmentCount,
        hostedCheckoutUrl: "https://example.test/checkout/bnpl_offer_1",
        createdAt: NOW,
      };
    },
  };
  const service = M.createBnplService({ provider, storage: M.createMemoryBnplOfferStorage(), env: ALL_ON, now: () => NOW });
  const input = {
    companyId: COMPANY_A,
    orderRef: "ORD-1001",
    policy: BNPL_POLICY,
    amountMinor: 5_000,
    currency: "AUD",
    installmentCount: 3,
    scope: "checkout",
    shoppingMode: "native",
    accountType: null,
    country: "AU",
    customerAcceptedTerms: true,
    idempotencyKey: "bnpl-1",
  };
  const first = await service.selectOffer(input, { api_key_ref: "stored" }, noNetwork);
  const second = await service.selectOffer(input, { api_key_ref: "stored" }, noNetwork);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(first.schedule.map((row) => row.amountMinor), [1_667, 1_667, 1_666]);
  assert.equal(first.merchantFeeMinor, 75);
});

test("a BNPL offer needs the customer to accept the provider terms", async () => {
  const provider = { code: "pay_later", createOffer: async () => assert.fail("provider must not be called") };
  const service = M.createBnplService({ provider, storage: M.createMemoryBnplOfferStorage(), env: ALL_ON, now: () => NOW });
  await rejectsWith(service.selectOffer({
    companyId: COMPANY_A, orderRef: "ORD-1", policy: BNPL_POLICY, amountMinor: 5_000, currency: "AUD", installmentCount: 3,
    scope: "checkout", shoppingMode: "native", accountType: null, country: "AU", customerAcceptedTerms: false, idempotencyKey: "bnpl-2",
  }, {}, noNetwork), "validation");
});

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

test("exclusive tax rounds to whole cents and adds on top", () => {
  const calc = M.calculateTaxComponents(999, [{ zoneId: null, taxClass: "default", rateBps: 1000, inclusive: false, label: "GST" }], false);
  assert.equal(calc.taxMinor, 100);
  assert.equal(calc.totalMinor, 1_099);
});

test("inclusive tax divides the rate out of the gross price", () => {
  const rate = [{ zoneId: null, taxClass: "default", rateBps: 1000, inclusive: true, label: "GST" }];
  const eleven = M.calculateTaxComponents(1_100, rate, true);
  assert.equal(eleven.baseMinor, 1_000);
  assert.equal(eleven.taxMinor, 100);
  assert.equal(eleven.totalMinor, 1_100);

  const ten = M.calculateTaxComponents(1_000, rate, true);
  assert.equal(ten.baseMinor, 909, "1000 divided by 1.10 is 909.09, which rounds to 909");
  assert.equal(ten.taxMinor, 91);
  assert.equal(ten.totalMinor, 1_000, "components always add back to the gross price");
});

const TAX_ZONE = {
  id: "zone_vic",
  companyId: COMPANY_A,
  name: "Victoria",
  countryCode: "AU",
  region: "VIC",
  countries: ["AU"],
  regions: ["VIC"],
  postcodePatterns: ["3000-3999"],
  pricesIncludeTax: null,
  priority: 1,
  active: true,
};

const TAX_RATES = [
  { companyId: COMPANY_A, zoneId: "zone_vic", taxClass: "default", rateBps: 1000, inclusive: false, label: "GST", appliesToProducts: true, appliesToShipping: false, priority: 1, active: true },
  { companyId: COMPANY_A, zoneId: "zone_vic", taxClass: "shipping", rateBps: 1000, inclusive: false, label: "GST on shipping", appliesToProducts: false, appliesToShipping: true, priority: 1, active: true },
];

test("order tax resolves the zone, then taxes lines and shipping separately", async () => {
  const provider = M.createInternalTaxProvider({ zones: [TAX_ZONE], rates: TAX_RATES });
  const result = await M.calculateOrderTax(provider, COMPANY_A, {
    lines: [{ lineId: "l1", taxClass: null, quantity: 1, amountMinor: 1_000, exempt: false }],
    shippingMinor: 500,
    pricesIncludeTax: false,
    address: { countryCode: "AU", region: "VIC", postcode: "3141" },
    exempt: false,
  });
  assert.equal(result.zoneId, "zone_vic");
  assert.equal(result.lines[0].taxMinor, 100);
  assert.equal(result.shippingTaxMinor, 50);
  assert.equal(result.taxTotalMinor, 150);
});

test("tax is zero outside every zone, for another company, or when exempt", async () => {
  const provider = M.createInternalTaxProvider({ zones: [TAX_ZONE], rates: TAX_RATES });
  const base = { lines: [{ lineId: "l1", taxClass: null, quantity: 1, amountMinor: 1_000, exempt: false }], shippingMinor: 500, pricesIncludeTax: false, exempt: false };
  const outside = await M.calculateOrderTax(provider, COMPANY_A, { ...base, address: { countryCode: "AU", region: "NSW", postcode: "2000" } });
  assert.equal(outside.taxTotalMinor, 0, "a zone-specific rate does not apply outside its zone");

  const otherCompany = await M.calculateOrderTax(provider, COMPANY_B, { ...base, address: { countryCode: "AU", region: "VIC", postcode: "3141" } });
  assert.equal(otherCompany.taxTotalMinor, 0, "rates are scoped to the company");

  const exempt = await M.calculateOrderTax(provider, COMPANY_A, { ...base, exempt: true, address: { countryCode: "AU", region: "VIC", postcode: "3141" } });
  assert.equal(exempt.taxTotalMinor, 0);
});

test("zone patterns accept ranges and wildcards, and only shipping zones accept a question mark", () => {
  const zone = { countries: ["AU"], regions: [], postcodePatterns: ["31??"] };
  assert.equal(M.matchesZone({ country: "AU", region: null, postcode: "3141" }, zone, { singleCharacterWildcard: true }), true);
  assert.equal(M.matchesZone({ country: "AU", region: null, postcode: "3141" }, zone, { singleCharacterWildcard: false }), false);
  assert.equal(M.matchesZone({ country: "AU", region: null, postcode: "2000" }, zone, { singleCharacterWildcard: true }), false);
  assert.equal(M.matchesZone({ country: "NZ", region: null, postcode: "3141" }, zone, { singleCharacterWildcard: true }), false);
});

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

test("weight rates charge per started kilogram, and free-above overrides them", () => {
  const weight = { rateType: "weight", amountMinor: 0, baseAmountMinor: 500, perKilogramMinor: 300, freeAboveMinor: null, tiers: [] };
  assert.equal(M.shippingRateAmount(weight, 3_000, 1_500), 1_100, "1.5 kg is two started kilograms");

  const freeAbove = { ...weight, freeAboveMinor: 10_000 };
  assert.equal(M.shippingRateAmount(freeAbove, 10_000, 1_500), 0);
  assert.equal(M.shippingRateAmount(freeAbove, 9_999, 1_500), 1_100);
});

test("subtotal rates pick a tier and refuse a subtotal with no tier", () => {
  const rate = {
    rateType: "subtotal", amountMinor: 0, baseAmountMinor: 0, perKilogramMinor: 0, freeAboveMinor: null,
    tiers: [{ minMinor: 0, maxMinor: 4_999, amountMinor: 800 }, { minMinor: 5_000, maxMinor: null, amountMinor: 0 }],
  };
  assert.equal(M.shippingRateAmount(rate, 4_000, 0), 800);
  assert.equal(M.shippingRateAmount(rate, 5_000, 0), 0);
  const narrow = { ...rate, tiers: [{ minMinor: 0, maxMinor: 100, amountMinor: 1 }] };
  throwsWith(() => M.shippingRateAmount(narrow, 500, 0), "validation");
});

const SHIPPING_METHODS = [
  {
    companyId: COMPANY_A, code: "standard", name: "Standard", methodType: "delivery", currency: "AUD", active: true, priority: 2,
    minimumSubtotalMinor: 0, maximumSubtotalMinor: null, minimumWeightGrams: 0, maximumWeightGrams: null, zone: null,
    estimatedDaysMin: 2, estimatedDaysMax: 5,
    rate: { rateType: "weight", amountMinor: 0, baseAmountMinor: 500, perKilogramMinor: 300, freeAboveMinor: 10_000, tiers: [] },
  },
  {
    companyId: COMPANY_A, code: "metro", name: "Metro", methodType: "delivery", currency: "AUD", active: true, priority: 3,
    minimumSubtotalMinor: 0, maximumSubtotalMinor: null, minimumWeightGrams: 0, maximumWeightGrams: null,
    zone: { countries: ["AU"], regions: [], postcodePatterns: ["31??"] }, estimatedDaysMin: 1, estimatedDaysMax: 2,
    rate: { rateType: "flat", amountMinor: 900, baseAmountMinor: 0, perKilogramMinor: 0, freeAboveMinor: null, tiers: [] },
  },
  {
    companyId: COMPANY_A, code: "collect", name: "Collect", methodType: "pickup", currency: "AUD", active: true, priority: 1,
    minimumSubtotalMinor: 0, maximumSubtotalMinor: null, minimumWeightGrams: 0, maximumWeightGrams: null, zone: null,
    estimatedDaysMin: 0, estimatedDaysMax: 1,
    rate: { rateType: "flat", amountMinor: 999, baseAmountMinor: 0, perKilogramMinor: 0, freeAboveMinor: null, tiers: [] },
  },
  {
    companyId: COMPANY_A, code: "download", name: "Download", methodType: "digital", currency: "AUD", active: true, priority: 1,
    minimumSubtotalMinor: 0, maximumSubtotalMinor: null, minimumWeightGrams: 0, maximumWeightGrams: null, zone: null,
    estimatedDaysMin: 0, estimatedDaysMax: 0,
    rate: { rateType: "free", amountMinor: 0, baseAmountMinor: 0, perKilogramMinor: 0, freeAboveMinor: null, tiers: [] },
  },
];

const PHYSICAL_CART = {
  cartId: "cart-1", currency: "AUD",
  lines: [{ variantId: 1, quantity: 2, unitPriceMinor: 1_500, weightGrams: 800, taxClass: null }],
};

const SHIP_ADDRESS = { name: "Sam", line1: "1 Street", line2: null, city: "Melbourne", region: "VIC", postcode: "3141", countryCode: "AU" };

test("physical carts get delivery and pickup quotes, with prices, expiry and zone checks", async () => {
  const provider = M.createInternalShippingProvider({ methods: SHIPPING_METHODS, now: () => NOW });
  const quotes = await provider.quotes(COMPANY_A, PHYSICAL_CART, SHIP_ADDRESS, noNetwork);
  const byCode = new Map(quotes.map((quote) => [quote.service, quote]));

  assert.equal(byCode.get("standard").priceMinor, 1_100, "1.6 kg is two started kilograms");
  assert.equal(byCode.get("metro").priceMinor, 900, "address 3141 is inside the zone");
  assert.equal(byCode.get("collect").priceMinor, 0, "pickup carries no charge");
  assert.equal(byCode.has("download"), false, "a digital method does not quote a physical cart");
  assert.equal(byCode.get("standard").expiresAt.getTime(), NOW.getTime() + 15 * 60_000);

  const outsideZone = await provider.quotes(COMPANY_A, PHYSICAL_CART, { ...SHIP_ADDRESS, postcode: "2000" }, noNetwork);
  assert.equal(outsideZone.some((quote) => quote.service === "metro"), false);
});

test("a digital cart gets the digital method, not a delivery method", async () => {
  const provider = M.createInternalShippingProvider({ methods: SHIPPING_METHODS, now: () => NOW });
  const digitalCart = { cartId: "cart-2", currency: "AUD", lines: [{ variantId: 2, quantity: 1, unitPriceMinor: 2_000, weightGrams: null, taxClass: null, productType: "digital" }] };
  const quotes = await provider.quotes(COMPANY_A, digitalCart, SHIP_ADDRESS, noNetwork);
  assert.equal(quotes.some((quote) => quote.service === "standard"), false);
  assert.equal(quotes.find((quote) => quote.service === "download").priceMinor, 0);
});

test("expired quotes are filtered out", async () => {
  const provider = M.createInternalShippingProvider({ methods: SHIPPING_METHODS, now: () => NOW });
  const quotes = await provider.quotes(COMPANY_A, PHYSICAL_CART, SHIP_ADDRESS, noNetwork);
  assert.equal(M.unexpiredQuotes(quotes, NOW).length, quotes.length);
  assert.equal(M.unexpiredQuotes(quotes, new Date(NOW.getTime() + 16 * 60_000)).length, 0);
});

test("weights convert from kilograms to whole grams once, at the edge", () => {
  assert.equal(M.gramsFromKilograms(1.25), 1_250);
  throwsWith(() => M.gramsFromKilograms(-1), "validation");
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const CATALOG = (variantId) => {
  if (variantId === 1) return { productId: 10, categoryId: 100 };
  if (variantId === 2) return { productId: 20, categoryId: 200 };
  return null;
};

function pricingContext(lines, overrides = {}) {
  return {
    companyId: COMPANY_A,
    cart: { cartId: "cart-1", currency: "AUD", lines },
    channel: "web",
    customerRef: null,
    at: NOW,
    ...overrides,
  };
}

function pricingRule(overrides = {}) {
  return {
    id: "rule_1",
    companyId: COMPANY_A,
    name: "Rule",
    ruleType: "percentage_discount",
    scope: "cart",
    targetType: "cart",
    targetId: null,
    value: 1_000,
    priority: 1,
    stackable: false,
    active: true,
    currency: null,
    channel: null,
    startsAt: null,
    endsAt: null,
    minQuantity: 1,
    minSubtotalMinor: 0,
    customerRef: null,
    perUnit: false,
    conditions: null,
    ...overrides,
  };
}

const ONE_LINE = (unit, quantity = 1) => [{ variantId: 1, quantity, unitPriceMinor: unit, weightGrams: null, taxClass: null }];

test("a percent discount rounds to whole cents on the cart", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  const result = provider.evaluate(pricingContext(ONE_LINE(999)), [pricingRule()]);
  assert.equal(result.subtotalMinor, 999);
  assert.equal(result.discountMinor, 100);
  assert.equal(result.totalMinor, 899);
  assert.ok(Number.isInteger(result.discountMinor), "the discount is a whole number of cents");
  assert.equal(result.adjustments.length, 1);
});

test("a percent discount on a line rounds to whole cents", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  const result = provider.evaluate(pricingContext(ONE_LINE(1_234)), [pricingRule({ scope: "line" })]);
  assert.equal(result.discountMinor, 123);
  assert.equal(result.totalMinor, 1_111);
});

test("a per-unit fixed discount multiplies by quantity and clamps to the line", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  const perUnit = provider.evaluate(pricingContext(ONE_LINE(500, 3)), [pricingRule({ scope: "line", ruleType: "fixed_discount", value: 200, perUnit: true })]);
  assert.equal(perUnit.discountMinor, 600);
  const flat = provider.evaluate(pricingContext(ONE_LINE(500, 3)), [pricingRule({ scope: "line", ruleType: "fixed_discount", value: 200 })]);
  assert.equal(flat.discountMinor, 200);
});

test("a price override replaces the unit price before discounts", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  const result = provider.evaluate(pricingContext(ONE_LINE(999)), [pricingRule({ scope: "line", ruleType: "price_override", value: 800 })]);
  assert.equal(result.subtotalMinor, 800);
  assert.equal(result.discountMinor, 0);
  assert.equal(result.totalMinor, 800);
});

test("a non-stackable rule stops further discounts, and a stackable one does not", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  const percent = pricingRule({ id: "pct", priority: 2 });
  const fixed = pricingRule({ id: "fix", priority: 1, ruleType: "fixed_discount", value: 100, stackable: true });

  const stacked = provider.evaluate(pricingContext(ONE_LINE(999)), [{ ...percent, stackable: true }, fixed]);
  assert.equal(stacked.totalMinor, 799, "both rules apply when the first one is stackable: 999 - 100 - 100");

  const stopped = provider.evaluate(pricingContext(ONE_LINE(999)), [percent, fixed]);
  assert.equal(stopped.totalMinor, 899, "the first rule is not stackable, so the second one does not apply");
});

test("pricing rules are off unless the flag is exactly true, and are scoped to the company and date", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: { [CONTRACT_FLAGS.PRICING_RULES_ENABLED]: "1" } });
  assert.equal(provider.evaluate(pricingContext(ONE_LINE(999)), [pricingRule()]).totalMinor, 999, "flag is off");

  const on = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  assert.equal(on.evaluate(pricingContext(ONE_LINE(999)), [pricingRule({ companyId: COMPANY_B })]).totalMinor, 999, "another company's rule");
  const future = new Date(NOW.getTime() + 86_400_000);
  assert.equal(on.evaluate(pricingContext(ONE_LINE(999)), [pricingRule({ startsAt: future })]).totalMinor, 999, "a rule not yet started");
});

test("an unknown variant is refused", () => {
  const provider = M.createInternalPricingProvider({ catalog: CATALOG, env: ALL_ON });
  const lines = [{ variantId: 99, quantity: 1, unitPriceMinor: 100, weightGrams: null, taxClass: null }];
  throwsWith(() => provider.evaluate(pricingContext(lines), []), "validation");
});

// ---------------------------------------------------------------------------
// Rental and hire
// ---------------------------------------------------------------------------

const HIRE_ITEMS = [
  {
    companyId: COMPANY_A, id: "item1", sku: "MOWER", name: "Mower", currency: "AUD", dailyRateMinor: 1_000,
    depositMinor: 5_000, lateFeePerDayMinor: 1_200, lateFeeCapMinor: null, graceDays: 1, active: true,
  },
  {
    companyId: COMPANY_A, id: "item2", sku: "LADDER", name: "Ladder", currency: "AUD", dailyRateMinor: 500,
    depositMinor: 0, lateFeePerDayMinor: 300, lateFeeCapMinor: 1_000, graceDays: 0, active: true,
  },
];

function hireFixture(env = ALL_ON) {
  const newId = sequence("h");
  const storage = M.createMemoryHireStorage(HIRE_ITEMS);
  const service = M.createRentalHireService({ storage, env, now: () => NOW, newId });
  return { storage, service };
}

test("a hire quote counts both ends of the booking and prices each day", async () => {
  const { service } = hireFixture();
  const quote = await service.quote(COMPANY_A, "item1", "2027-03-10", "2027-03-14");
  assert.equal(quote.days, 5, "10 to 14 March is five days");
  assert.equal(quote.rentalMinor, 5_000);
  assert.equal(quote.depositMinor, 5_000);
});

test("an item cannot be double-booked for overlapping dates", async () => {
  const { service } = hireFixture();
  await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14", idempotencyKey: "bk-1" });

  await rejectsWith(service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c2", startsOn: "2027-03-14", endsOn: "2027-03-16", idempotencyKey: "bk-2" }), "conflict");
  await rejectsWith(service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c2", startsOn: "2027-03-12", endsOn: "2027-03-13", idempotencyKey: "bk-3" }), "conflict");
  await rejectsWith(service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c2", startsOn: "2027-03-01", endsOn: "2027-03-31", idempotencyKey: "bk-4" }), "conflict");

  const next = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c2", startsOn: "2027-03-15", endsOn: "2027-03-16", idempotencyKey: "bk-5" });
  assert.equal(next.booking.status, "reserved", "the day after the last booked day is free");

  const otherItem = await service.book({ companyId: COMPANY_A, itemId: "item2", customerRef: "c2", startsOn: "2027-03-12", endsOn: "2027-03-13", idempotencyKey: "bk-6" });
  assert.equal(otherItem.booking.status, "reserved", "another item is not affected");
});

test("a cancelled booking frees its dates, and a booking replay returns the stored booking", async () => {
  const { service } = hireFixture();
  const first = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14", idempotencyKey: "bk-7" });
  const replay = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14", idempotencyKey: "bk-7" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.booking.id, first.booking.id);

  await service.cancel(COMPANY_A, first.booking.id);
  const rebooked = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c2", startsOn: "2027-03-12", endsOn: "2027-03-13", idempotencyKey: "bk-8" });
  assert.equal(rebooked.booking.status, "reserved");
});

test("a late return charges per day beyond the grace days, and the deposit covers it first", async () => {
  const { service } = hireFixture();
  const { booking } = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14", idempotencyKey: "bk-9" });

  const onTime = await service.recordReturn(COMPANY_A, booking.id, "2027-03-15");
  assert.equal(onTime.lateDays, 1);
  assert.equal(onTime.lateFeeMinor, 0, "one day late is inside the one grace day");
  assert.equal(onTime.depositReturnedMinor, 5_000);
  assert.equal(onTime.amountDueMinor, 0);
});

test("a late return beyond grace takes the fee from the deposit, and charges any excess", async () => {
  const { service } = hireFixture();
  const { booking } = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14", idempotencyKey: "bk-10" });
  const late = await service.recordReturn(COMPANY_A, booking.id, "2027-03-18");
  assert.equal(late.lateDays, 4);
  assert.equal(late.lateFeeMinor, 3_600, "three chargeable days at 1200 cents");
  assert.equal(late.depositReturnedMinor, 1_400);
  assert.equal(late.amountDueMinor, 0);

  const big = await service.book({ companyId: COMPANY_A, itemId: "item2", customerRef: "c1", startsOn: "2027-04-01", endsOn: "2027-04-02", idempotencyKey: "bk-11" });
  const capped = await service.recordReturn(COMPANY_A, big.booking.id, "2027-04-20");
  assert.equal(capped.lateFeeMinor, 1_000, "the late fee cap holds at 1000 cents");
  assert.equal(capped.amountDueMinor, 1_000, "with no deposit the whole fee is due from the customer");
});

test("a return cannot be before the start, and an item is not hired to another company", async () => {
  const { service } = hireFixture();
  const { booking } = await service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14", idempotencyKey: "bk-12" });
  await rejectsWith(service.recordReturn(COMPANY_A, booking.id, "2027-03-09"), "validation");
  await rejectsWith(service.book({ companyId: COMPANY_B, itemId: "item1", customerRef: "c9", startsOn: "2027-05-01", endsOn: "2027-05-02", idempotencyKey: "bk-13" }), "not_found");
  assert.equal(await service.recordReturn(COMPANY_B, booking.id, "2027-03-12").catch((error) => error.code), "not_found");
});

test("rental hire is off unless the flag is exactly true", async () => {
  const { service } = hireFixture({ [CONTRACT_FLAGS.RENTAL_HIRE_ENABLED]: "yes" });
  await rejectsWith(service.quote(COMPANY_A, "item1", "2027-03-10", "2027-03-14"), "disabled");
});

test("a hire date must be a real calendar date", async () => {
  const { service } = hireFixture();
  await rejectsWith(service.book({ companyId: COMPANY_A, itemId: "item1", customerRef: null, startsOn: "2027-02-30", endsOn: "2027-03-01", idempotencyKey: "bk-14" }), "validation");
});

// ---------------------------------------------------------------------------
// Drizzle queries and tables
// ---------------------------------------------------------------------------

function recordingDb() {
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      const params = typeof config === "string" ? (values ?? []) : (config.values ?? values ?? []);
      statements.push({ text, params });
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  return { db: drizzle(client), statements };
}

function render(query) {
  if (typeof query.getSQL === "function") return dialect.sqlToQuery(query.getSQL());
  return query.toSQL();
}

test("the payment key lookup and the version-checked update both filter on company_id", () => {
  const { db } = recordingDb();
  const select = render(selectPaymentIntentByKeyQuery(db, COMPANY_A, "pay-key-1"));
  assert.match(select.sql, /"company_id" = \$1/);
  assert.ok(select.params.includes(COMPANY_A));
  assert.ok(select.params.includes("pay-key-1"));

  const update = render(updatePaymentIntentVersionQuery(db, COMPANY_A, "pay_1", 3, { status: "canceled" }, NOW));
  assert.match(update.sql, /"company_id" = \$\d/);
  assert.match(update.sql, /"version" = \$\d/);
  assert.ok(update.params.includes(COMPANY_A));
  assert.ok(update.params.includes(3), "the expected version is part of the predicate");
});

test("the payment insert writes the tenant id and the money as integers", () => {
  const { db } = recordingDb();
  const record = {
    companyId: COMPANY_A, id: "pay_9", providerName: "internal", providerIntentId: "pi_9", idempotencyKey: "k9",
    requestHash: "a".repeat(64), orderRef: "ORD-9", method: "card", currency: "AUD", amountMinor: 10_000,
    authorizedMinor: 0, capturedMinor: 0, refundedMinor: 0, status: "requires_payment_method", customerRef: null,
    clientToken: "ct", version: 0, createdAt: NOW, updatedAt: NOW,
  };
  const rendered = render(insertPaymentIntentQuery(db, record));
  assert.match(rendered.sql, /insert into "commerce_payment_intents"/);
  assert.ok(rendered.params.includes(COMPANY_A));
  assert.ok(rendered.params.includes(10_000));
});

test("the hire overlap query filters on company and item, and locks the rows it reads", () => {
  const { db } = recordingDb();
  const rendered = render(selectHoldingHireBookingsQuery(db, COMPANY_A, "item1", "2027-03-14", "2027-03-16"));
  assert.match(rendered.sql, /"company_id" = \$1/);
  assert.match(rendered.sql, /"starts_on" <= \$\d/, "a booking that starts on or before the new end");
  assert.match(rendered.sql, /"ends_on" >= \$\d/, "a booking that ends on or after the new start");
  assert.match(rendered.sql, /for update/i);
  assert.ok(rendered.params.includes(COMPANY_A));
  assert.ok(rendered.params.includes("item1"));
});

test("the hire insert writes the tenant id", () => {
  const { db } = recordingDb();
  const booking = {
    companyId: COMPANY_A, id: "hire_1", itemId: "item1", customerRef: "c1", startsOn: "2027-03-10", endsOn: "2027-03-14",
    currency: "AUD", rentalMinor: 5_000, depositMinor: 5_000, status: "reserved", returnedOn: null, lateDays: 0,
    lateFeeMinor: 0, depositReturnedMinor: 0, amountDueMinor: 0, requestHash: "b".repeat(64), idempotencyKey: "bk-x",
    version: 0, createdAt: NOW, updatedAt: NOW,
  };
  const rendered = render(insertHireBookingQuery(db, booking));
  assert.match(rendered.sql, /insert into "commerce_rental_bookings"/);
  assert.ok(rendered.params.includes(COMPANY_A));
});

test("every commerce money table carries company_id", () => {
  const tables = Object.values(dbTables).filter((value) => {
    try {
      return typeof getTableConfig(value).name === "string";
    } catch {
      return false;
    }
  });
  assert.equal(tables.length, 10, "ten tables are defined");
  for (const table of tables) {
    const config = getTableConfig(table);
    assert.ok(config.name.startsWith("commerce_"), `${config.name} uses the commerce_ prefix`);
    assert.ok(config.columns.some((column) => column.name === "company_id"), `${config.name} has company_id`);
  }
});

test("the migration draft creates the same ten tables, each with company_id, and the hire overlap exclusion", () => {
  const sql = readFileSync(new URL("../../server/modules/chatbot/db/migrations-draft/0101_commerce_money.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/CREATE TABLE /g) ?? []).length, 10);
  assert.equal((sql.match(/company_id uuid NOT NULL/g) ?? []).length, 10);
  assert.match(sql, /EXCLUDE USING gist/);
  assert.match(sql, /WHERE \(status IN \('reserved', 'active'\)\)/);
});
