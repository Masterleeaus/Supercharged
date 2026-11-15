// Cross-company isolation for comms in-memory stores and pure helpers (node:test).
// Company A's saved replies, suppressions, segments and email threads must never be readable,
// changeable or matched by company B. No database, no provider, no network.
// Complements cross-company-comms.test.mjs (campaigns and inbox) and comms-scope-audit.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedReplyStore } from '../../server/modules/comms/saved-replies.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { defineSegment, evaluateSegment } from '../../server/modules/comms/segments.ts';
import { matchEmailThread } from '../../server/modules/comms/thread-match.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-10T09:00:00.000Z');
const CLOCK = () => '2026-11-10T09:00:00.000Z';

test('saved replies: company B cannot list, update or remove company A reply', () => {
  const store = createSavedReplyStore();
  const created = store.create(CO_A, { title: 'Hours', body: 'We open at 9', channel: 'any' });
  assert.equal(created.ok, true);
  const id = created.reply.id;

  assert.deepEqual(store.list(CO_B).map((r) => r.id), []);
  assert.deepEqual(store.list(CO_A).map((r) => r.id), [id]);

  const upd = store.update(CO_B, id, { title: 'Hijacked' });
  assert.equal(upd.ok, false);
  assert.equal(upd.reason, 'not_found');

  const del = store.remove(CO_B, id);
  assert.equal(del.ok, false);
  assert.equal(del.reason, 'not_found');

  const still = store.list(CO_A)[0];
  assert.equal(still.title, 'Hours');
  assert.equal(still.body, 'We open at 9');
});

test('saved replies: a blank or malformed company id reads nothing and writes nothing', () => {
  const store = createSavedReplyStore();
  store.create(CO_A, { title: 'Hours', body: 'We open at 9', channel: 'any' });
  assert.deepEqual(store.list(''), []);
  assert.deepEqual(store.list(undefined), []);
  assert.equal(store.create('not-a-uuid', { title: 'x', body: 'y', channel: 'any' }).ok, false);
  assert.equal(store.list(CO_A).length, 1);
});

test('suppression: company A suppression is invisible to company B', () => {
  const list = createSuppressionList({ audit: () => {}, clock: CLOCK });
  const r = list.suppress(CO_A, { address: 'ann@example.com', channel: 'email', reason: 'complaint' });
  assert.equal(r.ok, true);
  assert.equal(list.isSuppressed(CO_A, { address: 'ann@example.com', channel: 'email' }), true);
  assert.equal(list.isSuppressed(CO_B, { address: 'ann@example.com', channel: 'email' }), false);
  assert.equal(list.reasonFor(CO_B, { address: 'ann@example.com', channel: 'email' }), null);
});

test('suppression: company B cannot lift company A suppression', () => {
  const list = createSuppressionList({ audit: () => {}, clock: CLOCK });
  list.suppress(CO_A, { address: 'ann@example.com', channel: 'email', reason: 'unsubscribed' });
  list.unsuppress(CO_B, { address: 'ann@example.com', channel: 'email' });
  assert.equal(list.isSuppressed(CO_A, { address: 'ann@example.com', channel: 'email' }), true);
  assert.equal(list.reasonFor(CO_A, { address: 'ann@example.com', channel: 'email' }), 'unsubscribed');
});

test('suppression: a suppression in company B does not change the soft-bounce count of company A', () => {
  const list = createSuppressionList({ audit: () => {}, clock: CLOCK });
  const input = { address: 'bob@example.com', channel: 'email', reason: 'bounce_soft' };
  list.suppress(CO_A, input);
  list.suppress(CO_A, input);
  list.suppress(CO_B, input);
  const third = list.suppress(CO_A, input);
  assert.equal(third.ok, true);
  assert.equal(third.suppressed, true, 'A reaches the threshold on its own count');
  assert.equal(list.isSuppressed(CO_B, { address: 'bob@example.com', channel: 'email' }), false, 'B has one bounce of its own and is not suppressed');
});

test('suppression: a non-UUID company is refused rather than read as clean', () => {
  const list = createSuppressionList({ audit: () => {}, clock: CLOCK });
  list.suppress(CO_A, { address: 'ann@example.com', channel: 'email', reason: 'complaint' });
  assert.throws(() => list.reasonFor('', { address: 'ann@example.com', channel: 'email' }), TypeError);
});

test('segments: a segment of company B never includes company A contacts', () => {
  const seg = defineSegment({ companyId: CO_B, name: 'Warm leads', rules: [{ field: 'tag', op: 'has', value: 'vip' }] });
  assert.equal(seg.ok, true);
  const contacts = [
    { id: 'a1', companyId: CO_A, tags: ['vip'], lifecycle: 'lead', consent: { email: true } },
    { id: 'b1', companyId: CO_B, tags: ['vip'], lifecycle: 'lead', consent: { email: true } },
  ];
  const members = evaluateSegment(seg.segment, contacts, { now: NOW });
  assert.deepEqual(members.map((c) => c.id), ['b1']);
});

test('segments: a company A segment never returns company B contacts even when rules match', () => {
  const seg = defineSegment({ companyId: CO_A, name: 'All VIPs', rules: [{ field: 'tag', op: 'has', value: 'vip' }] });
  assert.equal(seg.ok, true);
  const contacts = [{ id: 'b1', companyId: CO_B, tags: ['vip'], lifecycle: 'lead', consent: { email: true } }];
  assert.deepEqual(evaluateSegment(seg.segment, contacts, { now: NOW }), []);
});

test('email threading: company B inbound never joins a company A thread', () => {
  const threads = [
    {
      id: 'thread-a',
      companyId: CO_A,
      channel: 'email',
      participantAddress: 'client@example.com',
      messageIds: ['<msg-1@example.com>'],
      lastMessageAt: NOW,
    },
  ];
  const result = matchEmailThread({
    companyId: CO_B,
    inbound: { fromAddress: 'client@example.com', receivedAt: NOW },
    referenceIds: ['<msg-1@example.com>'],
    threads,
  });
  assert.deepEqual(result, { matched: false, reason: 'new_thread' });
});

test('email threading: the same reference id in company A still matches company A', () => {
  const threads = [
    {
      id: 'thread-a',
      companyId: CO_A,
      channel: 'email',
      participantAddress: 'client@example.com',
      messageIds: ['<msg-1@example.com>'],
      lastMessageAt: NOW,
    },
  ];
  const result = matchEmailThread({
    companyId: CO_A,
    inbound: { fromAddress: 'client@example.com', receivedAt: NOW },
    referenceIds: ['<msg-1@example.com>'],
    threads,
  });
  assert.equal(result.matched, true);
  assert.equal(result.threadId, 'thread-a');
});
