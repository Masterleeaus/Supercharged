// Offline sandbox tests for Stripe webhook signature verification.
// Exercises verifyStripeWebhookEvent (server/engines/payment/gateways/stripe/webhook-verify.ts),
// backed by the real stripe SDK's webhooks.constructEvent. Signatures are built with node:crypto
// using the Stripe scheme: HMAC-SHA256 over "<t>.<payload>", sent as "t=<t>,v1=<hex>".
// No network and no server are started.
// Run: node --test --experimental-transform-types tests/security/stripe-sandbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import {
  verifyStripeWebhookEvent,
  StripeWebhookSecretMissingError,
} from '../../server/engines/payment/gateways/stripe/webhook-verify.ts';

const TEST_SECRET = 'whsec_test_sandbox_secret_do_not_use';
const stripe = new Stripe('sk_test_sandbox_offline');

const body = JSON.stringify({
  id: 'evt_test_sandbox_1',
  object: 'event',
  type: 'checkout.session.completed',
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: 'cs_test_sandbox_1' } },
});

function sign(payload, secret, timestampSeconds) {
  const sig = createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`, 'utf8').digest('hex');
  return `t=${timestampSeconds},v1=${sig}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

test('tampered body fails verification', () => {
  const header = sign(body, TEST_SECRET, nowSeconds());
  const tampered = body.replace('checkout.session.completed', 'payment_intent.succeeded');
  assert.notEqual(tampered, body);
  assert.throws(
    () => verifyStripeWebhookEvent(stripe, tampered, header, TEST_SECRET),
    (err) => err && err.type === 'StripeSignatureVerificationError'
  );
});

test('expired timestamp fails verification', () => {
  const oldTimestamp = nowSeconds() - 3600; // one hour old, default tolerance is 300 seconds
  const header = sign(body, TEST_SECRET, oldTimestamp);
  assert.throws(
    () => verifyStripeWebhookEvent(stripe, body, header, TEST_SECRET),
    (err) => err && err.type === 'StripeSignatureVerificationError' && /timestamp/i.test(err.message)
  );
});

test('missing signature fails closed', () => {
  assert.throws(() => verifyStripeWebhookEvent(stripe, body, '', TEST_SECRET), /Missing Stripe-Signature/);
  assert.throws(() => verifyStripeWebhookEvent(stripe, body, undefined, TEST_SECRET), /Missing Stripe-Signature/);
});

test('missing webhook secret fails closed', () => {
  const header = sign(body, TEST_SECRET, nowSeconds());
  for (const secret of [undefined, null, '', '   ']) {
    assert.throws(
      () => verifyStripeWebhookEvent(stripe, body, header, secret),
      StripeWebhookSecretMissingError
    );
  }
});

test('valid signature with the test secret passes', () => {
  const header = sign(body, TEST_SECRET, nowSeconds());
  const event = verifyStripeWebhookEvent(stripe, body, header, TEST_SECRET);
  assert.equal(event.id, 'evt_test_sandbox_1');
  assert.equal(event.type, 'checkout.session.completed');
});
