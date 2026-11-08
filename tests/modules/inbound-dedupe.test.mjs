// Inbound dedupe tests (node:test). Fake in-memory store only: no database, no network.
// Silence console output so the test runner's IPC stays clean.
for (const m of ['log', 'info', 'warn']) console[m] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInboundMessage, isUniqueConflict } from '../../server/modules/comms/inbound-dedupe.ts';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

// Fake store: a Set of unique keys. Optionally simulates a unique-conflict on every insert.
function fakeStore({ conflictAlways = false } = {}) {
  const keys = new Set();
  const calls = [];
  return {
    calls,
    keys,
    async insert(key) {
      calls.push(key);
      const k = `${key.companyId}|${key.provider}|${key.providerMessageId}`;
      if (conflictAlways || keys.has(k)) {
        throw Object.assign(new Error('unique key conflict'), { code: '23505' });
      }
      keys.add(k);
    },
  };
}

test('first sight returns new, repeat returns duplicate', async () => {
  const store = fakeStore();
  const input = { companyId: COMPANY_A, provider: 'sms', providerMessageId: 'SM-123' };
  assert.equal(await recordInboundMessage(store, input), 'new');
  assert.equal(await recordInboundMessage(store, input), 'duplicate');
});

test('same provider id under another company is new, not a duplicate', async () => {
  const store = fakeStore();
  const a = { companyId: COMPANY_A, provider: 'sms', providerMessageId: 'SM-1' };
  const b = { companyId: COMPANY_B, provider: 'sms', providerMessageId: 'SM-1' };
  assert.equal(await recordInboundMessage(store, a), 'new');
  assert.equal(await recordInboundMessage(store, b), 'new');
});

test('a unique-conflict error from the store is reported as duplicate, not thrown', async () => {
  const store = fakeStore({ conflictAlways: true });
  const outcome = await recordInboundMessage(store, {
    companyId: COMPANY_A,
    provider: 'telegram',
    providerMessageId: 'tg-42',
  });
  assert.equal(outcome, 'duplicate');
});

test('a non-conflict store error is rethrown, not swallowed as duplicate', async () => {
  const store = {
    async insert() {
      throw new Error('connection reset');
    },
  };
  await assert.rejects(
    recordInboundMessage(store, { companyId: COMPANY_A, provider: 'sms', providerMessageId: 'x' }),
    /connection reset/,
  );
});

test('missing or malformed company, provider or message id is refused before the store is called', async () => {
  const store = fakeStore();
  const bad = [
    { companyId: undefined, provider: 'sms', providerMessageId: 'a' },
    { companyId: 'not-a-uuid', provider: 'sms', providerMessageId: 'a' },
    { companyId: COMPANY_A, provider: '', providerMessageId: 'a' },
    { companyId: COMPANY_A, provider: 'SMS Bad!', providerMessageId: 'a' },
    { companyId: COMPANY_A, provider: 'sms', providerMessageId: undefined },
    { companyId: COMPANY_A, provider: 'sms', providerMessageId: '   ' },
    { companyId: COMPANY_A, provider: 'sms', providerMessageId: 'x'.repeat(257) },
  ];
  for (const input of bad) {
    await assert.rejects(recordInboundMessage(store, input), TypeError);
  }
  assert.equal(store.calls.length, 0);
});

test('isUniqueConflict recognises only the conflict markers', () => {
  assert.equal(isUniqueConflict(Object.assign(new Error('x'), { code: '23505' })), true);
  assert.equal(isUniqueConflict(Object.assign(new Error('x'), { name: 'UniqueConflictError' })), true);
  assert.equal(isUniqueConflict(new Error('connection reset')), false);
  assert.equal(isUniqueConflict(null), false);
});
