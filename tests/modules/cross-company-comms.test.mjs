// Cross-company isolation for the campaigns and inbox in-memory services (node:test).
// Company A's records must never be readable, changeable or sendable by company B, and list
// calls for B must never include A's records. No database, no provider, no network.
// Operations covered are the ones the services expose today. Campaign single-record reads go
// through the CampaignStore port, because CampaignService has no getCampaign method.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  CampaignError,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';
import {
  createInboxService,
  InboxError,
  InMemoryInboxStore,
  InMemoryApprovalPort as InboxApprovalPort,
} from '../../server/modules/inbox/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const HUMAN = { kind: 'human', id: 'user-1' };
const AGENT = { kind: 'agent', id: 'agent-7' };

/** Asserts the promise rejects with a CampaignError of the given code (default not_found). */
async function assertCampaignRefused(promise, code = 'not_found') {
  await assert.rejects(promise, (err) => err instanceof CampaignError && err.code === code);
}

/** Asserts the promise rejects with an InboxError of the given code (default not_found). */
async function assertInboxRefused(promise, code = 'not_found') {
  await assert.rejects(promise, (err) => err instanceof InboxError && err.code === code);
}

// --- campaigns --------------------------------------------------------------

function buildCampaigns() {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  let seq = 0;
  let clock = 0;
  const service = createCampaignService({
    store,
    approvals,
    transport,
    newId: () => `cid_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, clock++)),
  });
  return { store, approvals, transport, service };
}

/** Company A: audience, one tagged opted-in contact, a draft campaign with one step. */
async function companyACampaign(ctx) {
  const s = ctx.service;
  const audience = await s.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  await s.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'] });
  await s.recordOptIn(CO_A, { channel: 'email', address: 'ana@example.com', source: 'web form' });
  const campaign = await s.createCampaign(CO_A, { name: 'Spring', channel: 'email', audienceId: audience.id });
  const step = await s.addStep(CO_A, campaign.id, { subject: 'Hello', body: 'A body for A only' });
  return { audienceId: audience.id, campaignId: campaign.id, stepId: step.id };
}

/** Everything about A's campaign that a cross-company attempt could change. */
async function campaignSnapshot(ctx, ids, approvalId = null) {
  return {
    campaign: await ctx.store.findCampaign(CO_A, ids.campaignId),
    audience: await ctx.store.findAudience(CO_A, ids.audienceId),
    steps: await ctx.store.listSteps(CO_A, ids.campaignId),
    jobs: await ctx.store.listJobs(CO_A, { campaignId: ids.campaignId }),
    approval: approvalId ? await ctx.approvals.getApproval(CO_A, approvalId) : null,
    executed: approvalId ? ctx.approvals.isExecuted(approvalId) : false,
    gateRequests: ctx.approvals.requests.length,
    transportCalls: ctx.transport.calls.length,
  };
}

test('campaigns: company B cannot read A campaign, audience or steps', async () => {
  const ctx = buildCampaigns();
  const ids = await companyACampaign(ctx);

  assert.equal(await ctx.store.findCampaign(CO_B, ids.campaignId), null, 'store.findCampaign leaks');
  assert.equal(await ctx.store.findAudience(CO_B, ids.audienceId), null, 'store.findAudience leaks');
  assert.equal(await ctx.store.findStep(CO_B, ids.stepId), null, 'store.findStep leaks');
  assert.deepEqual(await ctx.store.listSteps(CO_B, ids.campaignId), [], 'store.listSteps leaks');
  await assertCampaignRefused(ctx.service.resolveAudience(CO_B, ids.audienceId));
});

test('campaigns: company B cannot update A campaign or add a step to it', async () => {
  const ctx = buildCampaigns();
  const ids = await companyACampaign(ctx);
  const before = await campaignSnapshot(ctx, ids);

  // The campaign is still a draft, so an unscoped call would succeed. It must be refused.
  await assertCampaignRefused(ctx.service.activateCampaign(CO_B, HUMAN, ids.campaignId));
  assert.equal(await ctx.store.updateCampaign(CO_B, ids.campaignId, { status: 'cancelled', updatedAt: new Date() }), null);
  await assertCampaignRefused(ctx.service.addStep(CO_B, ids.campaignId, { subject: 'Hijack', body: 'B text' }));

  assert.deepEqual(await campaignSnapshot(ctx, ids), before, "A's campaign changed after B's attempts");
});

test('campaigns: company B cannot send A step, and A send state is unchanged', async () => {
  const ctx = buildCampaigns();
  const ids = await companyACampaign(ctx);
  await ctx.service.activateCampaign(CO_A, HUMAN, ids.campaignId);
  const before = await campaignSnapshot(ctx, ids);

  // The campaign is active now, so an unscoped requestSend would reach the gate. It must not.
  await assertCampaignRefused(ctx.service.requestSend(CO_B, HUMAN, ids.campaignId, ids.stepId));
  await assertCampaignRefused(ctx.service.requestSend(CO_B, AGENT, ids.campaignId, ids.stepId));

  assert.deepEqual(await campaignSnapshot(ctx, ids), before, "A's campaign changed after B's send attempts");
  assert.equal(ctx.transport.calls.length, 0, 'nothing reached the transport');
});

test('campaigns: company B cannot release, dispatch or read A queued send jobs', async () => {
  const ctx = buildCampaigns();
  const ids = await companyACampaign(ctx);
  await ctx.service.activateCampaign(CO_A, HUMAN, ids.campaignId);

  // A sends, with the gate approving, so A has a queued job and an executed approval.
  ctx.approvals.nextState = 'approved';
  const sent = await ctx.service.requestSend(CO_A, HUMAN, ids.campaignId, ids.stepId);
  const approvalId = sent.approvalId;
  assert.equal(sent.queued, 1, 'setup: A should have one queued job');
  const [job] = await ctx.store.listJobs(CO_A, { campaignId: ids.campaignId });
  assert.equal(job.status, 'queued', 'setup: A job should be queued');

  const before = await campaignSnapshot(ctx, ids, approvalId);

  await assertCampaignRefused(ctx.service.dispatchJob(CO_B, job.id));
  await assertCampaignRefused(ctx.service.releaseApproved(CO_B, approvalId));
  assert.equal(await ctx.store.findJob(CO_B, job.id), null, 'store.findJob leaks');
  assert.deepEqual(await ctx.service.listJobs(CO_B, { campaignId: ids.campaignId }), [], 'listJobs leaks');
  assert.equal(await ctx.approvals.getApproval(CO_B, approvalId), null, 'approvals.getApproval leaks');
  assert.equal(await ctx.approvals.markExecuted(CO_B, approvalId, null), null, 'approvals.markExecuted leaks');

  assert.deepEqual(await campaignSnapshot(ctx, ids, approvalId), before, "A's send state changed after B's attempts");
  assert.equal(ctx.transport.calls.length, 0, 'B dispatch must not reach the transport');
});

test('campaigns: list calls for company B never include A records', async () => {
  const ctx = buildCampaigns();
  const ids = await companyACampaign(ctx);
  await ctx.service.activateCampaign(CO_A, HUMAN, ids.campaignId);
  ctx.approvals.nextState = 'approved';
  await ctx.service.requestSend(CO_A, HUMAN, ids.campaignId, ids.stepId);

  // B creates its own contact so the list calls return something real to filter.
  await ctx.service.addContact(CO_B, { channel: 'email', address: 'bea@example.com', tags: [] });
  await ctx.service.recordOptIn(CO_B, { channel: 'email', address: 'bea@example.com', source: 'web form' });

  const bContacts = await ctx.store.listContacts(CO_B, 'email');
  assert.deepEqual(bContacts.map((c) => c.address), ['bea@example.com'], 'listContacts leaks A contacts');
  assert.deepEqual((await ctx.store.listOptIns(CO_B, 'email')).map((o) => o.address), ['bea@example.com'], 'listOptIns leaks');
  assert.deepEqual(await ctx.service.listJobs(CO_B), [], 'service.listJobs leaks A send jobs');
  assert.deepEqual(await ctx.service.listJobs(CO_B, { campaignId: ids.campaignId }), [], 'listJobs by campaign leaks');
  assert.deepEqual(await ctx.service.listJobs(CO_B, { stepId: ids.stepId }), [], 'listJobs by step leaks');
  assert.equal(await ctx.store.findContactByAddress(CO_B, 'email', 'ana@example.com'), null, 'A contact visible to B');
});

// --- inbox ------------------------------------------------------------------

function buildInbox() {
  const store = new InMemoryInboxStore();
  const approvals = new InboxApprovalPort();
  let clock = 0;
  let seq = 0;
  const service = createInboxService({
    store,
    approvals,
    now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, clock++)),
    newId: () => `iid_${++seq}`,
  });
  return { store, approvals, service };
}

/** Company A: inbound thread, assigned to an agent, with one agent draft. */
async function companyAThread(ctx) {
  const r = await ctx.service.recordInbound(CO_A, {
    channel: 'sms',
    address: '+61400000001',
    displayName: 'Ada',
    body: 'Can I move Friday?',
    externalId: 'ext-a-1',
  });
  await ctx.service.assignThread(CO_A, HUMAN, r.thread.id, { kind: 'agent', id: AGENT.id });
  const draft = await ctx.service.createDraft(CO_A, AGENT, r.thread.id, 'Yes, Monday works for A');
  return { threadId: r.thread.id, draftId: draft.id };
}

async function inboxSnapshot(ctx, ids) {
  return {
    thread: await ctx.store.findThread(CO_A, ids.threadId),
    messages: await ctx.service.listMessages(CO_A, ids.threadId),
    threads: await ctx.service.listThreads(CO_A),
    participants: await ctx.store.listThreadParticipants(CO_A, ids.threadId),
    gateRequests: ctx.approvals.requests.length,
  };
}

test('inbox: company B cannot read A thread or its messages', async () => {
  const ctx = buildInbox();
  const ids = await companyAThread(ctx);

  await assertInboxRefused(ctx.service.getThread(CO_B, ids.threadId));
  await assertInboxRefused(ctx.service.listMessages(CO_B, ids.threadId));
  assert.equal(await ctx.store.findThread(CO_B, ids.threadId), null, 'store.findThread leaks');
  assert.equal(await ctx.store.findMessage(CO_B, ids.draftId), null, 'store.findMessage leaks');
  assert.deepEqual(await ctx.store.listThreadParticipants(CO_B, ids.threadId), [], 'participants leak');
});

test('inbox: company B cannot assign A thread', async () => {
  const ctx = buildInbox();
  const ids = await companyAThread(ctx);
  const before = await inboxSnapshot(ctx, ids);

  await assertInboxRefused(ctx.service.assignThread(CO_B, HUMAN, ids.threadId, { kind: 'human', id: 'user-b' }));
  await assertInboxRefused(ctx.service.assignThread(CO_B, AGENT, ids.threadId, { kind: 'agent', id: AGENT.id }));
  await assertInboxRefused(ctx.service.assignThread(CO_B, HUMAN, ids.threadId, null));

  assert.deepEqual(await inboxSnapshot(ctx, ids), before, "A's thread changed after B's assign attempts");
});

test('inbox: company B cannot reply to or change A thread', async () => {
  const ctx = buildInbox();
  const ids = await companyAThread(ctx);
  const before = await inboxSnapshot(ctx, ids);

  await assertInboxRefused(ctx.service.createDraft(CO_B, HUMAN, ids.threadId, 'B reply'));
  await assertInboxRefused(ctx.service.createDraft(CO_B, AGENT, ids.threadId, 'B agent reply'));
  await assertInboxRefused(ctx.service.sendAsStaff(CO_B, HUMAN, ids.threadId, 'B direct send'));
  await assertInboxRefused(ctx.service.setThreadStatus(CO_B, HUMAN, ids.threadId, 'closed'));

  // B also tries to push A's existing draft through the gate, and to approve it.
  await assertInboxRefused(ctx.service.requestSend(CO_B, AGENT, ids.draftId));
  await assertInboxRefused(ctx.service.applyApprovalDecision(CO_B, ids.draftId));

  assert.deepEqual(await inboxSnapshot(ctx, ids), before, "A's thread changed after B's reply attempts");
  assert.equal(ctx.approvals.requests.length, 0, 'B must not reach the approvals gate');
});

test('inbox: list calls for company B never include A records', async () => {
  const ctx = buildInbox();
  const ids = await companyAThread(ctx);

  // B gets its own thread, using the same channel and the same externalId as A. Dedupe is per
  // company, so this must create a new message, not return A's message.
  const bInbound = await ctx.service.recordInbound(CO_B, {
    channel: 'sms',
    address: '+61400000001',
    body: 'B customer message',
    externalId: 'ext-a-1',
  });
  assert.equal(bInbound.duplicate, false, "B's inbound matched A's message by externalId");
  assert.notEqual(bInbound.thread.id, ids.threadId, "B's inbound joined A's thread");

  const bThreads = await ctx.service.listThreads(CO_B);
  assert.deepEqual(bThreads.map((t) => t.id), [bInbound.thread.id], 'listThreads leaks A threads');
  assert.deepEqual((await ctx.service.listThreads(CO_B, { assigneeId: AGENT.id })), [], 'listThreads by assignee leaks');
  assert.deepEqual((await ctx.service.listThreads(CO_B, { status: 'open' })).map((t) => t.id), [bInbound.thread.id], 'listThreads by status leaks');

  const bMessages = await ctx.service.listMessages(CO_B, bInbound.thread.id);
  assert.deepEqual(bMessages.map((m) => m.id), [bInbound.message.id], "B's message list leaks");
  await assertInboxRefused(ctx.service.listMessages(CO_B, ids.threadId));
  assert.equal(await ctx.store.findMessageByExternalId(CO_B, 'sms', 'ext-a-1').then((m) => m?.id), bInbound.message.id, 'externalId lookup leaks A');
});
