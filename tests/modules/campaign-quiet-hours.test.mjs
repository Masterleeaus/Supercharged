// Quiet hours on the campaign send path. A quiet-hours refusal returns the job to 'queued' so a
// later dispatch can send it; the transport is never called for a refused job.
// Node test runner, no database, no network. The transport is a recording fake and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createCampaignService,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', id: 'user-1' };

// Clock starts at 00:00:00 UTC on 2026-11-02 and advances one second per read, so every read
// falls in hour 0 UTC.
function setup({ quietHours = null } = {}) {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  let seq = 0;
  let clock = 0;
  const window = { value: quietHours };
  const service = createCampaignService({
    store,
    approvals,
    transport,
    newId: () => `id_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    quietHours: () => (window.value ? { quietHours: window.value, timezone: 'UTC' } : null),
  });
  return { store, approvals, transport, service, window };
}

async function queuedJobs(ctx) {
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

test('quiet hours: a refused send does not call the transport and the job is returned to queued', async () => {
  const ctx = setup({ quietHours: { startHour: 0, endHour: 6 } });
  const job = await queuedJobs(ctx);

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'queued');
  assert.equal(result.skipReason, null);
  assert.equal(ctx.transport.calls.length, 0);
});

test('quiet hours: a job held back by quiet hours is sent by a later dispatch once the window has passed', async () => {
  const ctx = setup({ quietHours: { startHour: 0, endHour: 6 } });
  const job = await queuedJobs(ctx);

  const held = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(held.status, 'queued');

  ctx.window.value = { startHour: 23, endHour: 23 }; // equal start and end: no window
  const sent = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(ctx.transport.calls.filter((c) => c.address === 'ana@example.com').length, 1);
});

test('no quiet-hours setting: the send goes through, so the check is not applied by default', async () => {
  const ctx = setup();
  const job = await queuedJobs(ctx);

  const sent = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(ctx.transport.calls.length, 1);
});

test('a permanent consent refusal is still skipped with its reason, not returned to queued', async () => {
  const ctx = setup({ quietHours: { startHour: 0, endHour: 6 } });
  const job = await queuedJobs(ctx);
  await ctx.service.unsubscribe(CO_A, { channel: 'email', address: 'ana@example.com', reason: 'link' });

  const result = await ctx.service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'unsubscribed');
  assert.equal(ctx.transport.calls.length, 0);
});

test('the consent-refusal cast is gone from campaign-service.ts', () => {
  const src = readFileSync(new URL('../../server/modules/campaigns/campaign-service.ts', import.meta.url), 'utf8');
  assert.equal(/decision\.reason\s+as\s+SkipReason/.test(src), false);
});

test('SkipReason accepts the consent refusal values', () => {
  const src = readFileSync(new URL('../../server/modules/campaigns/types.ts', import.meta.url), 'utf8');
  for (const value of ['no_consent', 'channel_not_consented', 'opted_out', 'quiet_hours', 'invalid_contact']) {
    assert.match(src, new RegExp(`'${value}'`), `missing ${value} in SkipReason`);
  }
});
