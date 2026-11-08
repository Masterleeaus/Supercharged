// Consent is checked again immediately before every campaign send (SyncedAt P1).
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

function setup() {
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

/**
 * Active email campaign to two opted-in, subscribed contacts (ana, ben). Approved and released,
 * so both jobs are queued and nothing has been sent. Returns the queued jobs keyed by address.
 */
async function queuedJobs(ctx) {
  const s = ctx.service;
  const audience = await s.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  await s.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'] });
  await s.addContact(CO_A, { channel: 'email', address: 'ben@example.com', tags: ['vip'] });
  await s.recordOptIn(CO_A, { channel: 'email', address: 'ana@example.com', source: 'web form' });
  await s.recordOptIn(CO_A, { channel: 'email', address: 'ben@example.com', source: 'web form' });
  const campaign = await s.createCampaign(CO_A, { name: 'Spring offer', channel: 'email', audienceId: audience.id });
  const step = await s.addStep(CO_A, campaign.id, { subject: 'Hello', body: 'Spring offer inside.' });
  await s.activateCampaign(CO_A, HUMAN, campaign.id);
  ctx.approvals.nextState = 'approved';
  const req = await s.requestSend(CO_A, HUMAN, campaign.id, step.id);
  assert.equal(req.queued, 2);
  const jobs = await s.listJobs(CO_A, { approvalId: req.approvalId });
  return Object.fromEntries(jobs.map((j) => [j.address, j]));
}

test('opted-out contact: an opt-out recorded after the first check is caught, not sent, and recorded as excluded', async () => {
  const ctx = setup();
  const jobs = await queuedJobs(ctx);
  const { store, transport, service } = ctx;

  // The opt-out arrives while the job is being claimed, after the first consent check.
  const originalTransition = store.transitionJob.bind(store);
  store.transitionJob = async (companyId, id, from, patch) => {
    if (patch.status === 'sending') {
      await store.upsertUnsubscribe({
        companyId,
        channel: 'email',
        address: 'ana@example.com',
        reason: 'link',
        createdAt: new Date(),
      });
    }
    return originalTransition(companyId, id, from, patch);
  };

  const result = await service.dispatchJob(CO_A, jobs['ana@example.com'].id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'opted_out');
  assert.equal(transport.calls.some((c) => c.address === 'ana@example.com'), false);
});

test('opted-out contact: an address unsubscribed before dispatch is not sent and is recorded as skipped', async () => {
  const ctx = setup();
  const jobs = await queuedJobs(ctx);
  await ctx.service.unsubscribe(CO_A, { channel: 'email', address: 'ana@example.com', reason: 'link' });

  const result = await ctx.service.dispatchJob(CO_A, jobs['ana@example.com'].id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'unsubscribed');
  assert.equal(ctx.transport.calls.length, 0);
});

test('consented contact: sent to its own address exactly once, and a second dispatch does not resend', async () => {
  const ctx = setup();
  const jobs = await queuedJobs(ctx);

  const sent = await ctx.service.dispatchJob(CO_A, jobs['ben@example.com'].id);
  assert.equal(sent.status, 'sent');
  assert.match(sent.externalId, /^fake_/);

  await assert.rejects(ctx.service.dispatchJob(CO_A, jobs['ben@example.com'].id), (e) => e.code === 'conflict');
  const toBen = ctx.transport.calls.filter((c) => c.address === 'ben@example.com');
  assert.equal(toBen.length, 1);
});

test('missing consent record: with no consent record on file the send is refused as no_consent and not transported', async () => {
  const ctx = setup();
  const jobs = await queuedJobs(ctx);
  const { store } = ctx;

  // The earlier gate still sees an active opt-in, but the consent records themselves are gone.
  store.hasActiveOptIn = async () => true;
  store.listOptIns = async () => [];

  const result = await ctx.service.dispatchJob(CO_A, jobs['ben@example.com'].id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'no_consent');
  assert.equal(ctx.transport.calls.length, 0);
});

test('transport is never called for a job that checkConsent refuses, across a mixed batch', async () => {
  const ctx = setup();
  const jobs = await queuedJobs(ctx);
  const { store } = ctx;

  // ana: opted out during the claim. ben: consent records removed after queueing.
  const originalTransition = store.transitionJob.bind(store);
  store.transitionJob = async (companyId, id, from, patch) => {
    if (patch.status === 'sending') {
      await store.upsertUnsubscribe({ companyId, channel: 'email', address: 'ana@example.com', reason: 'link', createdAt: new Date() });
    }
    return originalTransition(companyId, id, from, patch);
  };
  store.hasActiveOptIn = async () => true;
  store.listOptIns = async () => [];

  const anaResult = await ctx.service.dispatchJob(CO_A, jobs['ana@example.com'].id);
  const benResult = await ctx.service.dispatchJob(CO_A, jobs['ben@example.com'].id);
  assert.equal(anaResult.status, 'skipped');
  assert.equal(benResult.status, 'skipped');
  assert.equal(ctx.transport.calls.length, 0);
});
