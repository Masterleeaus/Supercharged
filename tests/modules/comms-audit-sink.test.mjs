// Comms audit sink and AuditAction names (node:test). In-memory fake writer only: no database, no network.
// Console is silenced because the sink module is server code and the test runner's IPC must stay clean.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommsAuditSink, AuditSinkRefused, COMMS_AUDIT_ACTIONS } from '../../server/modules/comms/audit-sink.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-04T09:00:00.000Z';
const EMAIL = 'ann@example.com';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

function suppressionEntry(overrides = {}) {
  return {
    action: 'comms.suppression_changed',
    companyId: CO,
    change: 'suppressed',
    channel: 'email',
    addressHash: 'hash-of-ann',
    reason: 'complaint',
    actorId: 'system',
    at: AT,
    ...overrides,
  };
}

function refusedReason(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuditSinkRefused) return error.reason;
    throw error;
  }
  return null;
}

// ---- names ------------------------------------------------------------------------------------

test('AuditAction union contains the three comms action names', () => {
  const src = read('server/services/audit-log.ts');
  const union = src.slice(src.indexOf('export type AuditAction'), src.indexOf('export interface AuditLogEntry'));
  for (const name of ['contacts_merged', 'comms.audience_export', 'comms.suppression_changed']) {
    assert.ok(union.includes(`| "${name}"`), `${name} is in AuditAction`);
  }
});

test('the comms modules write exactly the audit action names the union holds', () => {
  const merge = read('server/modules/comms/contact-merge.ts');
  const importer = read('server/modules/comms/contact-import.ts');
  const suppression = read('server/modules/comms/suppression.ts');
  assert.ok(merge.includes("action: 'contacts_merged'"));
  assert.ok(importer.includes("action: 'comms.audience_export'"));
  assert.ok(suppression.includes("action: 'comms.suppression_changed'"));
  assert.deepEqual(
    [...COMMS_AUDIT_ACTIONS].sort(),
    [
      'comms.approval_recorded',
      'comms.assignment_changed',
      'comms.audience_export',
      'comms.campaign_changed',
      'comms.draft_created',
      'comms.draft_edited',
      'comms.human_override',
      'comms.message_sent',
      'comms.provider_event',
      'comms.suppression_changed',
      'contacts_merged',
    ],
  );
});

// ---- ordering and synchronous queueing --------------------------------------------------------

test('audit() queues synchronously and the writer sees entries in call order', async () => {
  const written = [];
  const sink = createCommsAuditSink({
    write: async (entry) => {
      await new Promise((r) => setTimeout(r, 1));
      written.push(entry.metadata.at);
    },
  });
  const audit = sink.forCompany(CO);
  audit({ ...suppressionEntry(), at: '1' });
  assert.equal(sink.pending(), 1, 'entry is queued before audit() returns');
  audit({ ...suppressionEntry(), at: '2' });
  audit({ ...suppressionEntry(), at: '3' });
  assert.equal(sink.pending(), 3);
  assert.equal(await sink.flush(2000), 0);
  assert.deepEqual(written, ['1', '2', '3']);
});

test('a slow writer does not let a later entry overtake an earlier one', async () => {
  const order = [];
  const sink = createCommsAuditSink({
    write: async (entry) => {
      const n = entry.metadata.at;
      await new Promise((r) => setTimeout(r, n === 'first' ? 20 : 0));
      order.push(n);
    },
  });
  const audit = sink.forCompany(CO);
  audit({ ...suppressionEntry(), at: 'first' });
  audit({ ...suppressionEntry(), at: 'second' });
  audit({ ...suppressionEntry(), at: 'third' });
  await sink.flush(2000);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('a failed write is retried in place: nothing is dropped or reordered', async () => {
  const attempts = [];
  let failNext = true;
  const sink = createCommsAuditSink({
    retryDelayMs: 0,
    write: async (entry) => {
      attempts.push(entry.metadata.at);
      if (failNext) {
        failNext = false;
        throw new Error('db down');
      }
    },
  });
  const audit = sink.forCompany(CO);
  audit({ ...suppressionEntry(), at: 'a' });
  audit({ ...suppressionEntry(), at: 'b' });
  assert.equal(await sink.flush(2000), 0);
  assert.deepEqual(attempts, ['a', 'a', 'b'], 'the failed head is retried before the next entry');
});

// ---- mapping ----------------------------------------------------------------------------------

test('suppression entries carry the hash and never the raw address', async () => {
  const seen = [];
  const sink = createCommsAuditSink({ write: async (entry) => { seen.push(entry); } });
  sink.forCompany(CO)(suppressionEntry({ actorId: 'staff-7' }));
  await sink.flush(2000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'comms.suppression_changed');
  assert.equal(seen[0].userId, 'staff-7');
  assert.equal(seen[0].metadata.addressHash, 'hash-of-ann');
  assert.equal(seen[0].metadata.companyId, CO);
  assert.ok(!JSON.stringify(seen[0]).includes(EMAIL));
});

test('a merge entry without a companyId is tagged with the sink company', async () => {
  const seen = [];
  const sink = createCommsAuditSink({ write: async (entry) => { seen.push(entry); } });
  sink.forCompany(CO)({
    action: 'contacts_merged',
    primaryId: 'c-primary',
    duplicateId: 'c-duplicate',
    actorId: 'user-42',
    at: AT,
  });
  await sink.flush(2000);
  assert.equal(seen[0].action, 'contacts_merged');
  assert.equal(seen[0].resourceId, 'c-primary');
  assert.equal(seen[0].userId, 'user-42');
  assert.equal(seen[0].metadata.companyId, CO);
});

test('an export entry records the row count, not the rows', async () => {
  const seen = [];
  const sink = createCommsAuditSink({ write: async (entry) => { seen.push(entry); } });
  sink.forCompany(CO)({
    action: 'comms.audience_export',
    companyId: CO,
    actorId: 'user-42',
    rowCount: 3,
    at: AT,
  });
  await sink.flush(2000);
  assert.equal(seen[0].action, 'comms.audience_export');
  assert.equal(seen[0].metadata.rowCount, 3);
  assert.ok(!('csv' in seen[0].metadata));
});

// ---- refusals (fail closed) -------------------------------------------------------------------

test('construction refuses a missing writer', () => {
  assert.equal(refusedReason(() => createCommsAuditSink({})), 'write_missing');
});

test('forCompany refuses a company that is not a UUID', () => {
  const sink = createCommsAuditSink({ write: async () => {} });
  assert.equal(refusedReason(() => sink.forCompany('')), 'invalid_company');
  assert.equal(refusedReason(() => sink.forCompany(undefined)), 'invalid_company');
});

test('an entry naming another company is refused and nothing is queued', () => {
  const sink = createCommsAuditSink({ write: async () => {} });
  const audit = sink.forCompany(CO);
  assert.equal(refusedReason(() => audit(suppressionEntry({ companyId: OTHER }))), 'company_mismatch');
  assert.equal(sink.pending(), 0);
});

test('audit() takes the company from a suppression entry, across companies, in order', async () => {
  const seen = [];
  const sink = createCommsAuditSink({ write: async (entry) => { seen.push(entry); } });
  sink.audit(suppressionEntry({ companyId: CO, addressHash: 'h1' }));
  sink.audit(suppressionEntry({ companyId: OTHER, addressHash: 'h2' }));
  assert.equal(await sink.flush(2000), 0);
  assert.deepEqual(seen.map((e) => [e.metadata.companyId, e.metadata.addressHash]), [[CO, 'h1'], [OTHER, 'h2']]);
});

test('audit() refuses an entry without a UUID companyId', () => {
  const sink = createCommsAuditSink({ write: async () => {} });
  assert.equal(refusedReason(() => sink.audit(suppressionEntry({ companyId: undefined }))), 'invalid_company');
  assert.equal(refusedReason(() => sink.audit(suppressionEntry({ companyId: 'acme' }))), 'invalid_company');
  assert.equal(sink.pending(), 0);
});

test('an unknown action is refused and nothing is queued', () => {
  const sink = createCommsAuditSink({ write: async () => {} });
  const audit = sink.forCompany(CO);
  assert.equal(refusedReason(() => audit({ ...suppressionEntry(), action: 'comms.something_else' })), 'unknown_action');
  assert.equal(sink.pending(), 0);
});

test('flush reports entries still queued when the timeout passes', async () => {
  const sink = createCommsAuditSink({ retryDelayMs: 5, write: async () => { throw new Error('down'); } });
  sink.forCompany(CO)(suppressionEntry());
  const remaining = await sink.flush(30);
  assert.equal(remaining, 1, 'a permanently failing entry stays queued, it is not dropped');
});
