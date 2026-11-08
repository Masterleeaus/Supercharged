/**
 * Tests for server/workforce/runtime/review-notify.ts. Stubs only, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/review-notify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyReview } from '../../server/workforce/runtime/review-notify.ts';

const ITEM = {
  id: 'tool_failed:tc-1',
  kind: 'tool_failed',
  companyId: 'company-a',
  runId: 'run-1',
  reason: 'tool call failed',
  createdAt: '2026-11-03T10:00:00.000Z',
  severity: 'high',
};

function makeInbox() {
  const added = [];
  return { added, add: (item) => { added.push(item); } };
}

function makeChannels(ids, failIds = []) {
  const calls = [];
  return {
    calls,
    ids,
    send: async (channelId, item) => {
      calls.push({ channelId, item });
      if (failIds.includes(channelId)) throw new Error(`${channelId} down`);
    },
  };
}

test('the inbox always gets the item, with no channels configured', async () => {
  const inbox = makeInbox();
  const result = await notifyReview({ inbox, channels: makeChannels([]) }, ITEM);
  assert.deepEqual(inbox.added, [ITEM]);
  assert.deepEqual(result, { sent: [], failed: [] });
});

test('the inbox gets the item when every channel fails', async () => {
  const inbox = makeInbox();
  const result = await notifyReview({ inbox, channels: makeChannels(['ch-1', 'ch-2'], ['ch-1', 'ch-2']) }, ITEM);
  assert.deepEqual(inbox.added, [ITEM]);
  assert.deepEqual(result.failed, ['ch-1', 'ch-2']);
});

test('every configured channel is attempted with the same item, in order', async () => {
  const inbox = makeInbox();
  const channels = makeChannels(['ch-1', 'ch-2', 'ch-3']);
  const result = await notifyReview({ inbox, channels }, ITEM);
  assert.deepEqual(channels.calls.map((c) => c.channelId), ['ch-1', 'ch-2', 'ch-3']);
  for (const c of channels.calls) assert.equal(c.item, ITEM);
  assert.deepEqual(result, { sent: ['ch-1', 'ch-2', 'ch-3'], failed: [] });
});

test('one failing channel does not stop the others', async () => {
  const inbox = makeInbox();
  const channels = makeChannels(['ch-1', 'ch-2', 'ch-3'], ['ch-2']);
  const result = await notifyReview({ inbox, channels }, ITEM);
  assert.deepEqual(channels.calls.map((c) => c.channelId), ['ch-1', 'ch-2', 'ch-3']);
  assert.deepEqual(result, { sent: ['ch-1', 'ch-3'], failed: ['ch-2'] });
  assert.deepEqual(inbox.added, [ITEM]);
});

test('a channel that throws synchronously is recorded as failed, not thrown', async () => {
  const inbox = makeInbox();
  const calls = [];
  const channels = {
    ids: ['sync-bad', 'ok'],
    send: (channelId, item) => {
      calls.push(channelId);
      if (channelId === 'sync-bad') throw new Error('boom');
    },
  };
  const result = await notifyReview({ inbox, channels }, ITEM);
  assert.deepEqual(calls, ['sync-bad', 'ok']);
  assert.deepEqual(result, { sent: ['ok'], failed: ['sync-bad'] });
});

test('a duplicate channel id is sent once', async () => {
  const inbox = makeInbox();
  const channels = makeChannels(['ch-1', 'ch-1']);
  const result = await notifyReview({ inbox, channels }, ITEM);
  assert.equal(channels.calls.length, 1);
  assert.deepEqual(result, { sent: ['ch-1'], failed: [] });
});
