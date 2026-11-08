// Open checklist item: company quiet hours (server/modules/settings/company-settings.ts) must be
// enforced on the campaign send path with the default wiring. The service is built the way the
// campaign-service test harness builds it, with only the required deps: no companySettings, no
// deps.quietHours. A send inside the company's quiet hours must not reach the transport and must
// be requeued. Node test runner, no database, no network. The transport is a recording fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', id: 'user-1' };

// Clock starts at 00:00:00 UTC on 2026-11-02 and advances one second per read, so every read
// falls in hour 0 UTC, inside the 00:00 to 06:00 quiet window set below.
function setupDefaultWiring() {
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
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
  });
  return { store, approvals, transport, service };
}

async function queuedJob(ctx) {
  const s = ctx.service;
  const audience = await s.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  await s.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'] });
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

test('company quiet hours set in the company settings store hold a send inside the window and requeue it under default wiring', async () => {
  const companySettings = createCompanySettingsStore();
  const set = companySettings.setQuietHours(CO_A, { startHour: 0, endHour: 6, timezone: 'UTC' });
  assert.equal(set.ok, true);

  const ctx = setupDefaultWiring();
  const job = await queuedJob(ctx);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'queued', 'a send inside company quiet hours must be requeued');
  assert.equal(result.skipReason, null);
  assert.equal(ctx.transport.calls.length, 0, 'the transport must not be called inside company quiet hours');
});
