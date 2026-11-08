// Tests for the gateway-neutral payment webhook engine (server/engines/payment/engine.ts).
// Run from the repository root:
//   node --experimental-transform-types --test tests/engines/payment/payment-engine.test.mjs
// Uses only node:test and node:crypto. The secret below is a test value, not a real credential.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

const { createPaymentEngine, requireCompanyId } = await import("../../../server/engines/payment/engine.ts");
const { createMemoryProcessedEventStore } = await import("../../../server/engines/payment/idempotency.ts");
const { PaymentEngineError } = await import("../../../server/engines/payment/contract.ts");

const SECRET = "test-only-secret-not-real-0123456789abcdef";
const COMPANY = "company-test-1";
const NOW_MS = 1_750_000_000_000;

const hmac = (alg, key, data) => createHmac(alg, key).update(data).digest("hex");

function stripeHeader(body, { secret = SECRET, tsSeconds = NOW_MS / 1000 } = {}) {
  const t = String(tsSeconds);
  return `t=${t},v1=${hmac("sha256", secret, `${t}.${body}`)}`;
}

function makeEngine(overrides = {}) {
  const store = createMemoryProcessedEventStore();
  const calls = [];
  const engine = createPaymentEngine({
    resolveWebhookSecret: async (companyId, gateway) => {
      calls.push({ companyId, gateway });
      return SECRET;
    },
    store,
    now: () => NOW_MS,
    ...overrides,
  });
  return { engine, store, calls };
}

const STRIPE_BODY = JSON.stringify({ id: "evt_test_1", type: "invoice.payment_succeeded", data: { object: {} } });

test("bad signature is rejected (wrong mac, tampered body, missing header)", async () => {
  const { engine, store } = makeEngine();

  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "stripe", {
      rawBody: STRIPE_BODY,
      headers: { "stripe-signature": stripeHeader(STRIPE_BODY, { secret: "wrong-secret-also-32-chars-long-xx" }) },
    }),
    { code: "signature_invalid", detail: "signature_mismatch" },
  );

  const signedBody = STRIPE_BODY;
  const tampered = signedBody.replace("evt_test_1", "evt_test_2");
  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "stripe", {
      rawBody: tampered,
      headers: { "stripe-signature": stripeHeader(signedBody) },
    }),
    { code: "signature_invalid" },
  );

  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "razorpay", {
      rawBody: STRIPE_BODY,
      headers: {},
    }),
    { code: "signature_invalid", detail: "signature_missing" },
  );

  assert.equal(store.size(), 0, "a rejected webhook must not claim an event key");
});

test("replayed event is refused and the handler runs once", async () => {
  const { engine } = makeEngine();
  let handled = 0;
  const headers = { "stripe-signature": stripeHeader(STRIPE_BODY) };
  const handler = async () => {
    handled += 1;
  };

  const first = await engine.receiveWebhook({ companyId: COMPANY }, "stripe", { rawBody: STRIPE_BODY, headers }, handler);
  assert.equal(first.status, "accepted");

  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "stripe", { rawBody: STRIPE_BODY, headers }, handler),
    { code: "replay_refused" },
  );
  assert.equal(handled, 1);
});

test("unknown gateway is refused before any secret lookup", async () => {
  const { engine, calls } = makeEngine();
  const input = { rawBody: "{}", headers: {} };

  for (const gateway of ["paypal-legacy", "", "__proto__", "constructor", "toString", 42, undefined, null]) {
    await assert.rejects(
      engine.receiveWebhook({ companyId: COMPANY }, gateway, input),
      { code: "unknown_gateway" },
      `gateway ${String(gateway)} should be refused`,
    );
  }
  assert.equal(calls.length, 0, "no secret may be resolved for an unknown gateway");
});

test("missing company_id throws, and a company_id in the body is never used", async () => {
  const { engine, calls } = makeEngine();
  const input = {
    rawBody: JSON.stringify({ company_id: "from-body" }),
    headers: { "stripe-signature": stripeHeader(JSON.stringify({ company_id: "from-body" })) },
  };

  await assert.rejects(engine.receiveWebhook(undefined, "stripe", input), { code: "company_id_required" });
  await assert.rejects(engine.receiveWebhook({}, "stripe", input), { code: "company_id_required" });
  await assert.rejects(engine.receiveWebhook({ companyId: "" }, "stripe", input), { code: "company_id_required" });
  await assert.rejects(engine.receiveWebhook({ companyId: "   " }, "stripe", input), { code: "company_id_required" });
  await assert.rejects(engine.receiveWebhook({ companyId: 42 }, "stripe", input), { code: "company_id_required" });
  await assert.rejects(engine.receiveWebhook({ companyId: "a|b" }, "stripe", input), { code: "company_id_invalid" });

  assert.equal(calls.length, 0, "no secret may be resolved without a valid company_id");
  assert.throws(() => requireCompanyId(undefined), PaymentEngineError);
});

test("valid signed event is accepted and the handler receives the verified scope", async () => {
  const { engine } = makeEngine();
  let seen = null;

  const receipt = await engine.receiveWebhook(
    { companyId: COMPANY },
    "stripe",
    { rawBody: STRIPE_BODY, headers: { "Stripe-Signature": stripeHeader(STRIPE_BODY) } },
    async (event) => {
      seen = event;
    },
  );

  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.companyId, COMPANY);
  assert.equal(receipt.gateway, "stripe");
  assert.equal(receipt.eventKey, `${COMPANY}|stripe|id:evt_test_1`);
  assert.equal(seen.rawBody, STRIPE_BODY);
});

test("valid signed events are accepted for razorpay, paystack and mercadopago", async () => {
  const { engine } = makeEngine();
  const body = JSON.stringify({ event: "payment.captured", payload: {} });

  const razorpaySig = hmac("sha256", SECRET, body);
  const r = await engine.receiveWebhook({ companyId: COMPANY }, "razorpay", {
    rawBody: body,
    headers: { "x-razorpay-signature": razorpaySig },
  });
  assert.equal(r.gateway, "razorpay");

  const paystackSig = hmac("sha512", SECRET, body);
  const p = await engine.receiveWebhook({ companyId: COMPANY }, "paystack", {
    rawBody: body,
    headers: { "x-paystack-signature": paystackSig },
  });
  assert.equal(p.gateway, "paystack");

  const mpBody = JSON.stringify({ id: 987, type: "payment" });
  const ts = "1750000000";
  const manifest = `id:abc123;request-id:req-1;ts:${ts};`;
  const m = await engine.receiveWebhook({ companyId: COMPANY }, "mercadopago", {
    rawBody: mpBody,
    headers: { "x-signature": `ts=${ts},v1=${hmac("sha256", SECRET, manifest)}`, "x-request-id": "req-1" },
    query: { "data.id": "ABC123" },
  });
  assert.equal(m.eventKey, `${COMPANY}|mercadopago|id:987`);
});

test("missing secret fails closed even when the signature would match", async () => {
  const { engine } = makeEngine({ resolveWebhookSecret: async () => null });
  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "stripe", {
      rawBody: STRIPE_BODY,
      headers: { "stripe-signature": stripeHeader(STRIPE_BODY) },
    }),
    { code: "signature_invalid", detail: "secret_missing" },
  );
});

test("stripe timestamp outside the 300 s tolerance is rejected", async () => {
  const { engine } = makeEngine();
  const stale = NOW_MS / 1000 - 1000;
  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "stripe", {
      rawBody: STRIPE_BODY,
      headers: { "stripe-signature": stripeHeader(STRIPE_BODY, { tsSeconds: stale }) },
    }),
    { code: "signature_invalid", detail: "timestamp_outside_tolerance" },
  );
});

test("paypal and yookassa are refused without a remote verifier and accepted with one", async () => {
  const body = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" });
  const input = { rawBody: body, headers: {} };

  const bare = makeEngine().engine;
  await assert.rejects(bare.receiveWebhook({ companyId: COMPANY }, "paypal", input), { code: "signature_invalid" });
  await assert.rejects(bare.receiveWebhook({ companyId: COMPANY }, "yookassa", input), { code: "signature_invalid" });

  let remoteCalls = 0;
  const remote = async () => {
    remoteCalls += 1;
    return { ok: true, eventId: "WH-1" };
  };
  const wired = makeEngine({ remoteVerifiers: { paypal: remote } }).engine;
  const receipt = await wired.receiveWebhook({ companyId: COMPANY }, "paypal", input);
  assert.equal(receipt.eventKey, `${COMPANY}|paypal|id:WH-1`);
  assert.equal(remoteCalls, 1);
});

test("mercadopago without a data.id query value is rejected", async () => {
  const { engine } = makeEngine();
  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "mercadopago", {
      rawBody: "{}",
      headers: { "x-signature": "ts=1,v1=00", "x-request-id": "req-1" },
    }),
    { code: "signature_invalid", detail: "data_id_missing" },
  );
});

test("a failed handler releases the claim so a provider retry is processed", async () => {
  const { engine, store } = makeEngine();
  const headers = { "stripe-signature": stripeHeader(STRIPE_BODY) };

  await assert.rejects(
    engine.receiveWebhook({ companyId: COMPANY }, "stripe", { rawBody: STRIPE_BODY, headers }, async () => {
      throw new Error("db down");
    }),
    /db down/,
  );
  assert.equal(store.size(), 0);

  const retry = await engine.receiveWebhook({ companyId: COMPANY }, "stripe", { rawBody: STRIPE_BODY, headers });
  assert.equal(retry.status, "accepted");
});

test("engine refuses to start without a secret resolver or a store", () => {
  assert.throws(() => createPaymentEngine({ store: createMemoryProcessedEventStore() }), { code: "engine_misconfigured" });
  assert.throws(
    () => createPaymentEngine({ resolveWebhookSecret: async () => SECRET }),
    { code: "engine_misconfigured" },
  );
});
