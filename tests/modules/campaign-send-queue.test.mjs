// Scheduler and durable send queue (SyncedAt P1): idempotent dispatch, claim safety, bounded
// retries, recovery from partial sends. Node test runner, fakes only: no database, no network,
// no provider. The transports below record calls and never send anything.
const silence = () => {};
console.log = silence;
console.info = silence;
console.warn = silence;
console.debug = silence;

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCampaignService,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';
import {
  createSendQueue,
  idempotencyKey,
  InMemorySendQueueStore,
} from '../../server/modules/campaigns/send-queue.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const HUMAN = { kind: 'human', id: 'user-1' };
const MIN = 60 * 1000;

/** Fails once for one address, then succeeds. Records every call. */
class FlakyTransport {
  calls = [];
  failures = 1;
  constructor(failAddress) {
    this.failAddress = failAddress;
  }
  async send(companyId, job) {
    this.calls.push({ address: job.address, jobId: job.id });
    if (job.address === this.failAddress && this.failures > 0) {
      this.failures -= 1;
      throw new Error('provider timeout');
    }
    return { externalId: `ext_${this.calls.length}` };
  }
}

/** Every send fails. Records every call. */
class AlwaysFailTransport {
  calls = [];
  async send(companyId, job) {
    this.calls.push({ address: job.address, jobId: job.id });
    throw new Error('provider unavailable');
  }
}

function setup({ transport, consent, maxAttempts, claimTimeoutMs } = {}) {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const sendTransport = transport ?? new RecordingSendTransport();
  const queueState = new InMemorySendQueueStore();
  let seq = 0;
  const clock = { t: Date.UTC(2026, 10, 2, 0, 0, 0) };
  const now = () => new Date(clock.t);
  const service = createCampaignService({
    store,
    approvals,
    transport: sendTransport,
    consent,
    newId: () => `id_${++seq}`,
    now,
  });
  const queue = createSendQueue({
    service,
    store,
    queue: queueState,
    now,
    maxAttempts,
    claimTimeoutMs,
    retryBaseMs: 1000,
    retryMaxMs: 10 * MIN,
    deferMs: 15 * MIN,
    newToken: (() => {
      let t = 0;
      return () => `tok_${++t}`;
    })(),
  });
  return { store, approvals, transport: sendTransport, service, queue, queueState, clock, now };
}

/** Active email campaign, one step, every address opted in. Approved, so the jobs are queued. */
async function activeCampaign(ctx, addresses) {
  const s = ctx.service;
  const audience = await s.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  for (const address of addresses) {
    await s.addContact(CO_A, { channel: 'email', address, tags: ['vip'] });
    await s.recordOptIn(CO_A, { channel: 'email', address, source: 'web form' });
  }
  const campaign = await s.createCampaign(CO_A, { name: 'Spring offer', channel: 'email', audienceId: audience.id });
  const step = await s.addStep(CO_A, campaign.id, { subject: 'Hello', body: 'Spring offer inside.' });
  await s.activateCampaign(CO_A, HUMAN, campaign.id);
  ctx.approvals.nextState = 'approved';
  const req = await s.requestSend(CO_A, HUMAN, campaign.id, step.id);
  const jobs = (await s.listJobs(CO_A, { approvalId: req.approvalId })).filter((j) => j.status === 'queued');
  return { campaign, step, jobs, queued: req.queued };
}

const byAddress = (jobs) => Object.fromEntries(jobs.map((j) => [j.address, j]));

test('idempotency key is stable per recipient and step, and differs across them', () => {
  const base = { companyId: CO_A, campaignId: 'c1', stepId: 's1', channel: 'email', address: 'ana@example.com' };
  assert.equal(idempotencyKey(base), idempotencyKey({ ...base }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, address: 'ben@example.com' }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, stepId: 's2' }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, companyId: CO_B }));
});

test('idempotent enqueue: the same jobs enqueued twice create one entry each and no second send', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com', 'ben@example.com']);

  const first = await ctx.queue.enqueue(CO_A, jobs);
  const second = await ctx.queue.enqueue(CO_A, jobs);
  assert.deepEqual(first, { enqueued: 2, duplicates: 0, ignored: 0 });
  assert.deepEqual(second, { enqueued: 0, duplicates: 2, ignored: 0 });

  const summary = await ctx.queue.runOnce(CO_A);
  assert.equal(summary.sent, 2);
  assert.equal(ctx.transport.calls.length, 2);
  // Running again finds nothing to send: the jobs are sent and no longer queued.
  await ctx.queue.runOnce(CO_A);
  assert.equal(ctx.transport.calls.length, 2);
});

test('double claim: two concurrent runs send each recipient exactly once', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com', 'ben@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  const [a, b] = await Promise.all([ctx.queue.runOnce(CO_A), ctx.queue.runOnce(CO_A)]);
  assert.equal(a.sent + b.sent, 2);
  assert.equal(ctx.transport.calls.length, 2);
  assert.deepEqual(ctx.transport.calls.map((c) => c.address).sort(), ['ana@example.com', 'ben@example.com']);
});

test('claim: a held entry cannot be claimed again, and a stale token cannot write to it', async () => {
  const state = new InMemorySendQueueStore();
  const at = new Date(Date.UTC(2026, 10, 2));
  const entry = { companyId: CO_A, key: 'k1', jobId: 'j1', attempts: 0, nextAttemptAt: at, claimToken: null, claimedAt: null, lastErrorCode: null, deadLetteredAt: null };
  assert.equal(await state.insertIfAbsent(entry), true);
  assert.equal(await state.insertIfAbsent(entry), false);
  assert.ok(await state.claim(CO_A, 'k1', 't1', at));
  assert.equal(await state.claim(CO_A, 'k1', 't2', at), null);
  assert.equal(await state.update(CO_A, 'k1', 't2', { attempts: 9 }), null);
  assert.equal((await state.update(CO_A, 'k1', 't1', { attempts: 1 })).attempts, 1);
  assert.equal(await state.claim(CO_B, 'k1', 't3', at), null, 'another company cannot claim it');
});

test('dead-lettered entry: the store will not claim it again', async () => {
  const state = new InMemorySendQueueStore();
  const at = new Date(Date.UTC(2026, 10, 2));
  await state.insertIfAbsent({ companyId: CO_A, key: 'k2', jobId: 'j2', attempts: 3, nextAttemptAt: at, claimToken: null, claimedAt: null, lastErrorCode: null, deadLetteredAt: null });
  assert.ok(await state.claim(CO_A, 'k2', 't1', at));
  await state.update(CO_A, 'k2', 't1', { deadLetteredAt: at, claimToken: null, claimedAt: null });
  assert.equal(await state.claim(CO_A, 'k2', 't2', at), null);
});

test('claimJob: one worker wins the job, the other gets null, and a held job is not dispatched', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);
  const [job] = jobs;

  const won = await ctx.queue.claimJob(CO_A, job.id);
  assert.ok(won, 'first worker claims');
  assert.equal(won.job.id, job.id);
  assert.equal(await ctx.queue.claimJob(CO_A, job.id), null, 'second worker is refused');
  assert.equal(await ctx.queue.claimJob(CO_B, job.id), null, 'another company cannot claim it');

  const during = await ctx.queue.runOnce(CO_A);
  assert.equal(during.dispatched, 0);
  assert.equal(ctx.transport.calls.length, 0);

  // The holder never released. After the claim timeout, recovery frees the job and it is sent once.
  ctx.clock.t += 6 * MIN;
  const after = await ctx.queue.runOnce(CO_A);
  assert.equal(after.sent, 1);
  assert.equal(ctx.transport.calls.length, 1);
});

test('retry bound: after maxAttempts the job is failed, dead-lettered, and never sent again', async () => {
  const transport = new AlwaysFailTransport();
  const ctx = setup({ transport, maxAttempts: 2 });
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  for (let i = 0; i < 4; i += 1) {
    await ctx.queue.runOnce(CO_A);
    ctx.clock.t += 60 * MIN;
  }
  assert.equal(transport.calls.length, 2);
  const dead = await ctx.queue.deadLetters(CO_A);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].lastErrorCode, 'max_attempts');
  assert.equal(dead[0].attempts, 2);
  assert.equal(await ctx.queue.claimJob(CO_A, jobs[0].id), null, 'a dead job cannot be claimed');
  assert.equal((await ctx.service.listJobs(CO_A))[0].status, 'failed');
});

test('recovery at the attempt bound: a stuck job is failed and dead-lettered, not resent', async () => {
  const ctx = setup({ maxAttempts: 1, claimTimeoutMs: 5 * MIN });
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  const { store } = ctx;
  const original = store.transitionJob.bind(store);
  let failWrite = true;
  store.transitionJob = async (companyId, id, from, patch) => {
    if (failWrite && patch.status === 'sent') {
      failWrite = false;
      throw new Error('database write failed');
    }
    return original(companyId, id, from, patch);
  };

  assert.equal((await ctx.queue.runOnce(CO_A)).held, 1);
  assert.equal(ctx.transport.calls.length, 1);

  ctx.clock.t += 6 * MIN;
  const recovery = await ctx.queue.runOnce(CO_A);
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.dispatched, 0);
  assert.equal((await ctx.service.listJobs(CO_A))[0].status, 'failed');
  const dead = await ctx.queue.deadLetters(CO_A);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].lastErrorCode, 'claim_timeout');

  ctx.clock.t += 60 * MIN;
  await ctx.queue.runOnce(CO_A);
  assert.equal(ctx.transport.calls.length, 1, 'no resend after the bound is used');
});

test('double dispatch of one job at the service: one transport call, the loser gets a conflict', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  const [job] = jobs;

  const results = await Promise.allSettled([
    ctx.service.dispatchJob(CO_A, job.id),
    ctx.service.dispatchJob(CO_A, job.id),
  ]);
  assert.equal(ctx.transport.calls.length, 1);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'conflict');
});

test('retry bound: a job that keeps failing is attempted exactly maxAttempts times, then failed', async () => {
  const transport = new AlwaysFailTransport();
  const ctx = setup({ transport, maxAttempts: 3 });
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  for (let i = 0; i < 6; i += 1) {
    await ctx.queue.runOnce(CO_A);
    ctx.clock.t += 60 * MIN; // past every retry delay
  }
  assert.equal(transport.calls.length, 3);
  const [job] = await ctx.service.listJobs(CO_A);
  assert.equal(job.status, 'failed');
});

test('partial send: a job whose status write fails after the transport call is requeued after the claim timeout and sent once more', async () => {
  const ctx = setup({ maxAttempts: 3, claimTimeoutMs: 5 * MIN });
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  // The provider accepts the message, then the write that records 'sent' fails once.
  const { store } = ctx;
  const original = store.transitionJob.bind(store);
  let failWrite = true;
  store.transitionJob = async (companyId, id, from, patch) => {
    if (failWrite && patch.status === 'sent') {
      failWrite = false;
      throw new Error('database write failed');
    }
    return original(companyId, id, from, patch);
  };

  const first = await ctx.queue.runOnce(CO_A);
  assert.equal(first.held, 1, 'outcome unknown: the claim is kept, not released early');
  assert.equal(ctx.transport.calls.length, 1);

  // Still inside the claim timeout: nothing is picked up.
  ctx.clock.t += 2 * MIN;
  assert.equal((await ctx.queue.runOnce(CO_A)).dispatched, 0);

  ctx.clock.t += 6 * MIN;
  const recovery = await ctx.queue.runOnce(CO_A);
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.sent, 1);
  assert.equal(ctx.transport.calls.length, 2, 'the recovered job is attempted again, within the attempt bound');
  const [job] = await ctx.service.listJobs(CO_A);
  assert.equal(job.status, 'sent');
});

test('recovery never resends a job already marked sent, even when its claim is left behind', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com', 'ben@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);
  await ctx.queue.runOnce(CO_A);
  assert.equal(ctx.transport.calls.length, 2);

  // Simulate a worker that died after the send but before it released the claim.
  const ana = jobs.find((j) => j.address === 'ana@example.com');
  const stale = new Date(ctx.clock.t - 60 * MIN);
  assert.ok(await ctx.queueState.claim(CO_A, idempotencyKey(ana), 'dead-worker', stale));

  ctx.clock.t += 60 * MIN;
  const summary = await ctx.queue.runOnce(CO_A);
  assert.equal(summary.recovered, 0, 'a sent job is not requeued');
  assert.equal(ctx.transport.calls.length, 2, 'no resend');
  const entries = await ctx.queueState.list(CO_A);
  assert.ok(entries.every((e) => e.claimToken === null), 'the stale claim is released');
  const sentAna = await ctx.service.listJobs(CO_A, { campaignId: ana.campaignId });
  assert.ok(sentAna.every((j) => j.status === 'sent'));
});

test('partial release: one failed recipient is retried later while the others are sent once', async () => {
  const transport = new FlakyTransport('ben@example.com');
  const ctx = setup({ transport });
  const { jobs } = await activeCampaign(ctx, ['ana@example.com', 'ben@example.com', 'cy@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  const first = await ctx.queue.runOnce(CO_A);
  assert.equal(first.sent, 2);
  assert.equal(first.requeued, 1);

  // Ben's retry delay has not passed yet, so nothing is dispatched.
  const early = await ctx.queue.runOnce(CO_A);
  assert.equal(early.dispatched, 0);

  ctx.clock.t += 2000;
  const retry = await ctx.queue.runOnce(CO_A);
  assert.equal(retry.sent, 1);

  const counts = Object.fromEntries(['ana@example.com', 'ben@example.com', 'cy@example.com'].map((a) => [a, transport.calls.filter((c) => c.address === a).length]));
  assert.deepEqual(counts, { 'ana@example.com': 1, 'ben@example.com': 2, 'cy@example.com': 1 });
  const all = await ctx.service.listJobs(CO_A);
  assert.ok(all.every((j) => j.status === 'sent'));
});

test('quiet hours defer a job without using an attempt', async () => {
  let consentCalls = 0;
  const consent = () => {
    consentCalls += 1;
    return consentCalls === 1 ? { allowed: false, reason: 'quiet_hours' } : { allowed: true };
  };
  const ctx = setup({ consent });
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);

  const deferred = await ctx.queue.runOnce(CO_A);
  assert.equal(deferred.deferred, 1);
  assert.equal(ctx.transport.calls.length, 0);
  assert.equal((await ctx.service.listJobs(CO_A))[0].status, 'queued');

  assert.equal((await ctx.queue.runOnce(CO_A)).dispatched, 0, 'deferred until the delay passes');
  ctx.clock.t += 16 * MIN;
  const sent = await ctx.queue.runOnce(CO_A);
  assert.equal(sent.sent, 1);
  assert.equal(ctx.transport.calls.length, 1);
});

test('consent is rechecked on the queue path: an unsubscribe after enqueue stops that recipient', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com', 'ben@example.com']);
  await ctx.queue.enqueue(CO_A, jobs);
  await ctx.service.unsubscribe(CO_A, { channel: 'email', address: 'ben@example.com' });

  const summary = await ctx.queue.runOnce(CO_A);
  assert.equal(summary.sent, 1);
  assert.equal(summary.finished, 1);
  assert.deepEqual(ctx.transport.calls.map((c) => c.address), ['ana@example.com']);
  const ben = (await ctx.service.listJobs(CO_A)).find((j) => j.address === 'ben@example.com');
  assert.equal(ben.status, 'skipped');
  assert.equal(ben.skipReason, 'unsubscribed');
});

test('tenancy: enqueue refuses jobs from another company, and an unscoped run is refused', async () => {
  const ctx = setup();
  const { jobs } = await activeCampaign(ctx, ['ana@example.com']);
  await assert.rejects(ctx.queue.enqueue(CO_B, jobs), { code: 'forbidden' });
  await assert.rejects(ctx.queue.runOnce('not-a-company'));
  assert.equal(ctx.transport.calls.length, 0);
});

test('configuration: an out-of-range attempt bound is refused at construction', () => {
  const ctx = setup();
  assert.throws(() => createSendQueue({ service: ctx.service, store: ctx.store, maxAttempts: 0 }), RangeError);
  assert.throws(() => createSendQueue({ service: ctx.service, store: ctx.store, maxAttempts: 11 }), RangeError);
  assert.throws(() => createSendQueue({ service: ctx.service, store: ctx.store, maxAttempts: 1.5 }), RangeError);
});
