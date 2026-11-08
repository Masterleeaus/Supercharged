/**
 * Tests for server/workforce/runtime/provider-idempotency.ts. Pure: no timers, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/provider-idempotency.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerIdempotencyKey, createProviderSendGuard } from '../../server/workforce/runtime/provider-idempotency.ts';
import { idempotencyKey } from '../../server/workforce/runtime/idempotency.ts';

const BASE = {
  companyId: 'co_1',
  runId: 'run_1',
  callIndex: 2,
  toolId: 'sms.send',
  params: { to: '+61400000000', body: 'See you at 9', meta: { retry: null } },
};

test('key is stable for identical inputs, including reordered params keys', () => {
  const a = providerIdempotencyKey(BASE);
  const b = providerIdempotencyKey({
    ...BASE,
    params: { meta: { retry: null }, body: 'See you at 9', to: '+61400000000' },
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('key differs per run', () => {
  assert.notEqual(providerIdempotencyKey(BASE), providerIdempotencyKey({ ...BASE, runId: 'run_2' }));
});

test('key differs per call index', () => {
  assert.notEqual(providerIdempotencyKey(BASE), providerIdempotencyKey({ ...BASE, callIndex: 3 }));
});

test('key differs per company, tool and params', () => {
  const base = providerIdempotencyKey(BASE);
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, companyId: 'co_2' }));
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, toolId: 'email.send' }));
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, params: { ...BASE.params, body: 'changed' } }));
});

test('provider key is domain-separated from the Desk intent key', () => {
  const intent = idempotencyKey({
    companyId: BASE.companyId,
    runId: BASE.runId,
    callIndex: BASE.callIndex,
    tool: BASE.toolId,
    params: BASE.params,
  });
  assert.notEqual(providerIdempotencyKey(BASE), intent);
});

test('guard allows the first send of an intent key and refuses a repeat', () => {
  const guard = createProviderSendGuard();
  const key = providerIdempotencyKey(BASE);
  assert.equal(guard.has(key), false);
  assert.equal(guard.claim(key), true);
  assert.equal(guard.has(key), true);
  assert.equal(guard.claim(key), false);
  assert.equal(guard.claim(key), false);
});

test('guard tracks distinct intents independently', () => {
  const guard = createProviderSendGuard();
  assert.equal(guard.claim(providerIdempotencyKey(BASE)), true);
  assert.equal(guard.claim(providerIdempotencyKey({ ...BASE, callIndex: 3 })), true);
});

test('guard rejects an empty intent key', () => {
  const guard = createProviderSendGuard();
  assert.throws(() => guard.claim(''), TypeError);
});
