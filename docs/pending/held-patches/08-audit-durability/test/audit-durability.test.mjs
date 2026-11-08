// Security regression test: audit rows must survive a failed flush, and user deletion must not erase them.
// Run from the Desk root: node --test tests/security/audit-durability.test.mjs
// No install needed. The buffer module has no db or config imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BUFFER = '../../server/services/audit-queue.mjs';
const AUDIT_LOG = new URL('../../server/services/audit-log.ts', import.meta.url);
const USERS_ROUTES = new URL('../../server/routes/admin/users-routes.ts', import.meta.url);
const SCHEMA = new URL('../../shared/schema.ts', import.meta.url);
const DRAFT_MIGRATION = new URL('../../migrations/DRAFT_audit_logs_soft_delete.sql', import.meta.url);

// Fake insert: each call pops the next outcome ('ok' or 'fail') and records the rows it was given.
function fakeInsert(outcomes) {
  const calls = [];
  const written = [];
  const insert = async (rows) => {
    calls.push(rows.map((r) => r.action));
    const outcome = outcomes.length ? outcomes.shift() : 'ok';
    if (outcome === 'fail') throw new Error('connection reset');
    written.push(...rows.map((r) => r.action));
  };
  return { insert, calls, written };
}

// Timers are recorded, not run. A test fires one with timers[i].fn(), as the event loop would.
function harness(outcomes, options = {}) {
  const fake = fakeInsert(outcomes);
  const losses = [];
  const timers = [];
  const { createAuditBuffer } = globalThis.__buffer;
  const buffer = createAuditBuffer({
    insert: fake.insert,
    onLoss: (rows, reason) => losses.push({ rows: rows.slice(), reason }),
    schedule: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    ...options,
  });
  return { buffer, fake, losses, timers, delays: () => timers.map((t) => t.ms) };
}

async function loadBuffer() {
  if (!globalThis.__buffer) globalThis.__buffer = await import(BUFFER);
  return globalThis.__buffer;
}

test('a failed flush keeps every row and a later flush writes them in order', async () => {
  await loadBuffer();
  const { buffer, fake, losses } = harness(['fail', 'ok']);
  buffer.push({ action: 'user.login' });
  buffer.push({ action: 'admin.user_update' });
  buffer.push({ action: 'payment.refund' });

  const first = await buffer.flush();
  assert.equal(first.written, 0);
  assert.equal(first.pending, 3, 'rows must stay queued after a failed insert');

  const second = await buffer.flush();
  assert.equal(second.written, 3);
  assert.deepEqual(fake.written, ['user.login', 'admin.user_update', 'payment.refund']);
  assert.equal(losses.length, 0);
});

test('a failed flush schedules a retry with exponential backoff', async () => {
  await loadBuffer();
  const { buffer, timers, delays } = harness(['fail', 'fail', 'ok'], {
    flushDelayMs: 100,
    baseRetryMs: 1000,
    maxRetryMs: 60000,
  });
  buffer.push({ action: 'user.login' }); // first flush is due in 100ms
  await timers[0].fn(); // fails, schedules a retry
  await timers[1].fn(); // fails again, backoff doubles
  assert.deepEqual(delays().slice(0, 3), [100, 1000, 2000]);
});

test('rows that keep failing are reported through onLoss and never vanish silently', async () => {
  await loadBuffer();
  const { buffer, losses } = harness(['fail', 'fail', 'fail'], { maxAttempts: 3 });
  buffer.push({ action: 'user.login' });
  buffer.push({ action: 'user.logout' });

  await buffer.flush();
  await buffer.flush();
  assert.equal(losses.length, 0, 'not lost before the attempt limit');
  await buffer.flush();

  assert.equal(losses.length, 1);
  assert.equal(losses[0].reason, 'max_attempts');
  assert.deepEqual(losses[0].rows.map((r) => r.action), ['user.login', 'user.logout']);
  const s = buffer.stats();
  assert.equal(s.written + s.lost + s.pending, 2, 'every pushed row is accounted for');
});

test('the queue is bounded and shed rows are reported, not dropped quietly', async () => {
  await loadBuffer();
  const { buffer, losses } = harness(['fail'], { maxQueue: 3 });
  for (let i = 0; i < 5; i++) buffer.push({ action: 'user.login', seq: i });
  await buffer.flush();

  const shed = losses.filter((l) => l.reason === 'queue_overflow').flatMap((l) => l.rows);
  assert.deepEqual(shed.map((r) => r.seq), [0, 1], 'the oldest rows are the ones shed, and each is reported');
  const s = buffer.stats();
  assert.equal(s.pending, 3);
  assert.equal(s.lost, 2);
  assert.equal(s.written + s.lost + s.pending, 5);
});

test('a successful flush clears the queue and resets the backoff', async () => {
  await loadBuffer();
  const { buffer, fake, timers } = harness(['fail', 'fail', 'ok', 'fail'], {
    flushDelayMs: 100,
    baseRetryMs: 1000,
  });
  buffer.push({ action: 'user.login' }); // timers[0]: due in 100ms
  await timers[0].fn(); // fails, timers[1]: retry in 1000ms
  await timers[1].fn(); // fails again, timers[2]: retry in 2000ms
  await timers[2].fn(); // succeeds, queue empty
  assert.deepEqual(fake.written, ['user.login']);

  buffer.push({ action: 'user.logout' }); // timers[3]: due in 100ms
  await timers[3].fn(); // fails once more: backoff restarts at 1000ms, not 4000ms
  assert.equal(timers.at(-1).ms, 1000);
});

test('audit-log.ts no longer splices the queue before the insert and uses the retrying buffer', () => {
  const src = fs.readFileSync(AUDIT_LOG, 'utf8');
  assert.doesNotMatch(src, /splice\(0,\s*auditLogQueue\.length\)/, 'rows are removed before the insert succeeds');
  assert.match(src, /createAuditBuffer\(/);
  assert.match(src, /reportLostAuditRows/);
});

test('user deletion marks audit rows instead of deleting them', () => {
  const src = fs.readFileSync(USERS_ROUTES, 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(src, /db\.delete\(schema\.auditLogs\)/, 'audit rows are still deleted');
  assert.match(src, /db\.update\(schema\.auditLogs\)\.set\(\{ deletedAt: new Date\(\) \}\)/);
});

test('schema declares the deleted_at marker and a draft migration exists (not in the runner sequence)', () => {
  const schema = fs.readFileSync(SCHEMA, 'utf8');
  const block = schema.slice(schema.indexOf('export const auditLogs = pgTable('), schema.indexOf('// Platform Languages'));
  assert.match(block, /deletedAt: timestamp\("deleted_at"\)/);
  const draft = fs.readFileSync(DRAFT_MIGRATION, 'utf8');
  assert.match(draft, /DRAFT - NOT FOR EXECUTION/);
  assert.match(draft, /ADD COLUMN IF NOT EXISTS "deleted_at"/);
});
