// Campaign transport sends pass the pre-send gate immediately before the transport. Here the
// per-send consent check is overridden to allow everything, so only the gate can stop the send.
// Node test runner, no database, no network. The transport is a recording fake and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', id: 'user-1' };

// Clock reads 00:00 UTC on 2026-11-02 for every call.
function setup({ quietHours = null } = {}) {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  const blocked = [];
  let seq = 0;
  let clock = 0;
  const service = createCampaignService({
    store,
    approvals,
    transport,
    newId: () => `id_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    consent: () => ({ allowed: true }),
    quietHours: () => (quietHours ? { quietHours, timezone: 'UTC' } : null),
    onSendBlocked: (record) => {
      blocked.push(record);
    },
  });
  return { store, approvals, transport, service, blocked };
}

async function queuedJob(ctx) {
  const s = ctx.service;
  const audience = await s.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  await s.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'], timezone: 'UTC' });
  await s.recordOptIn(CO_A, { channel: 'email', address: 'ana@example.com', source: 'web form' });
  const campaign = await s.createCampaign(CO_A, { name: 'Spring offer', channel: 'email', audienceId: audience.id });
  const step = await s.addStep(CO_A, campaign.id, { subject: 'Hello', body: 'Spring offer inside.' });
  await s.activateCampaign(CO_A, HUMAN, campaign.id);
  ctx.approvals.nextState = 'approved';
  const req = await s.requestSend(CO_A, HUMAN, campaign.id, step.id);
  assert.equal(req.queued, 1);
  const [job] = await s.listJobs(CO_A, { approvalId: req.approvalId });
  return job;
}

test('the gate blocks quiet hours even when the per-send consent check allows: no transport call, job returned to queued, block recorded', async () => {
  const ctx = setup({ quietHours: { startHour: 0, endHour: 6 } });
  const job = await queuedJob(ctx);
  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'queued');
  assert.equal(ctx.transport.calls.length, 0);
  assert.equal(ctx.blocked.length, 1);
  assert.equal(ctx.blocked[0].reason, 'quiet_hours');
  assert.equal(ctx.blocked[0].surface, 'marketing');
  assert.equal(ctx.blocked[0].companyId, CO_A);
});

test('a send that passes every rule still reaches the transport once', async () => {
  const ctx = setup({ quietHours: null });
  const job = await queuedJob(ctx);
  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'sent');
  assert.equal(ctx.transport.calls.length, 1);
  assert.equal(ctx.blocked.length, 0);
});
