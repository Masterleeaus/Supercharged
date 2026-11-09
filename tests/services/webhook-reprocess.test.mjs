/**
 * Tests for WebhookRetryService.reprocessWebhookEvent (gateway dispatch on retry).
 *
 * The service imports storage, db and the gateway handler modules, and those use
 * extensionless specifiers that plain Node ESM cannot resolve, and they need a live
 * database. A resolve hook registered below swaps those modules for in-memory stubs.
 * The stubbed handler modules record their arguments, so these tests check which handler
 * each event reaches and with which arguments, without running real payment logic.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Silence console output from imported modules: stray stdout breaks the test runner's IPC framing.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const HANDLER_NAMES = {
  stripe: [
    'handleCheckoutSessionCompleted',
    'handleInvoicePaymentSucceeded',
    'handleInvoicePaymentFailed',
    'handleSubscriptionDeleted',
    'handleSubscriptionUpdated',
    'handleChargeDispute',
    'handleChargeRefunded',
  ],
  razorpay: [
    'handleSubscriptionAuthenticated',
    'handleSubscriptionActivated',
    'handleSubscriptionCharged',
    'handleSubscriptionPending',
    'handleSubscriptionHalted',
    'handleSubscriptionCancelled',
    'handleSubscriptionCompleted',
    'handlePaymentCaptured',
    'handlePaymentFailed',
    'handleRefundCreated',
    'handleDispute',
  ],
  paystack: [
    'handleChargeSuccess',
    'handleSubscriptionCreate',
    'handleSubscriptionDisable',
    'handleSubscriptionNotRenew',
    'handleInvoiceCreate',
    'handleInvoicePaymentFailed',
    'handleTransferSuccess',
    'handleTransferFailed',
    'handleRefundProcessed',
    'handleChargeback',
    'handlePaymentRequestPending',
    'handlePaymentRequestSuccess',
  ],
};

// Resolve hook source. Runs before the service is imported.
const HOOK_SOURCE = `
const HANDLER_NAMES = ${JSON.stringify(HANDLER_NAMES)};
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);

function stubModule(names) {
  const lines = [
    'const calls = globalThis.__handlerCalls;',
    'const results = globalThis.__handlerResults;',
  ];
  for (const n of names) {
    lines.push(
      'export async function ' + n + '(...args) {' +
      ' calls.push({ name: ' + JSON.stringify(n) + ', args });' +
      ' const r = results.get(' + JSON.stringify(n) + ');' +
      ' if (r instanceof Error) throw r;' +
      ' return r ?? { success: true, action: ' + JSON.stringify(n) + ' };' +
      ' }'
    );
  }
  return lines.join('\\n');
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@shared/schema') {
    return { url: DATA('export const paymentWebhookQueue = {};'), shortCircuit: true };
  }
  if (/(^|\\/)storage$/.test(specifier)) {
    return { url: DATA('export const storage = globalThis.__storage;'), shortCircuit: true };
  }
  if (/(^|\\/)db$/.test(specifier)) {
    return { url: DATA('export const db = globalThis.__db;'), shortCircuit: true };
  }
  const m = /gateways\\/(stripe|razorpay|paystack)\\/handlers$/.exec(specifier);
  if (m) {
    return { url: DATA(stubModule(HANDLER_NAMES[m[1]])), shortCircuit: true };
  }
  if (/(^|\\/)utils\\/logger$/.test(specifier)) {
    return { url: DATA('export const logger = { debug() {}, info() {}, warn() {}, error() {} };'), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));

globalThis.__handlerCalls = [];
globalThis.__handlerResults = new Map();
globalThis.__storage = {
  updates: [],
  async updateWebhookQueueItem(id, data) { this.updates.push({ id, data }); },
};
// Fake of db.update(...).set().where().returning(). It records each claim in __log, in order,
// alongside handler calls, so tests can check the claim runs before the handler.
// globalThis.__claimResult decides whether the claim wins (true) or loses to another attempt (false).
globalThis.__log = [];
globalThis.__claimResult = true;
globalThis.__db = {
  update() {
    return {
      set(values) {
        return {
          where() {
            return {
              async returning() {
                globalThis.__log.push({ kind: 'claim', values });
                return globalThis.__claimResult ? [{ id: 42 }] : [];
              },
            };
          },
        };
      },
    };
  },
};

const { webhookRetryService } = await import('../../server/services/webhook-retry-service.ts');

function webhook(gateway, eventType, payload, extra = {}) {
  return { id: 42, gateway, eventType, payload, attemptCount: 0, maxAttempts: 5, ...extra };
}

function reprocess(item) {
  // reprocessWebhookEvent is private in TypeScript only; it is a normal method at runtime.
  return webhookRetryService.reprocessWebhookEvent(item);
}

beforeEach(() => {
  globalThis.__handlerCalls.length = 0;
  globalThis.__handlerResults.clear();
  globalThis.__storage.updates.length = 0;
  globalThis.__log.length = 0;
  globalThis.__claimResult = true;
});

test('gateways without a handler still fail with the original message', async () => {
  for (const [gateway, eventType] of [
    ['paypal', 'PAYMENT.CAPTURE.COMPLETED'],
    ['mercadopago', 'payment'],
    ['yookassa', 'payment.succeeded'],
  ]) {
    const result = await reprocess(webhook(gateway, eventType, {}));
    assert.equal(result.success, false);
    assert.equal(result.error, `Reprocessing not implemented for ${gateway} event ${eventType}`);
  }
  assert.equal(globalThis.__handlerCalls.length, 0);
});

test('a gateway name that is an Object.prototype key is treated as unimplemented', async () => {
  const result = await reprocess(webhook('constructor', 'x', {}));
  assert.equal(result.success, false);
  assert.match(result.error, /Reprocessing not implemented for constructor/);
});

test('stripe: event reaches its handler with the queued data object', async () => {
  const object = { id: 'cs_1', metadata: { userId: 'u1' } };
  const result = await reprocess(webhook('stripe', 'checkout.session.completed', object));
  assert.deepEqual(result, { success: true });
  assert.equal(globalThis.__handlerCalls.length, 1);
  assert.equal(globalThis.__handlerCalls[0].name, 'handleCheckoutSessionCompleted');
  assert.equal(globalThis.__handlerCalls[0].args[0], object);
});

test('stripe: unrecognised event type succeeds as unhandled, matching the live route', async () => {
  const result = await reprocess(webhook('stripe', 'customer.created', {}));
  assert.deepEqual(result, { success: true });
  assert.equal(globalThis.__handlerCalls.length, 0);
});

test('stripe: a handler failure result is returned as a failure with its error', async () => {
  globalThis.__handlerResults.set('handleInvoicePaymentSucceeded', { success: false, error: 'Plan not found' });
  const result = await reprocess(webhook('stripe', 'invoice.payment_succeeded', {}));
  assert.deepEqual(result, { success: false, error: 'Plan not found' });
});

test('stripe: a thrown handler error becomes a failure result, not an exception', async () => {
  globalThis.__handlerResults.set('handleChargeRefunded', new Error('db unavailable'));
  const result = await reprocess(webhook('stripe', 'charge.refunded', {}));
  assert.deepEqual(result, { success: false, error: 'db unavailable' });
});

test('razorpay: subscription.activated passes subscription and payment entities', async () => {
  const payload = {
    subscription: { entity: { id: 'sub_1', notes: { userId: 'u1' } } },
    payment: { entity: { id: 'pay_1' } },
  };
  const result = await reprocess(webhook('razorpay', 'subscription.activated', payload));
  assert.deepEqual(result, { success: true });
  const [call] = globalThis.__handlerCalls;
  assert.equal(call.name, 'handleSubscriptionActivated');
  assert.equal(call.args[0], payload.subscription.entity);
  assert.equal(call.args[1], payload.payment.entity);
});

test('razorpay: subscription.authenticated takes no arguments', async () => {
  const result = await reprocess(webhook('razorpay', 'subscription.authenticated', {}));
  assert.deepEqual(result, { success: true });
  assert.equal(globalThis.__handlerCalls[0].name, 'handleSubscriptionAuthenticated');
  assert.equal(globalThis.__handlerCalls[0].args.length, 0);
});

test('razorpay: refund.created passes refund and payment entities', async () => {
  const payload = { refund: { entity: { id: 'rfnd_1' } }, payment: { entity: { id: 'pay_2' } } };
  await reprocess(webhook('razorpay', 'refund.created', payload));
  const [call] = globalThis.__handlerCalls;
  assert.equal(call.name, 'handleRefundCreated');
  assert.equal(call.args[0], payload.refund.entity);
  assert.equal(call.args[1], payload.payment.entity);
});

test('razorpay: all three dispute events go to handleDispute with dispute and payment', async () => {
  for (const eventType of ['payment.dispute.created', 'payment.dispute.won', 'payment.dispute.lost']) {
    globalThis.__handlerCalls.length = 0;
    const payload = { dispute: { entity: { id: 'disp_1' } }, payment: { entity: { id: 'pay_3' } } };
    await reprocess(webhook('razorpay', eventType, payload));
    assert.equal(globalThis.__handlerCalls[0].name, 'handleDispute', eventType);
    assert.equal(globalThis.__handlerCalls[0].args[0], payload.dispute.entity, eventType);
  }
});

test('paystack: event reaches its handler with the queued data object', async () => {
  const data = { reference: 'ref_1' };
  const result = await reprocess(webhook('paystack', 'charge.success', data));
  assert.deepEqual(result, { success: true });
  assert.equal(globalThis.__handlerCalls[0].name, 'handleChargeSuccess');
  assert.equal(globalThis.__handlerCalls[0].args[0], data);
});

test('paystack: the three chargeback events all reach handleChargeback', async () => {
  for (const eventType of ['charge.dispute.create', 'charge.dispute.remind', 'charge.dispute.resolve']) {
    globalThis.__handlerCalls.length = 0;
    await reprocess(webhook('paystack', eventType, {}));
    assert.equal(globalThis.__handlerCalls[0].name, 'handleChargeback', eventType);
  }
});

test('processWebhook marks a retried stripe event completed on success', async () => {
  await webhookRetryService.processWebhook(webhook('stripe', 'charge.refunded', { id: 'ch_1' }));
  const [update] = globalThis.__storage.updates.slice(-1);
  assert.equal(update.id, 42);
  assert.equal(update.data.status, 'completed');
  assert.equal(update.data.attemptCount, 1);
});

test('processWebhook dead-letters a razorpay event on its final failed attempt', async () => {
  globalThis.__handlerResults.set('handlePaymentFailed', new Error('still broken'));
  await webhookRetryService.processWebhook(
    webhook('razorpay', 'payment.failed', { payment: { entity: {} } }, { attemptCount: 4 }),
  );
  const [update] = globalThis.__storage.updates.slice(-1);
  assert.equal(update.data.status, 'failed');
  assert.equal(update.data.attemptCount, 5);
  assert.equal(update.data.lastError, 'still broken');
});

test('processWebhook keeps an unimplemented gateway pending until it dead-letters', async () => {
  await webhookRetryService.processWebhook(webhook('paypal', 'PAYMENT.CAPTURE.COMPLETED', {}));
  const [update] = globalThis.__storage.updates.slice(-1);
  assert.equal(update.data.status, 'pending');
  assert.match(update.data.lastError, /Reprocessing not implemented for paypal/);
});

test('scheduler: claims the row to processing before the handler runs', async () => {
  await webhookRetryService.processWebhook(webhook('stripe', 'charge.refunded', { id: 'ch_1' }));
  assert.equal(globalThis.__log[0].kind, 'claim');
  assert.equal(globalThis.__log[0].values.status, 'processing');
  assert.ok(globalThis.__log[0].values.lastAttemptAt instanceof Date);
  assert.equal(globalThis.__handlerCalls.length, 1);
  assert.equal(globalThis.__handlerCalls[0].name, 'handleChargeRefunded');
});

test('scheduler: a lost claim runs no handler and writes no outcome', async () => {
  globalThis.__claimResult = false;
  await webhookRetryService.processWebhook(webhook('stripe', 'charge.refunded', { id: 'ch_1' }));
  assert.equal(globalThis.__log.length, 1);
  assert.equal(globalThis.__handlerCalls.length, 0);
  assert.equal(globalThis.__storage.updates.length, 0);
});

test('scheduler: a lost claim on a failing event does not dead-letter or reschedule it', async () => {
  globalThis.__claimResult = false;
  globalThis.__handlerResults.set('handlePaymentFailed', new Error('boom'));
  await webhookRetryService.processWebhook(
    webhook('razorpay', 'payment.failed', { payment: { entity: {} } }, { attemptCount: 4 }),
  );
  assert.equal(globalThis.__handlerCalls.length, 0);
  assert.equal(globalThis.__storage.updates.length, 0);
});

test('scheduler: a dead-lettered row is skipped before any claim is attempted', async () => {
  await webhookRetryService.processWebhook(
    webhook('stripe', 'charge.refunded', {}, { status: 'failed', attemptCount: 5 }),
  );
  assert.equal(globalThis.__log.length, 0);
  assert.equal(globalThis.__handlerCalls.length, 0);
});

test('scheduler: a row already completed by another attempt is not re-run', async () => {
  globalThis.__claimResult = false;
  await webhookRetryService.processWebhook(webhook('stripe', 'charge.refunded', {}, { status: 'completed' }));
  assert.equal(globalThis.__log.length, 1);
  assert.equal(globalThis.__handlerCalls.length, 0);
});
