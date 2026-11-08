// Campaign launch and the authority ladder (node:test). In-memory fakes only: no database, no network,
// no provider. The transport is a recording fake that never sends.
const silence = () => {};
console.log = silence;
console.info = silence;
console.warn = silence;

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  CampaignError,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', id: 'user-1' };
const agent = (autonomy) => (autonomy === undefined
  ? { kind: 'agent', id: 'agent-7' }
  : { kind: 'agent', id: 'agent-7', autonomy });

function build() {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  let seq = 0;
  let clock = 0;
  const service = createCampaignService({
    store,
    approvals,
    transport,
    newId: () => `id_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 4, 0, 0, clock++)),
  });
  return { store, approvals, transport, service };
}

/** Active email campaign with one step and two opted-in, subscribed recipients. */
async function readyCampaign(ctx) {
  const s = ctx.service;
  const audience = await s.defineAudience(CO, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  for (const address of ['ana@example.com', 'ben@example.com']) {
    await s.addContact(CO, { channel: 'email', address, tags: ['vip'] });
    await s.recordOptIn(CO, { channel: 'email', address, source: 'web form' });
  }
  const campaign = await s.createCampaign(CO, { name: 'Spring', channel: 'email', audienceId: audience.id });
  const step = await s.addStep(CO, campaign.id, { subject: 'Hello', body: 'Plain body, no links.' });
  await s.activateCampaign(CO, HUMAN, campaign.id);
  return { campaign, step };
}

test('staff launch is not ladder-gated and still opens a pending approval', async () => {
  const ctx = build();
  const { campaign, step } = await readyCampaign(ctx);
  const result = await ctx.service.requestSend(CO, HUMAN, campaign.id, step.id);
  assert.equal(result.state, 'awaiting_approval');
  assert.equal(ctx.approvals.requests.length, 1);
  assert.equal(ctx.approvals.requests[0].agentId, null);
  assert.equal(ctx.transport.sent?.length ?? 0, 0);
});

for (const autonomy of ['auto', 'predictive']) {
  test(`agent-proposed launch at ${autonomy} opens an approval and queues nothing`, async () => {
    const ctx = build();
    const { campaign, step } = await readyCampaign(ctx);
    const result = await ctx.service.requestSend(CO, agent(autonomy), campaign.id, step.id);
    assert.equal(result.state, 'awaiting_approval');
    assert.equal(result.queued, 0);
    assert.equal(ctx.approvals.requests[0].agentId, 'agent-7');
    assert.equal(ctx.transport.sent?.length ?? 0, 0);
  });
}

for (const autonomy of ['assist', 'suggest']) {
  test(`agent at ${autonomy} cannot propose a bulk launch and no approval is opened`, async () => {
    const ctx = build();
    const { campaign, step } = await readyCampaign(ctx);
    await assert.rejects(
      ctx.service.requestSend(CO, agent(autonomy), campaign.id, step.id),
      (err) => err instanceof CampaignError && err.code === 'forbidden',
    );
    assert.equal(ctx.approvals.requests.length, 0);
  });
}

test('agent with no autonomy tier is refused (fail closed)', async () => {
  const ctx = build();
  const { campaign, step } = await readyCampaign(ctx);
  await assert.rejects(
    ctx.service.requestSend(CO, agent(undefined), campaign.id, step.id),
    (err) => err instanceof CampaignError && err.code === 'forbidden',
  );
  assert.equal(ctx.approvals.requests.length, 0);
});

test('agent launch auto-approved by a company policy (no human) is refused and nothing is queued', async () => {
  const ctx = build();
  ctx.approvals.nextState = 'approved';
  const { campaign, step } = await readyCampaign(ctx);
  await assert.rejects(
    ctx.service.requestSend(CO, agent('predictive'), campaign.id, step.id),
    (err) => err instanceof CampaignError && err.code === 'forbidden',
  );
  const jobs = await ctx.store.listJobs(CO, { campaignId: campaign.id });
  assert.equal(jobs.length, 0);
  assert.equal(ctx.transport.sent?.length ?? 0, 0);
});
