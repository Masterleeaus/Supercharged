/**
 * Tests for outbound webhook delivery (server/services/webhook-delivery.ts).
 *
 * Checks three claims:
 *   1. A delivery that exhausts maxAttempts ends with a dead_letter log row.
 *   2. A delivery never retries forever, for any maxAttempts value.
 *   3. A retry writes company_id on its log row.
 *
 * The service imports storage, db, drizzle-orm, the schema and the URL validator.
 * A resolve hook swaps those for in-memory stubs. fetch is stubbed globally.
 * Retry sleeps of 1s or more are shortened to zero and counted, so the tests run fast.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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

// Matches a stub where-clause against a row. Supports eq and and.
function matches(row, cond) {
  if (cond.op === 'eq') return row[cond.k] === cond.v;
  if (cond.op === 'and') return cond.c.every((c) => matches(row, c));
  throw new Error(`unsupported condition ${cond.op}`);
}

globalThis.__db = {
  select() {
    return {
      from(table) {
        return {
          where(cond) {
            const rows = table.__t === 'webhook_logs' ? state.logRows : state.webhookRows;
            return Promise.resolve(rows.filter((r) => matches(r, cond)));
          },
        };
      },
    };
  },
};

const state = {
  webhookRows: [],
  logRows: [],
  written: [],
  fetchCalls: [],
  fetchQueue: [],
  sleeps: [],
};

globalThis.__storage = {
  async getWebhook(id) {
    return state.webhookRows.find((w) => w.id === id);
  },
  async getWebhooksForEvent(userId, event) {
    return state.webhookRows.filter((w) => w.userId === userId && w.events.includes(event));
  },
  async createWebhookLog(log) {
    const row = { id: state.written.length + 100, ...log };
    state.written.push(row);
    return row;
  },
  // Merges a patch into the stored log row with this id. Earlier 'retrying' rows become 'superseded' this way.
  async updateWebhookLog(id, patch) {
    const row = state.written.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    return row;
  },
};

const { WebhookDeliveryService, webhookDeliveryService, listOutboundDeadLetters } =
  await import('../../server/services/webhook-delivery.ts');

const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const MAX_SLEEPS = 20;

function baseWebhook(overrides = {}) {
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
    ...overrides,
  };
}

const payload = { event: 'lead.created', timestamp: '2026-11-03T00:00:00.000Z', data: { id: 1 } };

// Each fetch call takes the next queued outcome: a status number, or an Error to throw.
// When the queue is empty the last outcome repeats.
function queueFetch(...outcomes) {
  state.fetchQueue = outcomes;
}

beforeEach(() => {
  state.webhookRows = [baseWebhook()];
  state.logRows = [];
  state.written = [];
  state.fetchCalls = [];
  state.sleeps = [];
  state.fetchQueue = [500];

  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  globalThis.fetch = async (url, init) => {
    state.fetchCalls.push({ url, init });
    const outcome = state.fetchQueue.length > 1
      ? state.fetchQueue.shift()
      : state.fetchQueue[0];
    if (outcome instanceof Error) throw outcome;
    return new Response('body', { status: outcome });
  };

  // Shorten retry sleeps. Throw after MAX_SLEEPS so a loop that never ends fails the test.
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms >= 1000) {
      state.sleeps.push(ms);
      if (state.sleeps.length > MAX_SLEEPS) {
        throw new Error('runaway: more than 20 retry sleeps');
      }
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
});

const svc = new WebhookDeliveryService();

test('exhausting maxAttempts writes dead_letter on the final attempt only', async () => {
  queueFetch(500);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3);

  assert.equal(state.fetchCalls.length, 3);
  assert.deepEqual(state.written.map((r) => r.attemptNumber), [1, 2, 3]);
  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['superseded', 'superseded', 'dead_letter']);
  assert.equal(state.written[2].error, 'HTTP 500');
  assert.deepEqual(state.sleeps, [60000, 300000]);
});

test('a success before the last attempt stops retries and is marked delivered', async () => {
  queueFetch(500, 200);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 3);

  assert.equal(state.fetchCalls.length, 2);
  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['superseded', 'delivered']);
  assert.equal(state.written[1].success, true);
});

test('network failures on every attempt also end in dead_letter', async () => {
  queueFetch(new TypeError('socket hang up'));
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 2);

  assert.equal(state.fetchCalls.length, 2);
  assert.deepEqual(state.written.map((r) => r.deliveryStatus), ['superseded', 'dead_letter']);
  assert.equal(state.written[1].error, 'socket hang up');
});

test('retries are bounded and end in dead_letter for every maxAttempts value', async () => {
  // Expected attempt counts. Fractional values round down. Values below 1 and
  // non-finite values fall back to a bounded count.
  const cases = [
    [1, 1],
    [2.5, 2],
    [0, 1],
    [-4, 1],
    [NaN, 3],
    [Infinity, 3],
  ];

  for (const [maxAttempts, expectedCalls] of cases) {
    state.written = [];
    state.fetchCalls = [];
    state.sleeps = [];
    queueFetch(500);

    await assert.doesNotReject(
      svc.deliverWithRetry(baseWebhook(), payload, 'c-1', maxAttempts),
      `maxAttempts=${maxAttempts} must not run away`,
    );

    assert.equal(state.fetchCalls.length, expectedCalls, `fetch calls for maxAttempts=${maxAttempts}`);
    assert.equal(
      state.written.at(-1)?.deliveryStatus,
      'dead_letter',
      `final row for maxAttempts=${maxAttempts} must be dead_letter`,
    );
  }
});

test('a retry writes the original log company_id', async () => {
  state.webhookRows = [baseWebhook({ companyId: 'c-9' })];
  state.logRows = [{
    id: 7,
    webhookId: 'wh-1',
    event: 'lead.created',
    payload,
    companyId: 'c-9',
  }];
  queueFetch(200);

  const result = await svc.retryWebhook('c-9', 7, 'u-1');

  assert.equal(result.success, true);
  assert.equal(state.written.length, 1);
  assert.equal(state.written[0].companyId, 'c-9');
});

test('a retry of a legacy log with no company_id falls back to the subscription company', async () => {
  state.webhookRows = [baseWebhook({ companyId: 'c-1' })];
  state.logRows = [{ id: 8, webhookId: 'wh-1', event: 'lead.created', payload, companyId: null }];
  queueFetch(500);

  await svc.retryWebhook('c-1', 8, 'u-1');

  assert.equal(state.written.length, 1);
  assert.equal(state.written[0].companyId, 'c-1');
  assert.equal(state.written[0].deliveryStatus, 'dead_letter');
  assert.equal(state.written[0].maxAttempts, 1);
});

test('triggerEvent delivers only to webhooks of the given company', async () => {
  state.webhookRows = [
    baseWebhook({ id: 'wh-a', companyId: 'c-1' }),
    baseWebhook({ id: 'wh-b', companyId: 'c-2' }),
  ];
  queueFetch(200);

  await svc.triggerEvent('c-1', 'u-1', 'lead.created', { id: 1 });

  assert.deepEqual(state.written.map((r) => r.webhookId), ['wh-a']);
  assert.equal(state.written[0].companyId, 'c-1');
});

test('triggerEvent refuses to dispatch without a company', async () => {
  queueFetch(200);

  await svc.triggerEvent('', 'u-1', 'lead.created', { id: 1 });
  await svc.triggerEvent(undefined, 'u-1', 'lead.created', { id: 1 });

  assert.equal(state.fetchCalls.length, 0);
  assert.equal(state.written.length, 0);
});

test('testWebhook and retryWebhook refuse a missing company', async () => {
  await assert.rejects(svc.testWebhook('', 'wh-1', 'u-1'), /Company context required/);
  await assert.rejects(svc.retryWebhook(undefined, 7, 'u-1'), /Company context required/);
  assert.equal(state.fetchCalls.length, 0);
});

test('testWebhook does not reach a webhook owned by another company', async () => {
  state.webhookRows = [baseWebhook({ companyId: 'c-1' })];

  await assert.rejects(svc.testWebhook('c-2', 'wh-1', 'u-1'), /Webhook not found/);
  assert.equal(state.fetchCalls.length, 0);
});

test('retryWebhook refuses a log that belongs to another company', async () => {
  state.webhookRows = [baseWebhook({ companyId: 'c-1' })];
  state.logRows = [{ id: 9, webhookId: 'wh-1', event: 'lead.created', payload, companyId: 'c-2' }];

  await assert.rejects(svc.retryWebhook('c-1', 9, 'u-1'), /Webhook log not found/);
  assert.equal(state.fetchCalls.length, 0);
});

test('custom headers cannot set reserved names in any casing; other custom headers are kept', async () => {
  queueFetch(200);
  const webhook = baseWebhook({
    headers: {
      'x-webhook-signature': 'sha256=forged',
      AUTHORIZATION: 'Bearer forged',
      'x-webhook-delivery': 'forged-id',
      'Content-Type': 'text/plain',
      'X-Tenant-Tag': 'acme',
    },
  });

  await svc.deliverWithRetry(webhook, payload, 'c-1', 1);

  const h = state.fetchCalls[0].init.headers;
  assert.match(h['X-Webhook-Signature'], /^sha256=[0-9a-f]{64}$/);
  assert.equal(h['x-webhook-signature'], undefined);
  assert.equal(h.Authorization, undefined);
  assert.equal(h['Content-Type'], 'application/json');
  assert.notEqual(h['X-Webhook-Delivery'], 'forged-id');
  assert.equal(h['X-Tenant-Tag'], 'acme');
});

test('each delivery gets its own X-Webhook-Delivery id', async () => {
  queueFetch(200);

  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 1);
  await svc.deliverWithRetry(baseWebhook(), payload, 'c-1', 1);

  const [first, second] = state.fetchCalls.map((c) => c.init.headers['X-Webhook-Delivery']);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test('listOutboundDeadLetters refuses to run without a company', async () => {
  await assert.rejects(listOutboundDeadLetters(''), /requires a companyId/);
  assert.ok(webhookDeliveryService instanceof WebhookDeliveryService);
});
