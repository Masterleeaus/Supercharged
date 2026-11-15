// Inbox sends pass the pre-send gate: staff sends (no approval) and approved agent sends. A blocked
// send is kept as a rejected message with its reason recorded, and nothing is queued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxService, InboxError, InMemoryInboxStore, InMemoryApprovalPort } from '../../server/modules/inbox/index.ts';
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', id: 'user-1' };
const AGENT = { kind: 'agent', id: 'agent-7' };
const PHONE = '+61400000001';

function build({ consents = [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }], quiet = null, suppressPhone = false, omitCompliance = false } = {}) {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  const suppression = createSuppressionList({ audit: () => {}, clock: () => '2026-11-15T10:00:00.000Z' });
  if (suppressPhone) suppression.suppress(CO_A, { channel: 'sms', address: PHONE, reason: 'unsubscribed', actorId: 'system' });
  const blocked = [];
  let checks = 0;
  const gate = createPreSendGate({
    suppression,
    async loadContact(_c, channel, address) {
      return { handles: { phone: address }, consents, timezone: 'Australia/Melbourne' };
    },
    async loadQuietHours() {
      return quiet;
    },
    now: () => new Date('2026-11-15T10:00:00Z'),
    async recordBlocked(r) {
      blocked.push(r);
    },
  });
  const countingGate = {
    check: async (input) => {
      checks += 1;
      return gate.check(input);
    },
    recordBlock: gate.recordBlock,
  };
  const deps = { store, approvals, newId: (() => { let n = 0; return () => `id_${++n}`; })(), now: () => new Date('2026-11-15T10:00:00Z') };
  if (!omitCompliance) deps.compliance = countingGate;
  const service = createInboxService(deps);
  return { store, approvals, service, blocked, checks: () => checks };
}

async function threadWithContact(ctx) {
  const inbound = await ctx.service.recordInbound(CO_A, { channel: 'sms', address: PHONE, body: 'Can I move Friday?', externalId: 'ext-1' });
  return inbound.thread.id;
}

test('a consented staff send passes the gate once and is queued', async () => {
  const ctx = build();
  const threadId = await threadWithContact(ctx);
  const sent = await ctx.service.sendAsStaff(CO_A, HUMAN, threadId, 'Friday is fine.');
  assert.equal(sent.status, 'queued');
  assert.equal(ctx.checks(), 1);
  assert.equal(ctx.blocked.length, 0);
});

test('a staff send to a suppressed number is refused, kept as rejected with its reason, and not queued', async () => {
  const ctx = build({ suppressPhone: true });
  const threadId = await threadWithContact(ctx);
  await assert.rejects(ctx.service.sendAsStaff(CO_A, HUMAN, threadId, 'Friday is fine.'), (err) => {
    assert.ok(err instanceof InboxError);
    assert.equal(err.code, 'forbidden');
    assert.equal(err.message, 'send_blocked:suppressed');
    return true;
  });
  const messages = await ctx.service.listMessages(CO_A, threadId);
  const refused = messages.filter((m) => m.direction === 'outbound');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].status, 'rejected');
  assert.equal(refused[0].queuedAt, null);
  assert.equal(ctx.blocked.length, 1);
  assert.equal(ctx.blocked[0].reason, 'suppressed');
  assert.equal(ctx.blocked[0].surface, 'inbox');
  assert.equal(ctx.blocked[0].actorId, HUMAN.id);
  assert.equal(ctx.blocked[0].messageId, refused[0].id);
  assert.equal(ctx.blocked[0].threadId, threadId);
});

test('a staff send to a contact who opted out is refused with opted_out', async () => {
  const ctx = build({ consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }, { channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' }] });
  const threadId = await threadWithContact(ctx);
  await assert.rejects(ctx.service.sendAsStaff(CO_A, HUMAN, threadId, 'Hello'), /send_blocked:opted_out/);
  assert.equal(ctx.blocked[0].reason, 'opted_out');
});

test('a staff send inside quiet hours in the recipient timezone is refused with quiet_hours', async () => {
  // 10:00 UTC is 21:00 in Melbourne, inside the 21:00 to 07:00 window.
  const ctx = build({ quiet: { startHour: 21, endHour: 7 } });
  const threadId = await threadWithContact(ctx);
  await assert.rejects(ctx.service.sendAsStaff(CO_A, HUMAN, threadId, 'Hello'), /send_blocked:quiet_hours/);
  assert.equal(ctx.blocked[0].reason, 'quiet_hours');
});

test('an approved agent send that the gate blocks is rejected, and the approval is not claimed', async () => {
  const ctx = build({ suppressPhone: true });
  const threadId = await threadWithContact(ctx);
  await ctx.service.assignThread(CO_A, HUMAN, threadId, { kind: 'agent', id: AGENT.id });
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  ctx.approvals.nextState = 'approved';
  const result = await ctx.service.requestSend(CO_A, AGENT, draft.id);
  assert.equal(result.status, 'rejected');
  assert.equal(result.queuedAt, null);
  assert.equal(ctx.approvals.isExecuted(result.approvalId), false);
  assert.equal(ctx.blocked.length, 1);
  assert.equal(ctx.blocked[0].reason, 'suppressed');
  assert.equal(ctx.blocked[0].messageId, draft.id);
  assert.equal(ctx.blocked[0].actorId, AGENT.id);
});

test('an approved agent send that passes the gate is queued', async () => {
  const ctx = build();
  const threadId = await threadWithContact(ctx);
  await ctx.service.assignThread(CO_A, HUMAN, threadId, { kind: 'agent', id: AGENT.id });
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  ctx.approvals.nextState = 'approved';
  const result = await ctx.service.requestSend(CO_A, AGENT, draft.id);
  assert.equal(result.status, 'queued');
  assert.equal(ctx.approvals.isExecuted(result.approvalId), true);
  assert.equal(ctx.blocked.length, 0);
});

test('the inbox service refuses to construct without a pre-send gate', () => {
  const ctx = { store: new InMemoryInboxStore(), approvals: new InMemoryApprovalPort() };
  assert.throws(() => createInboxService(ctx), /pre-send compliance gate required/);
});
