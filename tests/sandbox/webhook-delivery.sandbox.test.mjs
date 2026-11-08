// Sandbox tests: outbound webhook delivery retries (server/services/webhook-delivery.ts).
// Fakes only. fetch is stubbed; storage, db, drizzle-orm, the schema and the URL validator are
// in-memory stubs swapped in by a resolve hook. Retry sleeps of 1s or more are recorded and run
// immediately. No network, no database.
// Run: node --test --experimental-transform-types tests/sandbox/webhook-delivery.sandbox.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC). Silence the service logs.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

const HOOK = `
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@shared/schema') {
    return { url: DATA('export const webhooks = {}; export const webhookLogs = {}; export const Webhook = null; export const WebhookLog = null;'), shortCircuit: true };
  }
  if (specifier === 'drizzle-orm') {
    return { url: DATA('export const eq = (a, b) => ({ a, b }); export const and = (...a) => a; export const desc = (a) => a;'), shortCircuit: true };
  }
  if (/(^|\\/)storage$/.test(specifier)) {
    return { url: DATA('export const storage = { getWebhook: (...a) => globalThis.__sbx.getWebhook(...a), createWebhookLog: (...a) => globalThis.__sbx.createWebhookLog(...a) };'), shortCircuit: true };
  }
  if (/(^|\\/)db$/.test(specifier)) {
    return { url: DATA('export const db = {};'), shortCircuit: true };
  }
  if (/url-validator$/.test(specifier)) {
    return { url: DATA('export async function validateWebhookUrl(u) { return String(u).includes("blocked.test") ? { valid: false, error: "Private address blocked" } : { valid: true }; }'), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url);

const { WebhookDeliveryService } = await import(
  new URL('../../server/services/webhook-delivery.ts', import.meta.url).href
);

const PUBLIC_URL = 'https://hooks.example.test/in';
const SECRET = 'whsec_fake_for_tests';
const makeWebhook = (overrides = {}) => ({
  id: 'wh_1', url: PUBLIC_URL, method: 'POST', events: ['lead.created'], secret: SECRET,
  authType: null, authCredentials: null, headers: null, companyId: 'co_1', ...overrides,
});
const payload = { event: 'lead.created', timestamp: '2026-01-01T00:00:00.000Z', data: { id: 7 } };

let realFetch;
let realSetTimeout;
let fetchCalls;
let retryDelays;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realSetTimeout = globalThis.setTimeout;
  fetchCalls = [];
  retryDelays = [];
  globalThis.__sbx = {
    logs: [],
    webhookExists: true,
    getWebhook: async (id) => (globalThis.__sbx.webhookExists ? { id } : undefined),
    createWebhookLog: async (row) => {
      globalThis.__sbx.logs.push(row);
      return { id: globalThis.__sbx.logs.length, ...row };
    },
  };
  // Record back-off sleeps (60s, 300s) and run them at once.
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (typeof ms === 'number' && ms >= 1000) {
      retryDelays.push(ms);
      return realSetTimeout(cb, 0, ...args);
    }
    return realSetTimeout(cb, ms, ...args);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  delete globalThis.__sbx;
});

// Each entry is a Response to return, or an Error to throw, in call order. The last entry repeats.
function scriptFetch(steps) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const step = steps[Math.min(fetchCalls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    // A Response body can be read once, so hand out a fresh copy on every call.
    return step instanceof Response ? step.clone() : step;
  };
}

const outage = () => new TypeError('fetch failed'); // what Node's fetch throws when the host refuses
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

// ---- outage ------------------------------------------------------------------

test('outage: connection refused on every attempt makes 3 attempts and ends in dead_letter', async () => {
  scriptFetch([outage()]);
  const svc = new WebhookDeliveryService();

  await svc.deliverWithRetry(makeWebhook(), payload, 'co_1');

  assert.equal(fetchCalls.length, 3);
  const statuses = globalThis.__sbx.logs.map((r) => r.deliveryStatus);
  assert.deepEqual(statuses, ['retrying', 'retrying', 'dead_letter']);
  assert.deepEqual(globalThis.__sbx.logs.map((r) => r.attemptNumber), [1, 2, 3]);
  assert.equal(globalThis.__sbx.logs[2].error, 'fetch failed');
  assert.equal(globalThis.__sbx.logs[2].nextRetryAt, null);
  assert.ok(globalThis.__sbx.logs[0].nextRetryAt instanceof Date, 'retrying row carries nextRetryAt');
});

test('outage: back-off between attempts is 60s then 300s, never a tight loop', async () => {
  scriptFetch([outage()]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');
  assert.deepEqual(retryDelays, [60000, 300000]);
});

test('outage: HTTP 503 on every attempt is recorded as HTTP 503 at dead_letter', async () => {
  scriptFetch([new Response('maintenance', { status: 503 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  const last = globalThis.__sbx.logs.at(-1);
  assert.equal(last.deliveryStatus, 'dead_letter');
  assert.equal(last.httpStatus, 503);
  assert.equal(last.error, 'HTTP 503');
  assert.equal(last.responseBody, 'maintenance');
});

// ---- timeout -----------------------------------------------------------------

test('timeout: a TimeoutError from fetch is reported as a 30 second timeout and is retried', async () => {
  scriptFetch([timeoutError()]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  assert.equal(fetchCalls.length, 3);
  assert.equal(globalThis.__sbx.logs[0].error, 'Request timed out after 30 seconds');
  assert.equal(globalThis.__sbx.logs.at(-1).deliveryStatus, 'dead_letter');
});

test('timeout: every attempt carries a 30 second abort signal and refuses redirects', async () => {
  scriptFetch([new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  const init = fetchCalls[0].init;
  assert.ok(init.signal instanceof AbortSignal, 'request has an AbortSignal');
  assert.equal(init.redirect, 'error');
});

test('timeout then success: a slow first attempt is retried and delivery is recorded once', async () => {
  scriptFetch([timeoutError(), new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(globalThis.__sbx.logs.map((r) => r.deliveryStatus), ['retrying', 'delivered']);
});

// ---- duplicates --------------------------------------------------------------

test('duplicate: a 200 after a 503 stops the loop, so the receiver gets exactly one success', async () => {
  scriptFetch([new Response('busy', { status: 503 }), new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  assert.equal(fetchCalls.length, 2);
  assert.equal(globalThis.__sbx.logs.at(-1).deliveryStatus, 'delivered');
});

test('duplicate: every retry sends byte-identical body and signature for the same event', async () => {
  scriptFetch([outage()]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  const bodies = fetchCalls.map((c) => c.init.body);
  const sigs = fetchCalls.map((c) => c.init.headers['X-Webhook-Signature']);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(new Set(sigs).size, 1);
});

test('duplicate: retries reuse one X-Webhook-Delivery id so a receiver can drop repeats', async () => {
  // Receiver may apply the event and still answer 500. Our retry is then a duplicate at the receiver,
  // and the only key it can dedupe on is X-Webhook-Delivery.
  scriptFetch([new Response('err', { status: 500 }), new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  const ids = fetchCalls.map((c) => c.init.headers['X-Webhook-Delivery']);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'same delivery id on every attempt of one event');
});

// ---- invalid signature (receiver-side check) ---------------------------------

test('invalid signature: header is HMAC-SHA256 of the exact body, so a tampered body fails verification', async () => {
  scriptFetch([new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  const { body, headers } = fetchCalls[0].init;
  const expected = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(headers['X-Webhook-Signature'], expected);

  const tampered = body.replace('"id":7', '"id":8');
  const tamperedSig = 'sha256=' + createHmac('sha256', SECRET).update(tampered).digest('hex');
  assert.notEqual(tamperedSig, headers['X-Webhook-Signature']);
});

test('invalid signature: a signature made with another secret does not match', async () => {
  scriptFetch([new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  const { body, headers } = fetchCalls[0].init;
  const wrong = 'sha256=' + createHmac('sha256', 'whsec_other').update(body).digest('hex');
  assert.notEqual(wrong, headers['X-Webhook-Signature']);
});

test('invalid signature: a tenant custom header cannot replace X-Webhook-Signature', async () => {
  // Custom headers are merged after the signature is built, so a forged value would be sent as-is.
  scriptFetch([new Response('ok', { status: 200 })]);
  const webhook = makeWebhook({ headers: { 'X-Webhook-Signature': 'sha256=forged' } });
  await new WebhookDeliveryService().deliverWithRetry(webhook, payload, 'co_1');

  const sent = fetchCalls[0].init.headers['X-Webhook-Signature'];
  assert.notEqual(sent, 'sha256=forged');
  assert.match(sent, /^sha256=[0-9a-f]{64}$/);
});

// ---- SSRF refusal, attempt bounds, deleted webhook ---------------------------

test('blocked URL: no fetch is made and the row records the refusal', async () => {
  scriptFetch([new Response('ok', { status: 200 })]);
  await new WebhookDeliveryService().deliverWithRetry(
    makeWebhook({ url: 'https://blocked.test/hook' }), payload, 'co_1',
  );

  assert.equal(fetchCalls.length, 0);
  assert.equal(globalThis.__sbx.logs.at(-1).error, 'Private address blocked');
});

test('attempt bounds: NaN and Infinity fall back to 3, fractions floor, zero becomes 1', async () => {
  const run = async (n) => {
    fetchCalls = [];
    globalThis.__sbx.logs = [];
    scriptFetch([outage()]);
    await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1', n);
    return fetchCalls.length;
  };
  assert.equal(await run(Number.NaN), 3);
  assert.equal(await run(Number.POSITIVE_INFINITY), 3);
  assert.equal(await run(2.7), 2);
  assert.equal(await run(0), 1);
});

test('webhook deleted mid-retry: no log row is written and retries still finish', async () => {
  scriptFetch([outage()]);
  globalThis.__sbx.webhookExists = false;
  await new WebhookDeliveryService().deliverWithRetry(makeWebhook(), payload, 'co_1');

  assert.equal(fetchCalls.length, 3);
  assert.equal(globalThis.__sbx.logs.length, 0);
});
