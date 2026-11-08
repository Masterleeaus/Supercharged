// Offline sandbox tests for webhook integrations: tampered and missing signatures,
// replay refusal, retry exhaustion into dead-letter, and unreachable providers.
// No network: fetch is replaced with a stub, and the DB and storage modules are
// replaced with in-memory stubs through a module resolve hook (data: URL, no extra file).
// Run: node --test --experimental-transform-types tests/security/webhook-sandbox.test.mjs
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

const STUB_SCHEMA = `
export const webhooks = {};
export const webhookLogs = {};
export const paymentWebhookQueue = {};
export const plivoCredentials = { authToken: 'authToken', isPrimary: 'isPrimary', isActive: 'isActive' };
export const Webhook = undefined;
export const WebhookLog = undefined;
`;
const STUB_DB = `
export const db = {
  select: () => ({ from: () => ({ where: async () => (globalThis.__sbx?.plivoRows ?? []) }) }),
  // Scheduler claim: moves pending/failed queue rows to 'processing' and returns the claimed ids.
  update: () => ({ set: (values) => ({ where: () => ({ returning: async () => {
    const claimed = [];
    for (const [id, row] of (globalThis.__sbx?.queue ?? new Map()).entries()) {
      if (row.status === 'pending' || row.status === 'failed') { Object.assign(row, values); claimed.push({ id }); }
    }
    return claimed;
  } }) }) }),
};
`;
const STUB_STORAGE = `
const S = () => globalThis.__sbx;
export const storage = {
  getWebhook: async (id) => ({ id }),
  createWebhookLog: async (row) => { S().logs.push(row); return { id: S().logs.length, ...row }; },
  getWebhooksForEvent: async () => S().subscribers,
  getGlobalSetting: async () => null,
  getRetryableWebhooks: async () => [],
  getExpiredWebhooks: async () => [],
  updateWebhookQueueItem: async (id, patch) => { const r = S().queue.get(id); Object.assign(r, patch); S().queueUpdates.push(patch); return r; },
  getWebhookByEventId: async () => null,
  createWebhookQueueItem: async (row) => row,
};
`;
const STUB_DRIZZLE = `
export const eq = (...a) => ({ op: 'eq', a });
export const and = (...a) => ({ op: 'and', a });
export const desc = (x) => ({ op: 'desc', x });
export const sql = (strings, ...values) => ({ strings, values });
`;

// Resolve hook: stubs the three infrastructure modules and drizzle-orm, and resolves
// extensionless relative imports (the app's own style) to .ts files.
const HOOK_SOURCE = `
const STUBS = ${JSON.stringify({
  '@shared/schema': STUB_SCHEMA,
  db: STUB_DB,
  storage: STUB_STORAGE,
  'drizzle-orm': STUB_DRIZZLE,
})};
const toUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@shared/schema') return { url: toUrl(STUBS['@shared/schema']), shortCircuit: true };
  if (specifier === 'drizzle-orm') return { url: toUrl(STUBS['drizzle-orm']), shortCircuit: true };
  if (specifier.startsWith('.') && /(^|\\/)db$/.test(specifier)) return { url: toUrl(STUBS.db), shortCircuit: true };
  if (specifier.startsWith('.') && /(^|\\/)storage$/.test(specifier)) return { url: toUrl(STUBS.storage), shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw err;
  }
}
`;
register('data:text/javascript;base64,' + Buffer.from(HOOK_SOURCE).toString('base64'), import.meta.url);

const load = (rel) => import(new URL('../../' + rel, import.meta.url).href);
const { createReplayGuard } = await load('server/middleware/webhook-replay.ts');
const { WebhookDeliveryService } = await load('server/services/webhook-delivery.ts');
const { WebhookRetryService } = await load('server/services/webhook-retry-service.ts');
const { requirePlivoV2Signature } = await load('server/engines/plivo/plivo-signature.ts');

// ---- shared fixtures -------------------------------------------------------

const PUBLIC_IP_URL = 'https://93.184.216.34/hook'; // public literal: url-validator does no DNS for it
const webhook = {
  id: 'wh_1', url: PUBLIC_IP_URL, method: 'POST', events: ['campaign.completed'],
  secret: 'whsec_test', authType: null, authCredentials: null, headers: null, companyId: 'co_1',
};
const payload = { event: 'campaign.completed', timestamp: new Date(0).toISOString(), data: { n: 1 } };

let realFetch;
let realSetTimeout;
let fetchCalls;

beforeEach(() => {
  // The modules log every delivery. Silence console output: raw writes to stdout corrupt
  // the test runner's child-process message channel and fail the whole file.
  for (const method of ['log', 'warn', 'error', 'info']) mock.method(console, method, () => {});
  realFetch = globalThis.fetch;
  realSetTimeout = globalThis.setTimeout;
  fetchCalls = 0;
  globalThis.__sbx = {
    logs: [], queue: new Map(), queueUpdates: [], subscribers: [webhook], plivoRows: [],
  };
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  delete globalThis.__sbx;
});

// Retry back-off delays (60s, 300s) are recorded and run immediately, so no test waits.
function skipRetryDelays() {
  const delays = [];
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (typeof ms === 'number' && ms >= 1000) {
      delays.push(ms);
      return realSetTimeout(cb, 0, ...args);
    }
    return realSetTimeout(cb, ms, ...args);
  };
  return delays;
}

// Independent reimplementation of the Plivo V2 signing base, used only to build test signatures.
function plivoSignature(url, nonce, body, token) {
  let base = url + nonce;
  for (const key of Object.keys(body).sort()) base += key + String(body[key]);
  return createHmac('sha256', token).update(base, 'utf8').digest('base64');
}

function fakeRes() {
  const res = {
    code: null, sent: false,
    status(c) { this.code = c; return this; },
    send() { this.sent = true; return this; },
  };
  return res;
}

// ---- 1. tampered body fails signature verification --------------------------

test('Plivo V2: a body changed after signing fails verification with 403', async () => {
  const token = 'auth_tok_1';
  globalThis.__sbx.plivoRows = [{ authToken: token, isPrimary: true }];
  const mw = requirePlivoV2Signature('https://app.example.test');
  const url = 'https://app.example.test/api/plivo/webhook';
  const nonce = 'nonce-123';
  const signedBody = { From: '+61400000001', To: '+61400000002', Text: 'book me' };
  const sig = plivoSignature(url, nonce, signedBody, token);

  // Positive control: the untouched body passes, so the negative case is not vacuous.
  let nextCalls = 0;
  await mw({ headers: { 'x-plivo-signature-v2': sig, 'x-plivo-signature-v2-nonce': nonce }, originalUrl: '/api/plivo/webhook', body: signedBody }, fakeRes(), () => { nextCalls++; });
  assert.equal(nextCalls, 1, 'valid signature must reach next()');

  const tampered = { ...signedBody, Text: 'cancel everything' };
  const res = fakeRes();
  let tamperedNext = 0;
  await mw({ headers: { 'x-plivo-signature-v2': sig, 'x-plivo-signature-v2-nonce': nonce }, originalUrl: '/api/plivo/webhook', body: tampered }, res, () => { tamperedNext++; });
  assert.equal(tamperedNext, 0, 'tampered body must not reach the handler');
  assert.equal(res.code, 403);
  assert.equal(res.sent, true);
});

// ---- 2. missing signature fails closed --------------------------------------

test('Plivo V2: missing signature or nonce fails closed with 403 and never calls next()', async () => {
  globalThis.__sbx.plivoRows = [{ authToken: 'auth_tok_1', isPrimary: true }];
  const mw = requirePlivoV2Signature('https://app.example.test');
  const body = { From: '1', To: '2' };

  const noSig = fakeRes();
  let calls = 0;
  await mw({ headers: { 'x-plivo-signature-v2-nonce': 'n' }, originalUrl: '/w', body }, noSig, () => { calls++; });
  assert.equal(noSig.code, 403, 'missing signature header');

  const noNonce = fakeRes();
  await mw({ headers: { 'x-plivo-signature-v2': 'abc' }, originalUrl: '/w', body }, noNonce, () => { calls++; });
  assert.equal(noNonce.code, 403, 'missing nonce header');

  globalThis.__sbx.plivoRows = [];
  const noTokens = fakeRes();
  await mw({ headers: { 'x-plivo-signature-v2': 'abc', 'x-plivo-signature-v2-nonce': 'n' }, originalUrl: '/w', body }, noTokens, () => { calls++; });
  assert.equal(noTokens.code, 403, 'no active credentials');

  assert.equal(calls, 0, 'next() must never run without a verified signature');
});

// ---- 3. replayed event id is rejected ----------------------------------------

test('replay guard: a repeated (provider, eventId) is refused as replay', () => {
  let clock = 1_000_000;
  const guard = createReplayGuard({ now: () => clock, windowMs: 300_000, maxEntries: 100 });
  const input = { provider: 'stripe', eventId: 'evt_123', timestampMs: clock };

  assert.deepEqual(guard.check(input), { accepted: true });
  assert.deepEqual(guard.check(input), { accepted: false, reason: 'replay' });
  // Same id from a different provider is a different event.
  assert.deepEqual(guard.check({ ...input, provider: 'plivo' }), { accepted: true });
  // Missing id fails closed.
  assert.deepEqual(guard.check({ provider: 'stripe', eventId: '', timestampMs: clock }), { accepted: false, reason: 'missing_event_id' });
  // A stale timestamp is refused even with a fresh id.
  assert.deepEqual(
    guard.check({ provider: 'stripe', eventId: 'evt_old', timestampMs: clock - 400_000 }),
    { accepted: false, reason: 'timestamp_out_of_window' },
  );
});

// ---- 4. retries stop at maxAttempts and land in dead-letter -----------------

test('deliverWithRetry: stops at maxAttempts and records the last attempt as dead_letter', async () => {
  globalThis.fetch = async () => { fetchCalls++; return new Response('unavailable', { status: 503 }); };
  const delays = skipRetryDelays();
  const svc = new WebhookDeliveryService();

  await svc.deliverWithRetry(webhook, payload, 'co_1', 3);

  assert.equal(fetchCalls, 3, 'exactly maxAttempts HTTP attempts');
  assert.deepEqual(delays, [60_000, 300_000], 'back-off between attempts only');
  const logs = globalThis.__sbx.logs;
  assert.deepEqual(logs.map((l) => l.attemptNumber), [1, 2, 3]);
  assert.deepEqual(logs.map((l) => l.deliveryStatus), ['retrying', 'retrying', 'dead_letter']);
  assert.ok(logs.every((l) => l.maxAttempts === 3));
  assert.equal(logs[2].nextRetryAt, null, 'no retry scheduled after the final attempt');
});

test('WebhookRetryService queue: an item stops at maxAttempts and is dead-lettered', async () => {
  const row = { id: 1, gateway: 'stripe', eventType: 'invoice.paid', attemptCount: 0, maxAttempts: null, errorHistory: [], status: 'pending' };
  globalThis.__sbx.queue.set(1, row);
  skipRetryDelays();
  const svc = new WebhookRetryService();

  for (let i = 0; i < 7; i++) await svc.processWebhook(row);

  assert.equal(row.status, 'failed', 'dead-letter status');
  assert.equal(row.attemptCount, 5, 'default max attempts');
  const finalUpdates = globalThis.__sbx.queueUpdates.length;
  await svc.processWebhook(row); // extra call after dead-letter must not write again
  assert.equal(globalThis.__sbx.queueUpdates.length, finalUpdates, 'dead-lettered item is not retried');
});

// ---- 5. unreachable provider does not throw an unhandled error ---------------

test('unreachable provider: connection refused resolves to a logged dead letter, no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    globalThis.fetch = async () => {
      fetchCalls++;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    skipRetryDelays();
    const svc = new WebhookDeliveryService();

    await assert.doesNotReject(svc.deliverWithRetry(webhook, payload, 'co_1', 2));
    await assert.doesNotReject(svc.triggerEvent('co_1', 'user_1', 'campaign.completed', { n: 1 }));
    await new Promise((r) => realSetTimeout(r, 10));

    // deliverWithRetry(…, 2) makes 2 attempts; triggerEvent uses the default of 3.
    assert.equal(fetchCalls, 5, '2 attempts + 3 attempts (triggerEvent default)');
    const last = globalThis.__sbx.logs.at(-1);
    assert.equal(last.deliveryStatus, 'dead_letter');
    assert.equal(last.error, 'fetch failed');
    assert.deepEqual(unhandled, [], 'no unhandled rejection escaped');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
