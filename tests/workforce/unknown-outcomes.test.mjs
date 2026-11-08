/**
 * Tests for server/workforce/runtime/unknown-outcomes.ts. Injected dependencies only, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/unknown-outcomes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnknownOutcome } from '../../server/workforce/runtime/unknown-outcomes.ts';

const CHANGE = { before: { status: 'pending' }, after: { status: 'sent' }, id: 'msg_1' };

function spies(readValue, { readThrows = false } = {}) {
  const calls = { readBack: [], notifyOwner: [], record: [] };
  const deps = {
    readBack: async (change) => {
      calls.readBack.push(change);
      if (readThrows) throw new Error('read failed');
      return readValue;
    },
    notifyOwner: async (change) => {
      calls.notifyOwner.push(change);
    },
    record: async (resolution, change) => {
      calls.record.push({ resolution, change });
    },
  };
  return { deps, calls };
}

test('read-back shows the change: resolves applied, no owner notice', async () => {
  const { deps, calls } = spies({ status: 'sent' });
  const result = await resolveUnknownOutcome(deps, CHANGE);

  assert.equal(result, 'applied');
  assert.equal(calls.readBack.length, 1);
  assert.equal(calls.readBack[0], CHANGE);
  assert.equal(calls.notifyOwner.length, 0);
  assert.deepEqual(calls.record, [{ resolution: 'applied', change: CHANGE }]);
});

test('read-back shows the prior state: resolves not_applied, no owner notice', async () => {
  const { deps, calls } = spies({ status: 'pending' });
  const result = await resolveUnknownOutcome(deps, CHANGE);

  assert.equal(result, 'not_applied');
  assert.equal(calls.notifyOwner.length, 0);
  assert.deepEqual(calls.record, [{ resolution: 'not_applied', change: CHANGE }]);
});

test('read-back shows neither state: notifies the owner and resolves owner_decides', async () => {
  const { deps, calls } = spies({ status: 'partially_sent' });
  const result = await resolveUnknownOutcome(deps, CHANGE);

  assert.equal(result, 'owner_decides');
  assert.equal(calls.notifyOwner.length, 1);
  assert.equal(calls.notifyOwner[0], CHANGE);
  assert.deepEqual(calls.record, [{ resolution: 'owner_decides', change: CHANGE }]);
});

test('a failed read-back is treated as unknown: owner is notified', async () => {
  const { deps, calls } = spies(undefined, { readThrows: true });
  const result = await resolveUnknownOutcome(deps, CHANGE);

  assert.equal(result, 'owner_decides');
  assert.equal(calls.notifyOwner.length, 1);
});
