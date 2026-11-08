import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGenericJobs,
  UnknownJobTypeError,
  DuplicateJobTypeError,
  InvalidJobOptionsError,
  QueueNotBoundError,
} from '../../server/infrastructure/bullmq/generic-jobs.ts';
import {
  registerApprovalExpiryJob,
  approvalExpiryEnqueue,
  approvalExpiryJobId,
  APPROVAL_EXPIRY_JOB_TYPE,
  APPROVAL_EXPIRY_RETRY_OPTIONS,
} from '../../server/infrastructure/bullmq/jobs/approval-expiry.ts';

// Fake queue that follows BullMQ's rule: an add whose jobId already exists is ignored.
// It returns the existing job's id and does not store a second job.
function fakeQueue() {
  const stored = new Map();   // jobId -> { name, data, opts }
  const calls = [];           // every add() call, including ignored duplicates
  let seq = 0;
  return {
    stored,
    calls,
    async add(name, data, opts = {}) {
      calls.push({ name, data, opts });
      if (opts.jobId !== undefined) {
        if (!stored.has(opts.jobId)) stored.set(opts.jobId, { name, data, opts });
        return { id: opts.jobId };
      }
      const id = String(++seq);
      stored.set(id, { name, data, opts });
      return { id };
    },
  };
}

test('registers job types and lists them sorted', () => {
  const jobs = createGenericJobs();
  jobs.registerJobType('webhook-retry', () => {});
  jobs.registerJobType('approval-expiry', () => {});
  assert.deepEqual(jobs.getJobTypes(), ['approval-expiry', 'webhook-retry']);
});

test('rejects duplicate registration and invalid names or handlers', () => {
  const jobs = createGenericJobs();
  jobs.registerJobType('reminder', () => {});
  assert.throws(() => jobs.registerJobType('reminder', () => {}), DuplicateJobTypeError);
  assert.throws(() => jobs.registerJobType('Bad_Name', () => {}), InvalidJobOptionsError);
  assert.throws(() => jobs.registerJobType('x', () => {}), InvalidJobOptionsError);
  assert.throws(() => jobs.registerJobType('ok-name', 'not-a-function'), InvalidJobOptionsError);
});

test('enqueues with delay and jobId', async () => {
  const jobs = createGenericJobs();
  const queue = fakeQueue();
  jobs.bindGenericJobQueue(queue);
  jobs.registerJobType('approval-expiry', () => {});

  const result = await jobs.enqueueJob('approval-expiry', { approvalId: 'ap_1' }, {
    delay: 3600000,
    jobId: 'approval-expiry-ap_1',
    priority: 5,
  });

  assert.equal(result.jobId, 'approval-expiry-ap_1');
  assert.equal(queue.calls.length, 1);
  const call = queue.calls[0];
  assert.equal(call.name, 'approval-expiry');
  assert.deepEqual(call.data, { approvalId: 'ap_1' });
  assert.equal(call.opts.delay, 3600000);
  assert.equal(call.opts.jobId, 'approval-expiry-ap_1');
  assert.equal(call.opts.priority, 5);
});

test('duplicate jobId does not create a second job', async () => {
  const jobs = createGenericJobs();
  const queue = fakeQueue();
  jobs.bindGenericJobQueue(queue);
  jobs.registerJobType('approval-expiry', () => {});

  const first = await jobs.enqueueJob('approval-expiry', { approvalId: 'ap_2' }, { delay: 1000, jobId: 'k1' });
  const second = await jobs.enqueueJob('approval-expiry', { approvalId: 'ap_2' }, { delay: 1000, jobId: 'k1' });

  assert.equal(queue.calls.length, 2, 'both adds reached the queue');
  assert.equal(queue.stored.size, 1, 'only one job was stored');
  assert.equal(first.jobId, 'k1');
  assert.equal(second.jobId, 'k1');
});

test('unknown job type is rejected before the queue is touched', async () => {
  const jobs = createGenericJobs();
  const queue = fakeQueue();
  jobs.bindGenericJobQueue(queue);

  await assert.rejects(() => jobs.enqueueJob('never-registered', {}), UnknownJobTypeError);
  assert.equal(queue.calls.length, 0);
  await assert.rejects(
    () => jobs.processGenericJob({ name: 'never-registered', data: {} }),
    UnknownJobTypeError,
  );
});

test('retry options registered on the type pass through to BullMQ', async () => {
  const jobs = createGenericJobs();
  const queue = fakeQueue();
  jobs.bindGenericJobQueue(queue);
  jobs.registerJobType('webhook-retry', () => {}, {
    attempts: 7,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 600, count: 50 },
    removeOnFail: false,
  });

  await jobs.enqueueJob('webhook-retry', { url: 'https://example.test/hook' }, { delay: 500 });
  const opts = queue.calls[0].opts;
  assert.equal(opts.attempts, 7);
  assert.deepEqual(opts.backoff, { type: 'exponential', delay: 2000 });
  assert.deepEqual(opts.removeOnComplete, { age: 600, count: 50 });
  assert.equal(opts.removeOnFail, false);
  assert.equal(opts.delay, 500);
  assert.equal(opts.jobId, undefined);

  // Changing the options the queue received must not change the registered defaults.
  opts.backoff.delay = 1;
  await jobs.enqueueJob('webhook-retry', {}, {});
  assert.deepEqual(queue.calls[1].opts.backoff, { type: 'exponential', delay: 2000 });
});

test('invalid enqueue options are rejected without calling the queue', async () => {
  const jobs = createGenericJobs();
  const queue = fakeQueue();
  jobs.bindGenericJobQueue(queue);
  jobs.registerJobType('reminder', () => {});

  await assert.rejects(() => jobs.enqueueJob('reminder', {}, { delay: -1 }), InvalidJobOptionsError);
  await assert.rejects(() => jobs.enqueueJob('reminder', {}, { delay: 1.5 }), InvalidJobOptionsError);
  await assert.rejects(() => jobs.enqueueJob('reminder', {}, { jobId: '12345' }), InvalidJobOptionsError);
  await assert.rejects(() => jobs.enqueueJob('reminder', {}, { jobId: '' }), InvalidJobOptionsError);
  await assert.rejects(() => jobs.enqueueJob('reminder', {}, { priority: 0 }), InvalidJobOptionsError);
  assert.equal(queue.calls.length, 0);
});

test('enqueue without a bound queue fails clearly', async () => {
  const jobs = createGenericJobs();
  jobs.registerJobType('reminder', () => {});
  await assert.rejects(() => jobs.enqueueJob('reminder', {}), QueueNotBoundError);
});

test('processGenericJob dispatches payload and meta to the handler', async () => {
  const jobs = createGenericJobs();
  const seen = [];
  jobs.registerJobType('reminder', (payload, meta) => { seen.push({ payload, meta }); });

  await jobs.processGenericJob({ name: 'reminder', data: { text: 'call back' }, id: 'j9', attemptsMade: 2 });
  assert.deepEqual(seen, [{
    payload: { text: 'call back' },
    meta: { name: 'reminder', jobId: 'j9', attemptsMade: 2 },
  }]);
});

test('approval-expiry is not registered until registerApprovalExpiryJob is called', () => {
  const jobs = createGenericJobs();
  assert.deepEqual(jobs.getJobTypes(), []);
  registerApprovalExpiryJob(jobs, { expireApproval: async () => {} });
  assert.deepEqual(jobs.getJobTypes(), [APPROVAL_EXPIRY_JOB_TYPE]);
  assert.throws(
    () => registerApprovalExpiryJob(jobs, { expireApproval: async () => {} }),
    DuplicateJobTypeError,
  );
});

test('approval-expiry enqueues with delay = TTL and a deduplicating jobId', async () => {
  const jobs = createGenericJobs();
  const queue = fakeQueue();
  jobs.bindGenericJobQueue(queue);
  registerApprovalExpiryJob(jobs, { expireApproval: async () => {} });

  const ttlMs = 24 * 60 * 60 * 1000;
  const args = approvalExpiryEnqueue('ap_77', ttlMs);
  assert.equal(args.name, APPROVAL_EXPIRY_JOB_TYPE);
  assert.equal(args.opts.jobId, approvalExpiryJobId('ap_77'));

  await jobs.enqueueJob(args.name, args.payload, args.opts);
  await jobs.enqueueJob(args.name, args.payload, args.opts);
  assert.equal(queue.stored.size, 1);
  const stored = queue.stored.get('approval-expiry-ap_77');
  assert.equal(stored.opts.delay, ttlMs);
  assert.equal(stored.opts.attempts, APPROVAL_EXPIRY_RETRY_OPTIONS.attempts);
});

test('approval-expiry handler calls only the injected expireApproval', async () => {
  const jobs = createGenericJobs();
  const expired = [];
  registerApprovalExpiryJob(jobs, { expireApproval: async (id) => { expired.push(id); } });

  await jobs.processGenericJob({ name: APPROVAL_EXPIRY_JOB_TYPE, data: { approvalId: 'ap_5' } });
  assert.deepEqual(expired, ['ap_5']);
  await assert.rejects(
    () => jobs.processGenericJob({ name: APPROVAL_EXPIRY_JOB_TYPE, data: {} }),
    TypeError,
  );
});

test('approvalExpiryEnqueue rejects bad input', () => {
  assert.throws(() => approvalExpiryEnqueue('', 1000), TypeError);
  assert.throws(() => approvalExpiryEnqueue('ap', 0), TypeError);
  assert.throws(() => approvalExpiryEnqueue('ap', 1.5), TypeError);
});
