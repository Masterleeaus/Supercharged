/**
 * Tests for server/workforce/runtime/idempotency.ts. Injected clock only, no real timers, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/idempotency.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotencyKey,
  createIdempotencyStore,
  idempotencyInsertSql,
} from '../../server/workforce/runtime/idempotency.ts';

const BASE = {
  companyId: 'co_1',
  runId: 'run_1',
  callIndex: 2,
  tool: 'booking.create',
  params: { customer: { name: 'Ada', phone: '+61400000000' }, slots: [1, 2], note: null },
};

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const TTL = 60_000;

test('same inputs give the same key, regardless of object key order', () => {
  const reordered = {
    params: { note: null, slots: [1, 2], customer: { phone: '+61400000000', name: 'Ada' } },
    tool: 'booking.create',
    callIndex: 2,
    runId: 'run_1',
    companyId: 'co_1',
  };
  const a = idempotencyKey(BASE);
  assert.equal(a, idempotencyKey({ ...BASE }));
  assert.equal(a, idempotencyKey(reordered));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('changing any single field changes the key', () => {
  const base = idempotencyKey(BASE);
  const variants = [
    { ...BASE, companyId: 'co_2' },
    { ...BASE, runId: 'run_2' },
    { ...BASE, callIndex: 3 },
    { ...BASE, tool: 'message.send' },
    { ...BASE, params: { ...BASE.params, note: 'changed' } },
    { ...BASE, params: { ...BASE.params, slots: [2, 1] } },
    { ...BASE, params: { ...BASE.params, customer: { name: 'Ada', phone: '+61400000001' } } },
    { ...BASE, params: { ...BASE.params, note: undefined } },
  ];
  const keys = variants.map((v) => idempotencyKey(v));
  for (const k of keys) assert.notEqual(k, base);
  assert.equal(new Set(keys).size, keys.length, 'variants should not collide with each other');
});

test('a repeat claim within ttl is refused and returns the previous outcome', () => {
  const store = createIdempotencyStore();
  const key = idempotencyKey(BASE);

  assert.deepEqual(store.claim(key, { now: T0, ttlMs: TTL, companyId: 'co_1' }), { claimed: true });
  store.complete(key, { bookingId: 'b_42' }, { companyId: 'co_1' });

  const again = store.claim(key, { now: T0 + 1000, ttlMs: TTL, companyId: 'co_1' });
  assert.equal(again.claimed, false);
  assert.equal(again.previous.companyId, 'co_1');
  assert.deepEqual(again.previous.outcome, { bookingId: 'b_42' });
});

test('a claim after ttl expiry is allowed again, and an earlier claim inside ttl is not', () => {
  const store = createIdempotencyStore();
  const key = idempotencyKey(BASE);

  store.claim(key, { now: T0, ttlMs: TTL, companyId: 'co_1' });
  const justBefore = store.claim(key, { now: T0 + TTL - 1, ttlMs: TTL, companyId: 'co_1' });
  assert.equal(justBefore.claimed, false);

  assert.deepEqual(store.claim(key, { now: T0 + TTL, ttlMs: TTL, companyId: 'co_1' }), { claimed: true });
});

test('complete from another company is refused and does not overwrite the outcome', () => {
  const store = createIdempotencyStore();
  const key = idempotencyKey(BASE);
  store.claim(key, { now: T0, ttlMs: TTL, companyId: 'co_1' });

  assert.throws(
    () => store.complete(key, { charged: 'by co_2' }, { companyId: 'co_2' }),
    (err) => err.name === 'IdempotencyError' && err.code === 'company_mismatch',
  );

  store.complete(key, { charged: 'by co_1' }, { companyId: 'co_1' });
  const repeat = store.claim(key, { now: T0 + 1, ttlMs: TTL, companyId: 'co_1' });
  assert.deepEqual(repeat.previous.outcome, { charged: 'by co_1' });
});

test('complete for an unclaimed key, or a second complete, is refused', () => {
  const store = createIdempotencyStore();
  const key = idempotencyKey(BASE);

  assert.throws(
    () => store.complete(key, 'x', { companyId: 'co_1' }),
    (err) => err.code === 'not_claimed',
  );

  store.claim(key, { now: T0, ttlMs: TTL, companyId: 'co_1' });
  store.complete(key, 'first', { companyId: 'co_1' });
  assert.throws(
    () => store.complete(key, 'second', { companyId: 'co_1' }),
    (err) => err.code === 'already_completed',
  );
});

test('insert SQL uses ON CONFLICT DO NOTHING with placeholders in the stated parameter order', () => {
  const { text, paramOrder } = idempotencyInsertSql();

  assert.match(text, /^INSERT INTO idempotency_keys \(/);
  assert.match(text, /ON CONFLICT DO NOTHING\s*$/);
  assert.deepEqual(paramOrder, [
    'idempotency_key',
    'company_id',
    'run_id',
    'call_index',
    'tool',
    'created_at',
    'expires_at',
  ]);

  const values = text.match(/VALUES \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
  assert.deepEqual(values, paramOrder.map((_, i) => `$${i + 1}`));

  const columns = text.match(/\(([^)]*)\)/)[1].split(',').map((s) => s.trim());
  assert.deepEqual(columns, [...paramOrder]);
});
