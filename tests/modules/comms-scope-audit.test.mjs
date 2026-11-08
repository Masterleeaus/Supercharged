// Company scope, injected role guard and audit sinks for comms modules (node:test).
// Pure functions and in-memory fakes only: no database, no network, no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportContactCsv, ContactExportRefused } from '../../server/modules/comms/contact-import.ts';
import { findDuplicateGroups } from '../../server/modules/comms/contact-dedupe.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-04T09:00:00.000Z';

const CONTACTS = [
  { companyId: CO, id: 'a', name: 'Ann', email: 'ann@example.com', phone: '' },
  { companyId: OTHER, id: 'b', name: 'Bob', email: 'bob@example.com', phone: '' },
];

function exportWith(overrides = {}) {
  const sink = [];
  const options = {
    companyId: CO,
    actorId: 'user-42',
    now: NOW,
    guard: () => true,
    audit: (entry) => sink.push(entry),
    ...overrides,
  };
  return { options, sink };
}

function refusedReason(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ContactExportRefused, 'expected ContactExportRefused');
    return err.reason;
  }
  assert.fail('expected the export to be refused');
}

// ---- audience export ------------------------------------------------------------------------

test('export is refused for a non-UUID company', () => {
  const { options } = exportWith({ companyId: 'not-a-uuid' });
  assert.equal(refusedReason(() => exportContactCsv(CONTACTS, options)), 'invalid_company');
});

test('export is refused when the actor is missing or blank', () => {
  const { options } = exportWith({ actorId: '   ' });
  assert.equal(refusedReason(() => exportContactCsv(CONTACTS, options)), 'invalid_actor');
});

test('export is refused when no guard is passed (no hard-coded role fallback)', () => {
  const { options } = exportWith({ guard: undefined });
  assert.equal(refusedReason(() => exportContactCsv(CONTACTS, options)), 'guard_missing');
});

test('export is refused unless the guard returns exactly true', () => {
  for (const verdict of [false, undefined, 'yes', 1, null]) {
    const { options, sink } = exportWith({ guard: () => verdict });
    assert.equal(refusedReason(() => exportContactCsv(CONTACTS, options)), 'not_permitted');
    assert.equal(sink.length, 0, 'a refused export writes no audit entry');
  }
});

test('the guard is asked about this action, company and actor', () => {
  const seen = [];
  const { options } = exportWith({
    guard: (request) => {
      seen.push(request);
      return true;
    },
  });
  exportContactCsv(CONTACTS, options);
  assert.deepEqual(seen, [{ action: 'audience_export', companyId: CO, actorId: 'user-42' }]);
});

test('export is refused when the audit sink is missing', () => {
  const { options } = exportWith({ audit: undefined });
  assert.equal(refusedReason(() => exportContactCsv(CONTACTS, options)), 'audit_missing');
});

test('an allowed export writes one audit entry and returns only this company rows', () => {
  const { options, sink } = exportWith();
  const csv = exportContactCsv(CONTACTS, options);
  assert.equal(csv, 'name,email,phone\nAnn,ann@example.com,\n');
  assert.deepEqual(sink, [
    { action: 'comms.audience_export', companyId: CO, actorId: 'user-42', rowCount: 1, at: NOW },
  ]);
});

test('if the audit write fails, no CSV is returned', () => {
  const { options } = exportWith({
    audit: () => {
      throw new Error('db down');
    },
  });
  assert.throws(() => exportContactCsv(CONTACTS, options), /db down/);
});

// ---- duplicate detection --------------------------------------------------------------------

test('duplicate detection refuses a non-UUID company instead of reporting no duplicates', () => {
  assert.throws(
    () => findDuplicateGroups([], { companyId: 'nope' }),
    (err) => err instanceof TypeError && err.message === 'invalid_company',
  );
  assert.throws(() => findDuplicateGroups([], {}), TypeError);
});

// ---- suppression audit ----------------------------------------------------------------------

function listWithAudit() {
  const sink = [];
  let tick = 0;
  const list = createSuppressionList({
    audit: (entry) => sink.push(entry),
    clock: () => `2026-11-04T09:00:0${tick++}.000Z`,
  });
  return { list, sink };
}

test('a new suppression writes an audit entry that holds a hash, not the address', () => {
  const { list, sink } = listWithAudit();
  list.suppress(CO, { address: 'Ann@Example.com', channel: 'email', reason: 'complaint', actorId: 'staff-7' });
  assert.equal(sink.length, 1);
  const [entry] = sink;
  assert.equal(entry.action, 'comms.suppression_changed');
  assert.equal(entry.change, 'suppressed');
  assert.equal(entry.companyId, CO);
  assert.equal(entry.channel, 'email');
  assert.equal(entry.reason, 'complaint');
  assert.equal(entry.actorId, 'staff-7');
  assert.match(entry.addressHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(entry).includes('ann@example.com'), 'raw address must not be in the audit entry');
});

test('a soft bounce that does not yet suppress writes no audit entry', () => {
  const { list, sink } = listWithAudit();
  list.suppress(CO, { address: 'ann@example.com', channel: 'email', reason: 'bounce_soft' });
  assert.equal(sink.length, 0);
});

test('an unsuppress is audited before the lift, and a failing sink keeps the suppression', () => {
  let failNext = false;
  const list = createSuppressionList({
    audit: () => {
      if (failNext) throw new Error('audit down');
    },
    clock: () => NOW,
  });
  list.suppress(CO, { address: 'ann@example.com', channel: 'email', reason: 'unsubscribed' });
  failNext = true;
  assert.throws(() => list.unsuppress(CO, { address: 'ann@example.com', channel: 'email' }), /audit down/);
  assert.equal(list.isSuppressed(CO, { address: 'ann@example.com', channel: 'email' }), true);
});

test('a permanent suppression never reaches the audit sink on unsuppress', () => {
  const { list, sink } = listWithAudit();
  list.suppress(CO, { address: 'ann@example.com', channel: 'email', reason: 'bounce_hard' });
  sink.length = 0;
  assert.deepEqual(list.unsuppress(CO, { address: 'ann@example.com', channel: 'email' }), {
    ok: false,
    error: 'permanent',
  });
  assert.equal(sink.length, 0);
});

test('a suppression is applied even when the audit sink throws', () => {
  const list = createSuppressionList({
    audit: () => {
      throw new Error('audit down');
    },
    clock: () => NOW,
  });
  assert.throws(() =>
    list.suppress(CO, { address: 'ann@example.com', channel: 'email', reason: 'complaint' }),
  /audit down/);
  assert.equal(list.isSuppressed(CO, { address: 'ann@example.com', channel: 'email' }), true);
});

test('an audit sink without a clock is refused at construction', () => {
  assert.throws(() => createSuppressionList({ audit: () => {} }), /clock_missing/);
});

test('no audit sink: suppression still works as before', () => {
  const list = createSuppressionList();
  assert.deepEqual(list.suppress(CO, { address: 'ann@example.com', channel: 'email', reason: 'complaint' }), {
    ok: true,
    suppressed: true,
    reason: 'complaint',
  });
  assert.equal(list.isSuppressed(OTHER, { address: 'ann@example.com', channel: 'email' }), false);
});
