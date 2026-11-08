/**
 * Tests for WebhookRetryService.reprocessForCompany (operator replay, company-scoped).
 *
 * Storage, db, the queue schema and the Stripe handler module are replaced by in-memory fakes
 * through a resolve hook. No database, network or payment provider is touched.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Silence console output from imported modules: stray stdout breaks the test runner's IPC framing.
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};

// The resolve hook runs on its own thread, so globalThis is not shared with this file.
// The stub sources are therefore embedded in the hook module's text.
const STUB_SRC = {
  schema: 'export const paymentWebhookQueue = {};',
  db: 'export const db = { update(table) { return globalThis.__fakeDb.update(table); } };',
  storage: 'export const storage = globalThis.__fakeStorage;',
  stripe:
    'export async function handleChargeRefunded(...args) {' +
    ' globalThis.__stripeCalls.push(args);' +
    ' return globalThis.__stripeResult;' +
    ' }',
};

// Self-contained: serialised with toString() into the hook module, which reads the embedded STUB_SRC.
function resolveImpl(specifier, context, nextResolve) {
  const url = (src) => 'data:text/javascript,' + encodeURIComponent(src);
  if (specifier === '@shared/schema') return { url: url(STUB_SRC.schema), shortCircuit: true };
  if (/(^|\/)storage$/.test(specifier)) return { url: url(STUB_SRC.storage), shortCircuit: true };
  if (/(^|\/)db$/.test(specifier)) return { url: url(STUB_SRC.db), shortCircuit: true };
  if (/gateways\/stripe\/handlers$/.test(specifier)) return { url: url(STUB_SRC.stripe), shortCircuit: true };
  return nextResolve(specifier, context);
}

const HOOK_SOURCE =
  'const STUB_SRC = ' + JSON.stringify(STUB_SRC) + ';\n' +
  'export const resolve = ' + resolveImpl.toString() + ';';

register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));

globalThis.__rows = new Map();
globalThis.__updates = [];
globalThis.__stripeCalls = [];
globalThis.__stripeResult = { success: true };
// Simulates a concurrent replay: when set, the row flips to 'processing' right after it is read.
globalThis.__flipOnGet = null;
globalThis.__fakeStorage = {
  async getWebhookQueueItem(id) {
    const item = globalThis.__rows.get(id);
    if (item && globalThis.__flipOnGet) {
      item.status = globalThis.__flipOnGet;
      globalThis.__flipOnGet = null;
    }
    return item;
  },
  async updateWebhookQueueItem(id, data) {
    globalThis.__updates.push({ id, data });
  },
};
// Fake of db.update(...).set().where().returning(). The claim succeeds only for rows that are still
// pending or failed, mirroring the SQL predicate in the service (the where clause is not parsed here).
globalThis.__fakeDb = {
  update() {
    return {
      set(values) {
        return {
          where() {
            return {
              async returning() {
                const claimed = [];
                for (const row of globalThis.__rows.values()) {
                  if (row.status === 'pending' || row.status === 'failed') {
                    Object.assign(row, values);
                    claimed.push({ id: row.id });
                  }
                }
                return claimed;
              },
            };
          },
        };
      },
    };
  },
};

const { webhookRetryService } = await import('../../server/services/webhook-retry-service.ts');

function row(overrides = {}) {
  return {
    id: 'wh_1',
    companyId: 'co_a',
    gateway: 'stripe',
    eventType: 'charge.refunded',
    payload: { id: 'ch_1' },
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    errorHistory: [],
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.__rows.clear();
  globalThis.__updates.length = 0;
  globalThis.__stripeCalls.length = 0;
  globalThis.__stripeResult = { success: true };
  globalThis.__flipOnGet = null;
});

test('refuses when the company is missing', async () => {
  globalThis.__rows.set('wh_1', row());
  const out = await webhookRetryService.reprocessForCompany('', 'wh_1');
  assert.deepEqual(out, { ok: false, reason: 'missing_scope' });
  assert.equal(globalThis.__stripeCalls.length, 0);
  assert.equal(globalThis.__updates.length, 0);
});

test('refuses when the queue id is missing', async () => {
  const out = await webhookRetryService.reprocessForCompany('co_a', '');
  assert.deepEqual(out, { ok: false, reason: 'missing_scope' });
});

test('an unknown queue id is reported as not found', async () => {
  const out = await webhookRetryService.reprocessForCompany('co_a', 'nope');
  assert.deepEqual(out, { ok: false, reason: 'not_found' });
  assert.equal(globalThis.__stripeCalls.length, 0);
});

test('an event owned by another company is reported as not found and never runs', async () => {
  globalThis.__rows.set('wh_1', row({ companyId: 'co_b' }));
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: false, reason: 'not_found' });
  assert.equal(globalThis.__stripeCalls.length, 0);
  assert.equal(globalThis.__updates.length, 0);
});

test('an event with no company is reported as not found (fails closed)', async () => {
  globalThis.__rows.set('wh_1', row({ companyId: null }));
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: false, reason: 'not_found' });
  assert.equal(globalThis.__stripeCalls.length, 0);
});

test('a completed event is refused so it is not run twice', async () => {
  globalThis.__rows.set('wh_1', row({ status: 'completed' }));
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: false, reason: 'not_replayable' });
  assert.equal(globalThis.__stripeCalls.length, 0);
});

test('a processing event is refused while another attempt may be running', async () => {
  globalThis.__rows.set('wh_1', row({ status: 'processing' }));
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: false, reason: 'not_replayable' });
});

test('own pending event reaches the stripe handler with the stored object and is marked completed', async () => {
  globalThis.__rows.set('wh_1', row());
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: true, status: 'completed' });
  assert.deepEqual(globalThis.__stripeCalls[0], [{ id: 'ch_1' }]);
  const last = globalThis.__updates.at(-1);
  assert.equal(last.id, 'wh_1');
  assert.equal(last.data.status, 'completed');
  assert.equal(last.data.attemptCount, 1);
});

test('a failing handler on the last allowed attempt dead-letters the event and reports it', async () => {
  globalThis.__stripeResult = { success: false, error: 'still broken' };
  globalThis.__rows.set('wh_1', row({ attemptCount: 4 }));
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: true, status: 'failed' });
  const last = globalThis.__updates.at(-1);
  assert.equal(last.data.status, 'failed');
  assert.equal(last.data.attemptCount, 5);
  assert.equal(last.data.lastError, 'still broken');
});

test('an own dead-lettered event can be replayed by an operator and completes', async () => {
  globalThis.__rows.set('wh_1', row({ status: 'failed', attemptCount: 5 }));
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: true, status: 'completed' });
  assert.equal(globalThis.__stripeCalls.length, 1);
  assert.equal(globalThis.__updates.at(-1).data.attemptCount, 6);
});

test('a replay that loses the claim to a concurrent replay runs no handler', async () => {
  globalThis.__rows.set('wh_1', row());
  globalThis.__flipOnGet = 'processing';
  const out = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(out, { ok: false, reason: 'not_replayable' });
  assert.equal(globalThis.__stripeCalls.length, 0);
  assert.equal(globalThis.__updates.length, 0);
});

test('a second replay of an already completed event does not run the handler again', async () => {
  globalThis.__rows.set('wh_1', row());
  const first = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(first, { ok: true, status: 'completed' });
  const second = await webhookRetryService.reprocessForCompany('co_a', 'wh_1');
  assert.deepEqual(second, { ok: false, reason: 'not_replayable' });
  assert.equal(globalThis.__stripeCalls.length, 1);
});
