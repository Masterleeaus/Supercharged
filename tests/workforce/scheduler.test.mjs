/**
 * Tests for server/workforce/runtime/scheduler.ts. Injected clock only, no real timers, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/scheduler.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../server/workforce/runtime/scheduler.ts';

const RETRY = { baseMs: 10, maxMs: 40, maxAttempts: 3 };

function clock(start = 0) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

function job(overrides = {}) {
  return {
    id: 'job-1',
    companyId: 'co-a',
    agentId: 'agent-1',
    runAt: 1000,
    kind: 'once',
    workKind: 'scheduled',
    work: () => {},
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('createScheduler rejects an invalid retry policy', () => {
  const c = clock();
  assert.throws(() => createScheduler({ now: c.now, retry: { baseMs: 0, maxMs: 40, maxAttempts: 3 } }), TypeError);
  assert.throws(() => createScheduler({ now: c.now, retry: { baseMs: 50, maxMs: 40, maxAttempts: 3 } }), TypeError);
  assert.throws(() => createScheduler({ now: c.now, retry: { baseMs: 10, maxMs: 40, maxAttempts: 0 } }), TypeError);
});

test('schedule rejects a recurring job without intervalMs and a duplicate id in the same company', () => {
  const c = clock();
  const s = createScheduler({ now: c.now, retry: RETRY });
  assert.throws(() => s.schedule(job({ kind: 'recurring' })), TypeError);
  assert.throws(() => s.schedule(job({ workKind: 'forecast' })), TypeError);
  s.schedule(job());
  assert.throws(() => s.schedule(job()), /already scheduled/);
});

test('nothing runs before runAt', async () => {
  const c = clock();
  const s = createScheduler({ now: c.now, retry: RETRY });
  let calls = 0;
  s.schedule(job({ runAt: 1000, work: () => calls++ }));

  c.t = 999;
  assert.equal((await s.tick()).attempts, 0);
  assert.equal(calls, 0);
  assert.equal(s.list('co-a').length, 1);

  c.t = 1000;
  await s.tick();
  assert.equal(calls, 1);
});

test('a due once job runs once and is removed', async () => {
  const c = clock(1000);
  const s = createScheduler({ now: c.now, retry: RETRY });
  let calls = 0;
  s.schedule(job({ work: () => calls++ }));

  await s.tick();
  await s.tick();
  assert.equal(calls, 1);
  assert.deepEqual(s.list('co-a'), []);
  assert.equal(s.attempts('co-a').length, 1);
  assert.equal(s.attempts('co-a')[0].ok, true);
});

test('due jobs run in runAt order, one at a time, and the context carries the attempt number', async () => {
  const c = clock(5000);
  const s = createScheduler({ now: c.now, retry: RETRY });
  const order = [];
  let active = 0;
  let maxActive = 0;
  const make = (id, runAt) =>
    job({
      id,
      runAt,
      work: async (ctx) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push([ctx.jobId, ctx.attempt]);
        await Promise.resolve();
        active--;
      },
    });
  s.schedule(make('late', 3000));
  s.schedule(make('early', 1000));
  s.schedule(make('mid', 2000));

  const result = await s.tick();
  assert.equal(result.attempts, 3);
  assert.deepEqual(order, [
    ['early', 1],
    ['mid', 1],
    ['late', 1],
  ]);
  assert.equal(maxActive, 1);
});

test('a recurring job reschedules at runAt plus intervalMs and does not run early', async () => {
  const c = clock(1000);
  const s = createScheduler({ now: c.now, retry: RETRY });
  let calls = 0;
  s.schedule(job({ kind: 'recurring', intervalMs: 100, runAt: 1000, work: () => calls++ }));

  await s.tick();
  assert.equal(calls, 1);
  assert.equal(s.list('co-a')[0].runAt, 1100);

  c.t = 1050;
  await s.tick();
  assert.equal(calls, 1);

  c.t = 1100;
  await s.tick();
  assert.equal(calls, 2);
  assert.equal(s.list('co-a')[0].runAt, 1200);
});

test('a failing job retries with capped exponential backoff, then is dead-lettered after max attempts', async () => {
  const c = clock(0);
  const s = createScheduler({ now: c.now, retry: RETRY });
  const seen = [];
  s.schedule(
    job({
      runAt: 0,
      workKind: 'retryable',
      work: (ctx) => {
        seen.push(ctx.attempt);
        throw new Error('boom');
      },
    }),
  );

  // Retries after failure n wait baseMs * 2^(n-1), capped at maxMs: 10, 20, 40. The fourth failure has no retry.
  await s.tick();
  assert.equal(s.list('co-a')[0].runAt, 10);
  assert.equal(s.list('co-a')[0].failures, 1);

  c.t = 9;
  assert.equal((await s.tick()).attempts, 0);

  c.t = 10;
  await s.tick();
  assert.equal(s.list('co-a')[0].runAt, 30);

  c.t = 30;
  await s.tick();
  assert.equal(s.list('co-a')[0].runAt, 70);

  c.t = 70;
  await s.tick();
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.deepEqual(s.list('co-a'), []);

  assert.deepEqual(s.deadLetters('co-a'), [
    {
      companyId: 'co-a',
      jobId: 'job-1',
      agentId: 'agent-1',
      workKind: 'retryable',
      kind: 'once',
      attempts: 4,
      error: 'boom',
      deadAt: 70,
    },
  ]);

  const log = s.attempts('co-a');
  assert.equal(log.length, 4);
  assert.ok(log.every((r) => r.ok === false && r.error === 'boom'));
  assert.deepEqual(
    log.map((r) => r.attempt),
    [1, 2, 3, 4],
  );
});

test('a retry that would pass the job deadline dead-letters the job', async () => {
  const c = clock(0);
  const s = createScheduler({ now: c.now, retry: RETRY });
  s.schedule(
    job({
      runAt: 0,
      deadlineAt: 15,
      work: () => {
        throw new Error('late');
      },
    }),
  );
  await s.tick(); // first retry at 10, which is before the deadline
  assert.equal(s.deadLetters('co-a').length, 0);
  c.t = 10;
  await s.tick(); // next retry would start at 30, after the deadline of 15
  assert.equal(s.deadLetters('co-a').length, 1);
  assert.equal(s.deadLetters('co-a')[0].attempts, 2);
});

test('a recurring job that recovers after a retry keeps its original slot cadence', async () => {
  const c = clock(0);
  const s = createScheduler({ now: c.now, retry: RETRY });
  let fail = true;
  let calls = 0;
  s.schedule(
    job({
      kind: 'recurring',
      intervalMs: 100,
      runAt: 0,
      work: () => {
        calls++;
        if (fail) throw new Error('transient');
      },
    }),
  );
  await s.tick(); // fails, retry at 10
  fail = false;
  c.t = 10;
  await s.tick(); // succeeds; next slot is 0 + 100, not 10 + 100
  assert.equal(calls, 2);
  assert.equal(s.list('co-a')[0].runAt, 100);
  assert.equal(s.list('co-a')[0].failures, 0);
});

test('jobs are isolated by company: one company cannot list or read another company jobs', async () => {
  const c = clock(1000);
  const s = createScheduler({ now: c.now, retry: RETRY });
  let aRuns = 0;
  let bRuns = 0;
  s.schedule(job({ companyId: 'co-a', id: 'shared', work: () => aRuns++ }));
  s.schedule(job({ companyId: 'co-b', id: 'shared', work: () => bRuns++ }));
  s.schedule(
    job({
      companyId: 'co-b',
      id: 'bad',
      work: () => {
        throw new Error('b only');
      },
    }),
  );

  assert.deepEqual(
    s.list('co-a').map((j) => j.id),
    ['shared'],
  );
  assert.deepEqual(
    s.list('co-b').map((j) => j.id),
    ['shared', 'bad'],
  );
  assert.deepEqual(s.list('co-c'), []);

  await s.tick();
  assert.equal(aRuns, 1);
  assert.equal(bRuns, 1);
  assert.equal(s.deadLetters('co-a').length, 0);
  assert.equal(s.attempts('co-a').length, 1);
  assert.equal(s.attempts('co-a').every((r) => r.companyId === 'co-a'), true);
  assert.equal(s.deadLetters('co-b').length, 0); // 'bad' has one retry pending, not dead-lettered yet
  assert.deepEqual(s.list('co-a').map((j) => j.id), []);
});

test('a re-entrant tick does not double-run a job that is still running', async () => {
  const c = clock(1000);
  const s = createScheduler({ now: c.now, retry: RETRY });
  const gate = deferred();
  let calls = 0;
  s.schedule(
    job({
      work: async () => {
        calls++;
        await gate.promise;
      },
    }),
  );

  const first = s.tick();
  const second = s.tick(); // called while the first tick is still running the job
  assert.equal((await second).attempts, 0);
  assert.equal(calls, 1);

  gate.resolve();
  assert.equal((await first).attempts, 1);
  assert.equal(calls, 1);

  // After the tick finishes, a new tick works normally: the once job is gone, so nothing runs.
  assert.equal((await s.tick()).attempts, 0);
  assert.equal(calls, 1);
});

test('a job scheduled from inside running work waits for the next tick', async () => {
  const c = clock(1000);
  const s = createScheduler({ now: c.now, retry: RETRY });
  let childRuns = 0;
  s.schedule(
    job({
      id: 'parent',
      work: () => {
        s.schedule(job({ id: 'child', runAt: 1000, work: () => childRuns++ }));
      },
    }),
  );
  await s.tick();
  assert.equal(childRuns, 0);
  await s.tick();
  assert.equal(childRuns, 1);
});
