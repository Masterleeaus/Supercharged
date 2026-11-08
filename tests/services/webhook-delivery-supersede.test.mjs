/**
 * Tests that earlier attempt rows of one outbound delivery stop saying 'retrying'
 * once the delivery ends (server/services/webhook-delivery.ts, deliverWithRetry).
 *
 * Checks:
 *   1. A success after failures marks the earlier rows 'superseded' and the success row 'delivered'.
 *   2. Exhausting attempts leaves exactly one 'dead_letter' row (the last one).
 *   3. All attempts of one delivery share one X-Webhook-Delivery id.
 *   4. A failed update does not stop or throw out of the delivery.
 *
 * No database, network or provider calls. Storage, db, drizzle-orm, the schema and the
 * URL validator are swapped for in-memory stubs by a resolve hook. fetch is stubbed.
 * Retry sleeps of 1s or more run immediately.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Silence console output from the server code. Stdout from a test breaks the test runner IPC.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const HOOK_SOURCE = `
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);

const SCHEMA = \`
export const webhooks = { __t: 'webhooks', id: { __k: 'id' }, userId: { __k: 'userId' }, companyId: { __k: 'companyId' } };
export const webhookLogs = { __t: 'webhook_logs', id: { __k: 'id' }, webhookId: { __k: 'webhookId' }, companyId: { __k: 'companyId' } };
export const Webhook = null;
export const WebhookLog = null;
\`;

const DRIZZLE = \`
export const eq = (col, v) => ({ op: 'eq', k: col.__k, v });
export const and = (...c) => ({ op: 'and', c });
export const desc = (c) => ({ op: 'desc', c });
\`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@shared/schema') return { url: DATA(SCHEMA), shortCircuit: true };
  if (specifier === 'drizzle-orm') return { url: DATA(DRIZZLE), shortCircuit: true };
  if (/(^|\\/)storage$/.test(specifier)) {
    return { url: DATA('export const storage = globalThis.__storage;'), shortCircuit: true };
  }
  if (/(^|\\/)db$/.test(specifier)) {
    return { url: DATA('export const db = globalThis.__db;'), shortCircuit: true };
  }
  if (/url-validator$/.test(specifier)) {
    return {
      url: DATA('export async function validateWebhookUrl() { return { valid: true }; }'),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));

const state = {
  written: [],
  nextId: 100,
  updateFailure: null,
  fetchCalls: [],
  fetchQueue: [],
};

globalThis.__db = {
  select() {
    throw new Error('db must not be used in this test');
  },
};

globalThis.__storage = {
  async getWebhook(id) {
    return { id };
  },
  async createWebhookLog(log) {
    const row = { id: ++state.nextId, ...log };
    state.written.push(row);
    return row;
  },
  async updateWebhookLog(id, patch) {
    if (state.updateFailure) throw state.updateFailure;
    const row = state.written.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  },
};

const { WebhookDeliveryService } = await import('../../server/services/webhook-delivery.ts');

const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;

function baseWebhook() {
  return {
    id: 'wh-1',
    userId: 'u-1',
    url: 'https://hooks.example.test/in',
    method: 'POST',
    secret: 'shh',
    events: ['lead.created'],
    authType: null,
    authCredentials: null,
    headers: null,
    companyId: 'c-1',
  };
}

const payload = { event: 'lead.created', timestamp: '2026-11-04T00:00:00.000Z', data: { id: 1 } };

// Each fetch call takes the next queued status. The last status repeats once the queue is used up.
function queueFetch(...statuses) {
  state.fetchQueue = statuses;
}

beforeEach(() => {
  state.written = [];
  state.nextId = 100;
  state.updateFailure = null;
  state.fetchCalls = [];
  state.fetchQueue = [500];

  globalThis.fetch = async (url, init) => {
    state.fetchCalls.push({ url, init });
    const status = state.fetchQueue.length > 1 ? state.fetchQueue.shift() : state.fetchQueue[0];
    return new Response('body', { status });
  };

  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...args);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

test.after(() => {
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
});

const svc = new WebhookDeliveryService();

test('a success after failures marks earlier rows superseded and the success row delivered', async () => {
  queueFetch(500, 500, 200);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3);

  assert.equal(state.fetchCalls.length, 3);
  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['superseded', 'superseded', 'delivered']);
  assert.deepEqual(state.written.map((r) => r.success), [false, false, true]);
  assert.deepEqual(state.written.map((r) => r.nextRetryAt), [null, null, null]);
  assert.equal(state.written.some((r) => r.deliveryStatus === 'retrying'), false);
});

test('a success on the first attempt leaves no superseded rows', async () => {
  queueFetch(200);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3);

  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['delivered']);
});

test('exhausting attempts leaves only the final row as dead_letter', async () => {
  queueFetch(500);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3);

  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['superseded', 'superseded', 'dead_letter']);
  assert.equal(state.written.filter((r) => r.deliveryStatus === 'dead_letter').length, 1);
  assert.equal(state.written[2].error, 'HTTP 500');
});

test('every attempt of one delivery sends the same X-Webhook-Delivery id', async () => {
  queueFetch(500, 500, 200);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3);

  const ids = new Set(state.fetchCalls.map((c) => c.init.headers['X-Webhook-Delivery']));
  assert.equal(ids.size, 1);
});

test('a failed status update does not throw out of the delivery', async () => {
  state.updateFailure = new Error('connection reset');
  queueFetch(500, 200);

  await assert.doesNotReject(svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3));
  assert.equal(state.fetchCalls.length, 2);
  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['retrying', 'delivered']);
});
