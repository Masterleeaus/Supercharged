// Suppression list and company quiet hours on the campaign send path (dispatchJob).
// Node test runner, no database, no network. The transport is a recording fake and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', id: 'user-1' };

// Clock starts at 00:00:00 UTC on 2026-11-02 and advances one second per read, so every read
// falls in hour 0 UTC.
function setup({ suppression, companySettings, quietHours } = {}) {
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
    ...(suppression ? { suppression } : {}),
    ...(companySettings ? { companySettings } : {}),
    ...(quietHours ? { quietHours: () => quietHours } : {}),
  });
  return { store, approvals, transport, service };
}

/** Active email campaign to one opted-in, subscribed contact. Released, so the job is queued. */
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

test('suppressed contact: skipped with reason suppressed and the transport is never called', async () => {
  const suppression = createSuppressionList();
  const ctx = setup({ suppression });
  const job = await queuedJob(ctx);
  const res = suppression.suppress(CO_A, { address: 'ana@example.com', channel: 'email', reason: 'bounce_hard' });
  assert.equal(res.ok && res.suppressed, true);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'suppressed');
  assert.equal(ctx.transport.calls.length, 0);
});

test('suppressed contact: a suppression recorded after release still stops the send', async () => {
  const suppression = createSuppressionList();
  const ctx = setup({ suppression });
  const job = await queuedJob(ctx);
  suppression.suppress(CO_A, { address: 'ana@example.com', channel: 'email', reason: 'complaint' });

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.skipReason, 'suppressed');
  assert.equal(ctx.transport.calls.length, 0);
});

test('suppressed contact in another company does not block this company', async () => {
  const suppression = createSuppressionList();
  const ctx = setup({ suppression });
  const job = await queuedJob(ctx);
  suppression.suppress('22222222-2222-4222-8222-222222222222', { address: 'ana@example.com', channel: 'email', reason: 'complaint' });

  const sent = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(ctx.transport.calls.length, 1);
});

test('no suppression dependency: the check is skipped and the send goes through as before', async () => {
  const ctx = setup();
  const job = await queuedJob(ctx);

  const sent = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(ctx.transport.calls.length, 1);
});

test('company quiet hours inside the window: the job is requeued and the transport is not called', async () => {
  const companySettings = createCompanySettingsStore({});
  companySettings.setQuietHours(CO_A, { startHour: 0, endHour: 6, timezone: 'UTC' });
  const ctx = setup({ companySettings });
  const job = await queuedJob(ctx);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'queued');
  assert.equal(result.skipReason, null);
  assert.equal(ctx.transport.calls.length, 0);
});

test('company quiet hours outside the window: the send goes through', async () => {
  const companySettings = createCompanySettingsStore({});
  companySettings.setQuietHours(CO_A, { startHour: 12, endHour: 18, timezone: 'UTC' });
  const ctx = setup({ companySettings });
  const job = await queuedJob(ctx);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'sent');
  assert.equal(ctx.transport.calls.length, 1);
});

test('company quiet hours take precedence over deps.quietHours', async () => {
  const companySettings = createCompanySettingsStore({});
  companySettings.setQuietHours(CO_A, { startHour: 12, endHour: 18, timezone: 'UTC' });
  // deps.quietHours would hold the send (window covers hour 0), but the company setting wins.
  const ctx = setup({ companySettings, quietHours: { quietHours: { startHour: 0, endHour: 6 }, timezone: 'UTC' } });
  const job = await queuedJob(ctx);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'sent');
});

test('company settings store with no setting for the company: deps.quietHours still applies', async () => {
  const companySettings = createCompanySettingsStore({});
  const ctx = setup({ companySettings, quietHours: { quietHours: { startHour: 0, endHour: 6 }, timezone: 'UTC' } });
  const job = await queuedJob(ctx);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'queued');
  assert.equal(ctx.transport.calls.length, 0);
});

test('company without settings sends as before', async () => {
  const companySettings = createCompanySettingsStore({});
  const ctx = setup({ companySettings });
  const job = await queuedJob(ctx);

  const sent = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(ctx.transport.calls.length, 1);
});
