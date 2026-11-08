// Campaigns module tests (node:test). No database, no network, no provider. The transport is a
// recording fake that never sends. The approvals gate is an in-memory fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  CampaignError,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
  normaliseAddress,
  recipientsHash,
  contentHash,
} from '../../server/modules/campaigns/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const HUMAN = { kind: 'human', id: 'user-1' };
const AGENT = { kind: 'agent', id: 'agent-7' };

function build({ withTransport = true } = {}) {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  let seq = 0;
  let clock = 0;
  const service = createCampaignService({
    store,
    approvals,
    transport: withTransport ? transport : undefined,
    newId: () => `id_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
  });
  return { store, approvals, transport, service };
}

/**
 * Builds an active email campaign with one step. Audience is tag "vip". Contacts:
 *   ana, ben   opted in, subscribed        -> eligible
 *   cal        tagged, no opt-in           -> excluded no_opt_in
 *   dee        opted in but unsubscribed   -> excluded unsubscribed
 *   eve        opted in, no vip tag        -> not in audience
 */
async function activeCampaign(ctx, companyId = CO_A) {
  const s = ctx.service;
  const audience = await s.defineAudience(companyId, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  const contacts = {};
  for (const [key, address, tags] of [
    ['ana', 'Ana@Example.com', ['vip']],
    ['ben', 'ben@example.com', ['vip']],
    ['cal', 'cal@example.com', ['vip']],
    ['dee', 'dee@example.com', ['vip']],
    ['eve', 'eve@example.com', []],
  ]) {
    contacts[key] = await s.addContact(companyId, { channel: 'email', address, tags });
  }
  await s.recordOptIn(companyId, { channel: 'email', address: 'ana@example.com', source: 'web form' });
  await s.recordOptIn(companyId, { channel: 'email', address: 'ben@example.com', source: 'web form' });
  await s.recordOptIn(companyId, { channel: 'email', address: 'dee@example.com', source: 'web form' });
  await s.recordOptIn(companyId, { channel: 'email', address: 'eve@example.com', source: 'web form' });
  await s.unsubscribe(companyId, { channel: 'email', address: 'dee@example.com', reason: 'link' });

  const campaign = await s.createCampaign(companyId, { name: 'Spring offer', channel: 'email', audienceId: audience.id });
  const step = await s.addStep(companyId, campaign.id, { subject: 'Hello', body: 'Spring offer inside.' });
  const active = await s.activateCampaign(companyId, HUMAN, campaign.id);
  return { audience, contacts, campaign: active, step };
}

// --- contacts, audiences and consent --------------------------------------

test('addContact: lowercases email, dedupes by address, validates E.164 for sms', async () => {
  const ctx = build();
  const a = await ctx.service.addContact(CO_A, { channel: 'email', address: ' Ana@Example.COM ' });
  const again = await ctx.service.addContact(CO_A, { channel: 'email', address: 'ana@example.com' });
  assert.equal(a.address, 'ana@example.com');
  assert.equal(again.id, a.id);

  await assert.rejects(ctx.service.addContact(CO_A, { channel: 'sms', address: '0400 000 000' }), (e) => e.code === 'invalid');
  const sms = await ctx.service.addContact(CO_A, { channel: 'sms', address: '+61400000001' });
  assert.equal(sms.address, '+61400000001');
});

test('defineAudience: needs at least one tag and a known channel', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.defineAudience(CO_A, { name: 'x', channel: 'email', tagsAll: [] }), (e) => e.code === 'invalid');
  await assert.rejects(ctx.service.defineAudience(CO_A, { name: 'x', channel: 'fax', tagsAll: ['a'] }), (e) => e.code === 'invalid');
});

test('resolveAudience: only tagged, opted-in, subscribed contacts are eligible', async () => {
  const ctx = build();
  const { audience } = await activeCampaign(ctx);
  const r = await ctx.service.resolveAudience(CO_A, audience.id);

  assert.deepEqual(r.eligible.map((c) => c.address).sort(), ['ana@example.com', 'ben@example.com']);
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.contact.address, e.reason]));
  assert.deepEqual(reasons, { 'cal@example.com': 'no_opt_in', 'dee@example.com': 'unsubscribed' });
  assert.equal(r.optInCount, 4);
});

test('unsubscribe: wins over an active opt-in, even when opted in after the unsubscribe', async () => {
  const ctx = build();
  await ctx.service.unsubscribe(CO_A, { channel: 'email', address: 'ana@example.com' });
  await ctx.service.recordOptIn(CO_A, { channel: 'email', address: 'ana@example.com', source: 're-import' });
  const audience = await ctx.service.defineAudience(CO_A, { name: 'All', channel: 'email', tagsAll: ['vip'] });
  await ctx.service.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'] });
  const r = await ctx.service.resolveAudience(CO_A, audience.id);
  assert.equal(r.eligible.length, 0);
  assert.equal(r.excluded[0].reason, 'unsubscribed');
});

test('refuse: an audience with no opt-in record at all cannot be sent to', async () => {
  const ctx = build();
  const audience = await ctx.service.defineAudience(CO_A, { name: 'Cold', channel: 'email', tagsAll: ['vip'] });
  await ctx.service.addContact(CO_A, { channel: 'email', address: 'cold@example.com', tags: ['vip'] });
  const campaign = await ctx.service.createCampaign(CO_A, { name: 'Cold', channel: 'email', audienceId: audience.id });
  const step = await ctx.service.addStep(CO_A, campaign.id, { subject: 's', body: 'b' });
  await ctx.service.activateCampaign(CO_A, HUMAN, campaign.id);

  await assert.rejects(ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id), (e) => e instanceof CampaignError && e.code === 'refused');
  assert.equal(ctx.approvals.requests.length, 0, 'no approval is even requested');
});

test('refuse: when every member is unsubscribed or has no opt-in, nothing is requested', async () => {
  const ctx = build();
  const audience = await ctx.service.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  await ctx.service.addContact(CO_A, { channel: 'email', address: 'x@example.com', tags: ['vip'] });
  await ctx.service.recordOptIn(CO_A, { channel: 'email', address: 'someone-else@example.com', source: 'form' });
  const campaign = await ctx.service.createCampaign(CO_A, { name: 'C', channel: 'email', audienceId: audience.id });
  const step = await ctx.service.addStep(CO_A, campaign.id, { subject: 's', body: 'b' });
  await ctx.service.activateCampaign(CO_A, HUMAN, campaign.id);

  await assert.rejects(ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id), (e) => e.code === 'refused');
  assert.equal(ctx.approvals.requests.length, 0);
});

// --- campaign setup --------------------------------------------------------

test('activation: only a human may activate, and only after a step exists', async () => {
  const ctx = build();
  const audience = await ctx.service.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  const campaign = await ctx.service.createCampaign(CO_A, { name: 'C', channel: 'email', audienceId: audience.id });

  await assert.rejects(ctx.service.activateCampaign(CO_A, AGENT, campaign.id), (e) => e.code === 'forbidden');
  await assert.rejects(ctx.service.activateCampaign(CO_A, HUMAN, campaign.id), (e) => e.code === 'conflict');
  await ctx.service.addStep(CO_A, campaign.id, { subject: 's', body: 'b' });
  assert.equal((await ctx.service.activateCampaign(CO_A, HUMAN, campaign.id)).status, 'active');
});

test('steps: email needs a subject, sms takes none, and steps cannot be added once active', async () => {
  const ctx = build();
  const audience = await ctx.service.defineAudience(CO_A, { name: 'S', channel: 'sms', tagsAll: ['vip'] });
  const sms = await ctx.service.createCampaign(CO_A, { name: 'S', channel: 'sms', audienceId: audience.id });
  await assert.rejects(ctx.service.addStep(CO_A, sms.id, { subject: 'nope', body: 'b' }), (e) => e.code === 'invalid');
  const step = await ctx.service.addStep(CO_A, sms.id, { body: 'b', delayHours: 2 });
  assert.equal(step.position, 1);
  assert.equal(step.subject, null);

  const email = await ctx.service.createCampaign(CO_A, { name: 'E', channel: 'email', audienceId: audience.id }).catch(() => null);
  assert.equal(email, null, 'email campaign cannot target an sms audience');

  await ctx.service.activateCampaign(CO_A, HUMAN, sms.id);
  await assert.rejects(ctx.service.addStep(CO_A, sms.id, { body: 'late' }), (e) => e.code === 'conflict');
});

// --- the send path ---------------------------------------------------------

test('requestSend: creates jobs for eligible and excluded recipients, sends nothing, and waits for approval', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const r = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);

  assert.equal(r.state, 'awaiting_approval');
  assert.equal(r.queued, 0);
  assert.equal(ctx.transport.calls.length, 0);

  const req = ctx.approvals.requests[0];
  assert.equal(req.action, 'campaigns.send_step');
  assert.equal(req.requestedBy, HUMAN.id);
  assert.equal(req.agentId, null);
  assert.equal(req.params.recipientCount, 2);
  assert.equal(req.params.bodySha256, contentHash(step));

  const jobs = await ctx.service.listJobs(CO_A, { stepId: step.id });
  assert.equal(jobs.filter((j) => j.status === 'awaiting_approval').length, 2);
  assert.equal(jobs.filter((j) => j.status === 'skipped').length, 2);
  assert.deepEqual(
    jobs.filter((j) => j.status === 'skipped').map((j) => j.skipReason).sort(),
    ['no_opt_in', 'unsubscribed'],
  );
});

test('dispatch: a job still awaiting approval cannot be sent', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  const [job] = (await ctx.service.listJobs(CO_A, { stepId: step.id })).filter((j) => j.status === 'awaiting_approval');

  await assert.rejects(ctx.service.dispatchJob(CO_A, job.id), (e) => e.code === 'conflict');
  assert.equal(ctx.transport.calls.length, 0);
});

test('approve: releasing queues only the eligible jobs and marks the approval executed', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');

  const r = await ctx.service.releaseApproved(CO_A, req.approvalId);
  assert.deepEqual(r, { state: 'released', queued: 2, skipped: 0 });
  assert.equal(ctx.approvals.isExecuted(req.approvalId), true);
  assert.equal(ctx.transport.calls.length, 0, 'release does not send');
});

test('dispatch: after approval, each queued job is sent once to its own address, and excluded contacts never are', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  await ctx.service.releaseApproved(CO_A, req.approvalId);

  const queued = await ctx.service.listJobs(CO_A, { approvalId: req.approvalId });
  for (const job of queued.filter((j) => j.status === 'queued')) {
    const sent = await ctx.service.dispatchJob(CO_A, job.id);
    assert.equal(sent.status, 'sent');
    assert.match(sent.externalId, /^fake_/);
  }
  assert.deepEqual(ctx.transport.calls.map((c) => c.address).sort(), ['ana@example.com', 'ben@example.com']);
  assert.equal(ctx.transport.calls.some((c) => c.address.includes('cal') || c.address.includes('dee')), false);
  assert.equal(ctx.transport.calls[0].body, 'Spring offer inside.');
});

test('unsubscribe after release but before dispatch: the job is skipped and the transport is not called', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  await ctx.service.releaseApproved(CO_A, req.approvalId);

  await ctx.service.unsubscribe(CO_A, { channel: 'email', address: 'ana@example.com', reason: 'stop' });
  const ana = (await ctx.service.listJobs(CO_A, { approvalId: req.approvalId })).find((j) => j.address === 'ana@example.com');
  const result = await ctx.service.dispatchJob(CO_A, ana.id);

  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'unsubscribed');
  assert.deepEqual(ctx.transport.calls.map((c) => c.address), []);
});

test('unsubscribe between request and approval: release skips that address and queues the rest', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  await ctx.service.unsubscribe(CO_A, { channel: 'email', address: 'ben@example.com' });
  ctx.approvals.decide(req.approvalId, 'approved');

  const r = await ctx.service.releaseApproved(CO_A, req.approvalId);
  assert.deepEqual(r, { state: 'released', queued: 1, skipped: 1 });
  const ben = (await ctx.service.listJobs(CO_A, { approvalId: req.approvalId })).find((j) => j.address === 'ben@example.com');
  assert.equal(ben.skipReason, 'unsubscribed');
});

test('rejected approval: every awaiting job is skipped and nothing is sent', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'rejected');

  const r = await ctx.service.releaseApproved(CO_A, req.approvalId);
  assert.equal(r.state, 'rejected');
  assert.equal(r.skipped, 2);
  const jobs = await ctx.service.listJobs(CO_A, { approvalId: req.approvalId });
  assert.ok(jobs.every((j) => j.status === 'skipped'));
  assert.equal(ctx.transport.calls.length, 0);
});

test('expired approval behaves like rejected: nothing is queued', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'expired');
  const r = await ctx.service.releaseApproved(CO_A, req.approvalId);
  assert.equal(r.state, 'expired');
  assert.equal(r.queued, 0);
});

test('tamper: step content changed after approval is refused and nothing is queued', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  // The step row is edited underneath the approval.
  const row = await ctx.store.findStep(CO_A, step.id);
  row.body = 'Different offer, not the one approved.';
  ctx.store.findStep = async () => row;

  await assert.rejects(ctx.service.releaseApproved(CO_A, req.approvalId), (e) => e.code === 'conflict' && /content/.test(e.message));
  assert.equal((await ctx.service.listJobs(CO_A, { approvalId: req.approvalId })).filter((j) => j.status === 'queued').length, 0);
});

test('tamper: an approval whose recipient hash does not match the approved batch is refused', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  const approval = await ctx.approvals.getApproval(CO_A, req.approvalId);
  approval.params = { ...approval.params, recipientsSha256: recipientsHash([{ channel: 'email', address: 'someone@example.com' }]) };
  ctx.approvals.getApproval = async () => approval;

  await assert.rejects(ctx.service.releaseApproved(CO_A, req.approvalId), (e) => e.code === 'conflict' && /Recipient/.test(e.message));
});

test('release twice does not queue twice; the second call reports nothing to release', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  await ctx.service.releaseApproved(CO_A, req.approvalId);
  const again = await ctx.service.releaseApproved(CO_A, req.approvalId);
  assert.equal(again.state, 'nothing_to_release');
  assert.equal(again.queued, 0);
});

test('duplicate requestSend for the same step is refused while a send is live', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  await assert.rejects(ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id), (e) => e.code === 'conflict');
  assert.equal(ctx.approvals.requests.length, 1);
});

test('requestSend: a campaign that is not active cannot send, and a step must belong to its campaign', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const other = await ctx.service.createCampaign(CO_A, { name: 'Other', channel: 'email', audienceId: (await ctx.service.defineAudience(CO_A, { name: 'O', channel: 'email', tagsAll: ['vip'] })).id });
  await assert.rejects(ctx.service.requestSend(CO_A, HUMAN, other.id, step.id), (e) => e.code === 'conflict');
  await assert.rejects(ctx.service.requestSend(CO_A, HUMAN, campaign.id, 'missing'), (e) => e.code === 'not_found');
});

test('gate: an agent launch at assist or suggest is forbidden before any approval is requested', async () => {
  for (const autonomy of ['assist', 'suggest']) {
    const ctx = build();
    const { campaign, step } = await activeCampaign(ctx);
    ctx.approvals.nextState = 'approved';
    await assert.rejects(
      ctx.service.requestSend(CO_A, { ...AGENT, autonomy }, campaign.id, step.id),
      (e) => e instanceof CampaignError && e.code === 'forbidden',
    );
    assert.equal(ctx.approvals.requests.length, 0, `no approval is requested at ${autonomy}`);
  }
});

test('dispatch: a transport failure marks the job failed and it is not retried silently', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  await ctx.service.releaseApproved(CO_A, req.approvalId);
  const [first, second] = (await ctx.service.listJobs(CO_A, { approvalId: req.approvalId })).filter((j) => j.status === 'queued');

  ctx.transport.failNext = true;
  assert.equal((await ctx.service.dispatchJob(CO_A, first.id)).status, 'failed');
  await assert.rejects(ctx.service.dispatchJob(CO_A, first.id), (e) => e.code === 'conflict');
  assert.equal((await ctx.service.dispatchJob(CO_A, second.id)).status, 'sent');
});

test('dispatch: a queued job is not sent if its approval is no longer approved', async () => {
  const ctx = build();
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  await ctx.service.releaseApproved(CO_A, req.approvalId);
  const job = (await ctx.service.listJobs(CO_A, { approvalId: req.approvalId })).find((j) => j.status === 'queued');

  ctx.approvals.decide(req.approvalId, 'rejected');
  await assert.rejects(ctx.service.dispatchJob(CO_A, job.id), (e) => e.code === 'forbidden');
  assert.equal(ctx.transport.calls.length, 0);
});

test('dispatch: with no transport configured, nothing can leave the module', async () => {
  const ctx = build({ withTransport: false });
  const { campaign, step } = await activeCampaign(ctx);
  const req = await ctx.service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  ctx.approvals.decide(req.approvalId, 'approved');
  await ctx.service.releaseApproved(CO_A, req.approvalId);
  const job = (await ctx.service.listJobs(CO_A, { approvalId: req.approvalId })).find((j) => j.status === 'queued');
  await assert.rejects(ctx.service.dispatchJob(CO_A, job.id), /No send transport/);
});

// --- company scope --------------------------------------------------------

test('scope: audiences, contacts and campaigns are invisible to another company', async () => {
  const ctx = build();
  const { audience, campaign, step } = await activeCampaign(ctx, CO_A);

  await assert.rejects(ctx.service.resolveAudience(CO_B, audience.id), (e) => e.code === 'not_found');
  await assert.rejects(ctx.service.requestSend(CO_B, HUMAN, campaign.id, step.id), (e) => e.code === 'conflict' || e.code === 'not_found');
  assert.deepEqual(await ctx.service.listJobs(CO_B), []);
  // Company B has no contacts, so this is refused on the opt-in check, not sent.
  const bAudience = await ctx.service.defineAudience(CO_B, { name: 'B', channel: 'email', tagsAll: ['vip'] });
  assert.equal((await ctx.service.resolveAudience(CO_B, bAudience.id)).optInCount, 0);
});

test('scope: an opt-in or unsubscribe in company B does not affect company A', async () => {
  const ctx = build();
  const { audience } = await activeCampaign(ctx, CO_A);
  await ctx.service.unsubscribe(CO_B, { channel: 'email', address: 'ana@example.com' });
  const r = await ctx.service.resolveAudience(CO_A, audience.id);
  assert.ok(r.eligible.some((c) => c.address === 'ana@example.com'));
});

test('scope: a missing or blank companyId fails closed', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.addContact('  ', { channel: 'email', address: 'a@example.com' }), /Company scope required/);
  await assert.rejects(ctx.service.listJobs(''), /Company scope required/);
});

// --- helpers and the Drizzle placeholder -----------------------------------

test('normaliseAddress and hashes are stable and order-independent where they should be', () => {
  assert.equal(normaliseAddress('email', '  X@Y.co '), 'x@y.co');
  assert.throws(() => normaliseAddress('sms', '0400'), CampaignError);
  const a = [{ channel: 'email', address: 'a@x.co' }, { channel: 'email', address: 'b@x.co' }];
  assert.equal(recipientsHash(a), recipientsHash([...a].reverse()));
  assert.notEqual(recipientsHash(a), recipientsHash([a[0]]));
});

test('drizzle placeholder: every method throws until the migration is promoted', async () => {
  const { createDrizzleCampaignStore } = await import('../../server/modules/campaigns/index.ts');
  const store = createDrizzleCampaignStore();
  await assert.rejects(store.findCampaign(CO_A, 'x'), /DRAFT_campaigns\.sql/);
  await assert.rejects(store.transitionJob(CO_A, 'x', 'queued', {}), /DRAFT_campaigns\.sql/);
});
