// Inbox module tests (node:test). No database, no provider, no network, no real sends.
// The approvals gate is an in-memory fake that returns pending unless a test says otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInboxService,
  InboxError,
  InMemoryInboxStore,
  InMemoryApprovalPort,
  sha256,
} from '../../server/modules/inbox/index.ts';
import { createInMemoryTransactionRunner } from '../../server/modules/inbox/memory-adapter.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const HUMAN = { kind: 'human', id: 'user-1' };
const AGENT = { kind: 'agent', id: 'agent-7' };
const OTHER_AGENT = { kind: 'agent', id: 'agent-9' };

function build() {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  let clock = 0;
  let seq = 0;
  const service = createInboxService({
    store,
    approvals,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    newId: () => `id_${++seq}`,
  });
  return { store, approvals, service };
}

const inbound = (over = {}) => ({
  channel: 'sms',
  address: '+61400000001',
  displayName: 'Ada',
  body: 'Can I move Friday to Monday?',
  externalId: 'ext-1',
  ...over,
});

/** Inbound, then assign the thread to an agent. Returns the ids the tests need. */
async function assignedThread(ctx, companyId = CO_A, agent = AGENT) {
  const r = await ctx.service.recordInbound(companyId, inbound());
  await ctx.service.assignThread(companyId, agent, r.thread.id, { kind: 'agent', id: agent.id });
  return r.thread.id;
}

// --- inbound and threads ---------------------------------------------------

test('inbound: creates a contact participant, a thread and a received message', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());

  assert.equal(r.duplicate, false);
  assert.equal(r.thread.companyId, CO_A);
  assert.equal(r.thread.channel, 'sms');
  assert.equal(r.thread.status, 'open');
  assert.equal(r.thread.assignee, null);
  assert.equal(r.message.direction, 'inbound');
  assert.equal(r.message.status, 'received');
  assert.equal(r.message.authorKind, 'contact');
  assert.equal(r.message.bodySha256, sha256('Can I move Friday to Monday?'));

  const links = await ctx.store.listThreadParticipants(CO_A, r.thread.id);
  assert.equal(links.length, 1);
});

test('inbound: a repeated externalId on the same channel returns the original message, no new rows', async () => {
  const ctx = build();
  const first = await ctx.service.recordInbound(CO_A, inbound());
  const again = await ctx.service.recordInbound(CO_A, inbound({ body: 'retry body' }));

  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, first.message.id);
  assert.equal((await ctx.service.listMessages(CO_A, first.thread.id)).length, 1);
});

test('inbound: a second message from the same contact joins the open thread', async () => {
  const ctx = build();
  const first = await ctx.service.recordInbound(CO_A, inbound());
  const second = await ctx.service.recordInbound(CO_A, inbound({ externalId: 'ext-2', body: 'Also, 9am?' }));

  assert.equal(second.thread.id, first.thread.id);
  assert.equal((await ctx.service.listMessages(CO_A, first.thread.id)).length, 2);
});

test('inbound: a snoozed thread wakes to open when the contact writes again', async () => {
  const ctx = build();
  const first = await ctx.service.recordInbound(CO_A, inbound());
  await ctx.service.setThreadStatus(CO_A, HUMAN, first.thread.id, 'snoozed');
  const second = await ctx.service.recordInbound(CO_A, inbound({ externalId: 'ext-2' }));

  assert.equal(second.thread.id, first.thread.id);
  assert.equal(second.thread.status, 'open');
});

test('inbound: a closed thread is not reused, so the next message opens a new thread', async () => {
  const ctx = build();
  const first = await ctx.service.recordInbound(CO_A, inbound());
  await ctx.service.setThreadStatus(CO_A, HUMAN, first.thread.id, 'closed');
  const second = await ctx.service.recordInbound(CO_A, inbound({ externalId: 'ext-2' }));

  assert.notEqual(second.thread.id, first.thread.id);
});

test('inbound: an address that is not valid for the channel is refused', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.recordInbound(CO_A, inbound({ address: 'not-a-phone' })), (e) => e instanceof InboxError && e.code === 'invalid');
  await assert.rejects(ctx.service.recordInbound(CO_A, inbound({ channel: 'email', address: '+61400000001' })), (e) => e.code === 'invalid');
});

test('inbound: unknown channel and empty body are refused', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.recordInbound(CO_A, inbound({ channel: 'fax' })), (e) => e.code === 'invalid');
  await assert.rejects(ctx.service.recordInbound(CO_A, inbound({ body: '   ' })), (e) => e.code === 'invalid');
});

// --- company scope ---------------------------------------------------------

test('scope: a missing or blank companyId fails closed before any store call', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.recordInbound('', inbound()), /Company scope required/);
  await assert.rejects(ctx.service.listThreads('   '), /Company scope required/);
});

test('scope: threads and messages are invisible to another company', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());

  await assert.rejects(ctx.service.getThread(CO_B, r.thread.id), (e) => e.code === 'not_found');
  await assert.rejects(ctx.service.listMessages(CO_B, r.thread.id), (e) => e.code === 'not_found');
  assert.deepEqual(await ctx.service.listThreads(CO_B), []);
});

test('scope: the same inbound externalId in another company is a new message, not a duplicate', async () => {
  const ctx = build();
  await ctx.service.recordInbound(CO_A, inbound());
  const b = await ctx.service.recordInbound(CO_B, inbound());
  assert.equal(b.duplicate, false);
});

test('scope: an agent cannot act on another company\'s thread', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx, CO_A);
  await assert.rejects(ctx.service.createDraft(CO_B, AGENT, threadId, 'hi'), (e) => e.code === 'not_found');
});

// --- assignment ------------------------------------------------------------

test('assignment: a human can assign a thread to an agent or a human, and unassign it', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());
  const toAgent = await ctx.service.assignThread(CO_A, HUMAN, r.thread.id, { kind: 'agent', id: 'agent-7' });
  assert.deepEqual(toAgent.assignee, { kind: 'agent', id: 'agent-7' });
  const toHuman = await ctx.service.assignThread(CO_A, HUMAN, r.thread.id, { kind: 'human', id: 'user-2' });
  assert.deepEqual(toHuman.assignee, { kind: 'human', id: 'user-2' });
  const cleared = await ctx.service.assignThread(CO_A, HUMAN, r.thread.id, null);
  assert.equal(cleared.assignee, null);
});

test('assignment: an agent may claim a thread for itself but not hand it to another', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());
  await ctx.service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: AGENT.id });
  await assert.rejects(
    ctx.service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: OTHER_AGENT.id }),
    (e) => e.code === 'forbidden',
  );
  await assert.rejects(ctx.service.assignThread(CO_A, AGENT, r.thread.id, null), (e) => e.code === 'forbidden');
});

test('assignment: a malformed assignee is refused', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());
  await assert.rejects(ctx.service.assignThread(CO_A, HUMAN, r.thread.id, { kind: 'robot', id: 'x' }), (e) => e.code === 'invalid');
  await assert.rejects(ctx.service.assignThread(CO_A, HUMAN, r.thread.id, { kind: 'agent', id: '' }), (e) => e.code === 'invalid');
});

// --- drafts ---------------------------------------------------------------

test('drafts: an agent may draft on a thread assigned to it, and nothing is sent', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');

  assert.equal(draft.status, 'draft');
  assert.equal(draft.direction, 'outbound');
  assert.equal(draft.authorKind, 'agent');
  assert.equal(draft.queuedAt, null);
  assert.equal(ctx.approvals.requests.length, 0);
});

test('drafts: an agent cannot draft on a thread that is unassigned or assigned to someone else', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());
  await assert.rejects(ctx.service.createDraft(CO_A, AGENT, r.thread.id, 'hi'), (e) => e.code === 'forbidden');

  await ctx.service.assignThread(CO_A, HUMAN, r.thread.id, { kind: 'agent', id: OTHER_AGENT.id });
  await assert.rejects(ctx.service.createDraft(CO_A, AGENT, r.thread.id, 'hi'), (e) => e.code === 'forbidden');
});

test('drafts: a blank body is refused', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  await assert.rejects(ctx.service.createDraft(CO_A, AGENT, threadId, ''), (e) => e.code === 'invalid');
});

// --- sends: the approval rule ----------------------------------------------

test('send: an agent draft goes to the gate with the action, message id and body hash, and waits', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  const sent = await ctx.service.requestSend(CO_A, AGENT, draft.id);

  assert.equal(sent.status, 'awaiting_approval');
  assert.equal(sent.queuedAt, null);
  assert.equal(ctx.approvals.requests.length, 1);
  const req = ctx.approvals.requests[0];
  assert.equal(req.action, 'inbox.send_message');
  assert.equal(req.companyId, CO_A);
  assert.equal(req.agentId, AGENT.id);
  assert.equal(req.params.messageId, draft.id);
  assert.equal(req.params.bodySha256, sha256('Monday works.'));
  assert.equal(sent.approvalId, 'appr_1');
});

test('send: a pending approval leaves the message awaiting and not queued', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  await ctx.service.requestSend(CO_A, AGENT, draft.id);

  const after = await ctx.service.applyApprovalDecision(CO_A, draft.id);
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.queuedAt, null);
});

test('send: an approved decision queues the message and marks the approval executed', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  const awaiting = await ctx.service.requestSend(CO_A, AGENT, draft.id);

  ctx.approvals.decide(awaiting.approvalId, 'approved');
  const queued = await ctx.service.applyApprovalDecision(CO_A, draft.id);

  assert.equal(queued.status, 'queued');
  assert.ok(queued.queuedAt instanceof Date);
  assert.equal(ctx.approvals.isExecuted(awaiting.approvalId), true);
});

test('send: a gate that approves immediately (policy auto_approve) still goes through the same check', async () => {
  const ctx = build();
  ctx.approvals.nextState = 'approved';
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  const queued = await ctx.service.requestSend(CO_A, AGENT, draft.id);

  assert.equal(queued.status, 'queued');
  assert.equal(ctx.approvals.isExecuted(queued.approvalId), true);
});

test('send: a rejected or expired approval moves the message to rejected and it cannot be queued', async () => {
  for (const outcome of ['rejected', 'expired']) {
    const ctx = build();
    const threadId = await assignedThread(ctx);
    const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
    const awaiting = await ctx.service.requestSend(CO_A, AGENT, draft.id);
    ctx.approvals.decide(awaiting.approvalId, outcome);

    const after = await ctx.service.applyApprovalDecision(CO_A, draft.id);
    assert.equal(after.status, 'rejected', outcome);
    assert.equal(ctx.approvals.isExecuted(awaiting.approvalId), false);
  }
});

test('send: an approval for a different body or message cannot release this message', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  const awaiting = await ctx.service.requestSend(CO_A, AGENT, draft.id);
  // Simulate a stored approval whose params were bound to other content.
  ctx.approvals.decide(awaiting.approvalId, 'approved');
  const row = await ctx.approvals.getApproval(CO_A, awaiting.approvalId);
  row.params.bodySha256 = sha256('something else');
  ctx.approvals.getApproval = async () => row;

  await assert.rejects(ctx.service.applyApprovalDecision(CO_A, draft.id), (e) => e.code === 'conflict');
  assert.equal((await ctx.service.listMessages(CO_A, threadId)).find((m) => m.id === draft.id).status, 'awaiting_approval');
});

test('send: an agent cannot send a draft it did not write, or a draft already sent', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');

  await ctx.service.assignThread(CO_A, HUMAN, threadId, { kind: 'agent', id: OTHER_AGENT.id });
  await assert.rejects(ctx.service.requestSend(CO_A, OTHER_AGENT, draft.id), (e) => e.code === 'forbidden');

  ctx.approvals.nextState = 'approved';
  await ctx.service.requestSend(CO_A, AGENT, draft.id);
  await assert.rejects(ctx.service.requestSend(CO_A, AGENT, draft.id), (e) => e.code === 'forbidden' || e.code === 'conflict');
});

test('send: a human cannot use the gated path, and an agent cannot use the human path', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');

  await assert.rejects(ctx.service.requestSend(CO_A, HUMAN, draft.id), (e) => e.code === 'forbidden');
  await assert.rejects(ctx.service.sendAsStaff(CO_A, AGENT, threadId, 'hi'), (e) => e.code === 'forbidden');
  assert.equal(ctx.approvals.requests.length, 0);
});

test('send: a human send is queued directly and never reaches the gate', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound());
  const msg = await ctx.service.sendAsStaff(CO_A, HUMAN, r.thread.id, 'Yes, Monday.');

  assert.equal(msg.status, 'queued');
  assert.equal(msg.authorKind, 'staff');
  assert.ok(msg.queuedAt instanceof Date);
  assert.equal(ctx.approvals.requests.length, 0);
});

test('send: a message that is no longer a draft cannot be requested again', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  await ctx.service.requestSend(CO_A, AGENT, draft.id);
  await assert.rejects(ctx.service.requestSend(CO_A, AGENT, draft.id), (e) => e.code === 'conflict');
});

test('send: approval state is read in the caller\'s company only', async () => {
  const ctx = build();
  const threadId = await assignedThread(ctx);
  const draft = await ctx.service.createDraft(CO_A, AGENT, threadId, 'Monday works.');
  const awaiting = await ctx.service.requestSend(CO_A, AGENT, draft.id);
  ctx.approvals.decide(awaiting.approvalId, 'approved');

  assert.equal(await ctx.approvals.getApproval(CO_B, awaiting.approvalId), null);
  await assert.rejects(ctx.service.applyApprovalDecision(CO_B, draft.id), (e) => e.code === 'not_found');
});

// --- atomic approval send ----------------------------------------------------

test('send atomic: a failed message write leaves the approval not executed and the draft awaiting', async () => {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  let clock = 0;
  let seq = 0;
  const service = createInboxService({
    store,
    approvals,
    transactions: createInMemoryTransactionRunner(store, approvals),
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    newId: () => `id_${++seq}`,
  });
  const r = await service.recordInbound(CO_A, inbound());
  await service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: AGENT.id });
  const draft = await service.createDraft(CO_A, AGENT, r.thread.id, 'Monday works.');
  const awaiting = await service.requestSend(CO_A, AGENT, draft.id);
  const threadBefore = await service.getThread(CO_A, r.thread.id);

  // The message write fails once, after the approval claim and the thread touch have run.
  const realUpdateMessage = store.updateMessage.bind(store);
  store.updateMessage = async (companyId, id, patch) => {
    if (patch.status === 'queued') throw new Error('disk full');
    return realUpdateMessage(companyId, id, patch);
  };
  approvals.decide(awaiting.approvalId, 'approved');

  await assert.rejects(service.applyApprovalDecision(CO_A, draft.id), /disk full/);
  assert.equal(approvals.isExecuted(awaiting.approvalId), false, 'the claim must roll back with the failed write');
  assert.equal((await service.listMessages(CO_A, r.thread.id)).find((m) => m.id === draft.id).status, 'awaiting_approval');
  assert.deepEqual(await service.getThread(CO_A, r.thread.id), threadBefore, 'the thread touch must roll back too');

  // Once the write works again, the same decision completes exactly once.
  store.updateMessage = realUpdateMessage;
  const queued = await service.applyApprovalDecision(CO_A, draft.id);
  assert.equal(queued.status, 'queued');
  assert.equal(approvals.isExecuted(awaiting.approvalId), true);
});

test('send atomic: the audit write runs exactly once, after the transaction commits', async () => {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  const base = createInMemoryTransactionRunner(store, approvals);
  const order = [];
  const runner = {
    async runInTransaction(callback) {
      const result = await base.runInTransaction(callback);
      order.push('commit');
      return result;
    },
  };
  const realRecord = approvals.recordExecuted.bind(approvals);
  approvals.recordExecuted = async (companyId, approval, actorId) => {
    order.push('recordExecuted');
    return realRecord(companyId, approval, actorId);
  };
  let clock = 0;
  let seq = 0;
  const service = createInboxService({
    store,
    approvals,
    transactions: runner,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    newId: () => `id_${++seq}`,
  });
  const r = await service.recordInbound(CO_A, inbound());
  await service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: AGENT.id });
  const draft = await service.createDraft(CO_A, AGENT, r.thread.id, 'Monday works.');
  const awaiting = await service.requestSend(CO_A, AGENT, draft.id);

  approvals.decide(awaiting.approvalId, 'approved');
  const queued = await service.applyApprovalDecision(CO_A, draft.id);

  assert.equal(queued.status, 'queued');
  assert.equal(approvals.isExecuted(awaiting.approvalId), true);
  assert.deepEqual(order, ['commit', 'recordExecuted'], 'audit must follow the commit, once');
  assert.deepEqual(approvals.executedAudit, [{ companyId: CO_A, id: awaiting.approvalId, actorId: null }]);
});

test('send atomic: a failed write writes no execution audit', async () => {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  let clock = 0;
  let seq = 0;
  const service = createInboxService({
    store,
    approvals,
    transactions: createInMemoryTransactionRunner(store, approvals),
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    newId: () => `id_${++seq}`,
  });
  const r = await service.recordInbound(CO_A, inbound());
  await service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: AGENT.id });
  const draft = await service.createDraft(CO_A, AGENT, r.thread.id, 'Monday works.');
  const awaiting = await service.requestSend(CO_A, AGENT, draft.id);
  store.updateMessage = async () => {
    throw new Error('disk full');
  };
  approvals.decide(awaiting.approvalId, 'approved');

  await assert.rejects(service.applyApprovalDecision(CO_A, draft.id), /disk full/);
  assert.equal(approvals.isExecuted(awaiting.approvalId), false);
  assert.deepEqual(approvals.executedAudit, []);
});

// --- the Drizzle placeholder ------------------------------------------------

test('drizzle placeholder: every method throws until the migration is promoted', async () => {
  const { createDrizzleInboxStore } = await import('../../server/modules/inbox/index.ts');
  const store = createDrizzleInboxStore();
  await assert.rejects(store.findThread(CO_A, 'x'), /DRAFT_inbox\.sql/);
  await assert.rejects(store.insertMessage({ companyId: CO_A }), /DRAFT_inbox\.sql/);
  await assert.rejects(createInboxService({ store, approvals: new InMemoryApprovalPort() }).listThreads(CO_A), /DRAFT_inbox\.sql/);
});

test('PostgreSQL InboxStore factory is exported without activating the legacy placeholder',async()=>{
 const {createSqlInboxStore}=await import('../../server/modules/inbox/index.ts');
 assert.equal(typeof createSqlInboxStore,'function');
 assert.throws(()=>createSqlInboxStore(null),/PostgreSQL pool/);
});

test('verified Inbox constructor refuses missing RLS and approvals rather than silently mounting',async()=>{
 const {createVerifiedInboxService}=await import('../../server/modules/inbox/production-service.ts');
 await assert.rejects(createVerifiedInboxService({pool:{connect:async()=>({})}}),/approval port/);
});

test('approval decisions resolve the transaction runner using the request company',async()=>{
 const store=new InMemoryInboxStore(),approvals=new InMemoryApprovalPort();
 const base=createInMemoryTransactionRunner(store,approvals),companies=[];
 let sequence=0;
 const service=createInboxService({store,approvals,transactionsFor:companyId=>{companies.push(companyId);return base;},newId:()=>`factory-id-${++sequence}`});
 const input={channel:'sms',address:'+61400000001',body:'Hello',externalId:'factory-inbound'};
 const result=await service.recordInbound(CO_B,input);
 await service.assignThread(CO_B,AGENT,result.thread.id,{kind:'agent',id:AGENT.id});
 const draft=await service.createDraft(CO_B,AGENT,result.thread.id,'Approved reply');
 const awaiting=await service.requestSend(CO_B,AGENT,draft.id);
 approvals.decide(awaiting.approvalId,'approved');
 assert.equal((await service.applyApprovalDecision(CO_B,draft.id)).status,'queued');
 assert.deepEqual(companies,[CO_B]);
});

test('canonical approval adapter is exported for verified Inbox composition',async()=>{
 const {createInboxApprovalPort}=await import('../../server/modules/inbox/index.ts');
 assert.equal(typeof createInboxApprovalPort,'function');
 assert.throws(()=>createInboxApprovalPort(null),/canonical approval/);
});

test('canonical production approval factory rejects missing durable PostgreSQL',async()=>{
 const {createCanonicalInboxApprovalService}=await import('../../server/modules/inbox/canonical-production-approval.ts');
 await assert.rejects(createCanonicalInboxApprovalService(null),/PostgreSQL pool/);
});
