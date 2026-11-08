// Inbox inbound race test (node:test). No database, no provider, no network.
// Two concurrent deliveries of the same inbound (same channel and externalId) must leave
// one thread and one message. Until recordInbound serializes the thread and participant
// creation (see the report for the change), this test is expected to fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxService, InMemoryInboxStore, InMemoryApprovalPort } from '../../server/modules/inbox/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';

function build() {
  const store = new InMemoryInboxStore();
  let seq = 0;
  const service = createInboxService({
    store,
    approvals: new InMemoryApprovalPort(),
    newId: () => `race_${++seq}`,
  });
  return { store, service };
}

const inbound = {
  channel: 'sms',
  address: '+61400000002',
  displayName: 'Grace',
  body: 'Is Tuesday still on?',
  externalId: 'ext-race-1',
};

test('race: two concurrent deliveries of one inbound leave one thread and one message', async () => {
  const { store, service } = build();

  const [a, b] = await Promise.all([
    service.recordInbound(CO_A, inbound),
    service.recordInbound(CO_A, inbound),
  ]);

  // Exactly one delivery is the original. The other is a duplicate of it.
  assert.equal([a.duplicate, b.duplicate].filter((d) => d === false).length, 1);
  assert.equal(a.message.id, b.message.id);
  assert.equal(a.thread.id, b.thread.id);

  const threads = await store.listThreads(CO_A, {});
  assert.equal(threads.length, 1, 'one thread');

  const messages = await store.listMessages(CO_A, threads[0].id);
  assert.equal(messages.length, 1, 'one message');
});

test('race: two concurrent deliveries create one contact participant', async () => {
  const { store, service } = build();

  await Promise.all([
    service.recordInbound(CO_A, inbound),
    service.recordInbound(CO_A, inbound),
  ]);

  const contact = await store.findContactParticipant(CO_A, 'sms', inbound.address);
  assert.ok(contact, 'contact exists');
  const contacts = (store.participants ?? []).filter((p) => p.kind === 'contact' && p.address === inbound.address);
  assert.equal(contacts.length, 1, 'one contact row');
});
