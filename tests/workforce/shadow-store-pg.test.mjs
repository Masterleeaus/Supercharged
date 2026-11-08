/**
 * Tests for server/workforce/runtime/shadow-store-pg.ts. A fake SqlExecutor records every SQL call in order.
 * Run: node --test --experimental-transform-types tests/workforce/shadow-store-pg.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPgShadowStore,
  createPgShadowApply,
  retryApprovedChange,
} from '../../server/workforce/runtime/shadow-store-pg.ts';

const COMPANY = 'co-a';
const TARGET = 'job-7';
const TABLE = 'desk_jobs';

/**
 * Fake executor. `target` is the row in desk_jobs (null = absent). `shadow` is a shadow_changes row in DB shape.
 * Each option can make a statement fail or report a different rowCount.
 */
function fakeDb({ target = { version: 3 }, shadow = null, failWrite = null, writeRowCount = 1 } = {}) {
  const log = [];
  const db = {
    log,
    async query(text, values = []) {
      log.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.startsWith(`SELECT version FROM ${TABLE}`)) {
        return target === null ? { rows: [], rowCount: 0 } : { rows: [{ version: target.version }], rowCount: 1 };
      }
      if (/^(INSERT INTO|UPDATE|DELETE FROM) desk_jobs/.test(text)) {
        if (failWrite && text.includes(failWrite)) throw new Error('write failed');
        return { rows: [], rowCount: writeRowCount };
      }
      if (text.startsWith('SELECT ') && text.includes('FROM shadow_changes')) {
        return shadow ? { rows: [shadow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.startsWith('UPDATE shadow_changes') || text.startsWith('INSERT INTO shadow_changes')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return db;
}

const change = (overrides = {}) => ({
  id: 'sc-1',
  companyId: COMPANY,
  runId: 'run-1',
  toolId: 'tool-job-update',
  category: 'other',
  targetTable: TABLE,
  targetId: TARGET,
  operation: 'update',
  before: { status: 'open' },
  after: { status: 'scheduled' },
  baseVersion: 3,
  requestedBy: { agentId: 'agent-1', roleId: 'role-scheduler' },
  policyVersion: 1,
  status: 'approved',
  createdAt: 1000,
  ...overrides,
});

const sqlOf = (db) => db.log.map((entry) => entry.text);
const ALLOW = { targetTables: [TABLE] };

test('successful apply: BEGIN, locked version check, write, COMMIT, all on one executor, in that order', async () => {
  const db = fakeDb({ target: { version: 3 } });
  const apply = createPgShadowApply(db, ALLOW);
  const outcome = await apply(change());

  assert.equal(outcome, 'applied');
  const sql = sqlOf(db);
  assert.equal(sql[0], 'BEGIN');
  assert.match(sql[1], /^SELECT version FROM desk_jobs .* FOR UPDATE$/);
  assert.match(sql[2], /^UPDATE desk_jobs SET status = \$3, version = version \+ 1 WHERE company_id = \$1 AND id = \$2$/);
  assert.equal(sql[3], 'COMMIT');
  assert.equal(sql.length, 4);
  assert.equal(sql.includes('ROLLBACK'), false);
});

test('the version check and the write share one transaction: the write never runs outside BEGIN ... COMMIT', async () => {
  const db = fakeDb({ target: { version: 3 } });
  await createPgShadowApply(db, ALLOW)(change());
  const sql = sqlOf(db);
  const begin = sql.indexOf('BEGIN');
  const commit = sql.indexOf('COMMIT');
  const check = sql.findIndex((s) => s.includes('FOR UPDATE'));
  const write = sql.findIndex((s) => s.startsWith('UPDATE desk_jobs'));
  assert.ok(begin < check && check < write && write < commit, `order was ${JSON.stringify(sql)}`);
});

test('the check passes the change company and target id as bound values, not spliced text', async () => {
  const db = fakeDb({ target: { version: 3 } });
  await createPgShadowApply(db, ALLOW)(change({ targetId: "job-7'; DROP TABLE x; --" }));
  const check = db.log.find((e) => e.text.includes('FOR UPDATE'));
  assert.deepEqual(check.values, [COMPANY, "job-7'; DROP TABLE x; --"]);
  assert.equal(check.text.includes('DROP'), false);
});

test('conflict: a version mismatch rolls back, writes nothing, and returns conflict', async () => {
  const db = fakeDb({ target: { version: 4 } });
  const outcome = await createPgShadowApply(db, ALLOW)(change({ baseVersion: 3 }));

  assert.equal(outcome, 'conflict');
  const sql = sqlOf(db);
  assert.deepEqual(sql, ['BEGIN', sql[1], 'ROLLBACK']);
  assert.match(sql[1], /FOR UPDATE/);
  assert.equal(sql.some((s) => s.startsWith('UPDATE desk_jobs')), false);
  assert.equal(sql.includes('COMMIT'), false);
});

test('an absent target counts as version 0, so an insert with base 0 applies', async () => {
  const db = fakeDb({ target: null });
  const outcome = await createPgShadowApply(db, ALLOW)(
    change({ operation: 'insert', before: null, after: { title: 'New job' }, baseVersion: 0 }),
  );
  assert.equal(outcome, 'applied');
  const insert = db.log.find((e) => e.text.startsWith('INSERT INTO desk_jobs'));
  assert.match(insert.text, /^INSERT INTO desk_jobs \(company_id, id, version, title\) VALUES \(\$1, \$2, \$3, \$4\)$/);
  assert.deepEqual(insert.values, [COMPANY, TARGET, 1, 'New job']);
});

test('a write error rolls back, rethrows, and never COMMITs', async () => {
  const db = fakeDb({ target: { version: 3 }, failWrite: 'UPDATE desk_jobs' });
  await assert.rejects(createPgShadowApply(db, ALLOW)(change()), /write failed/);
  const sql = sqlOf(db);
  assert.equal(sql[0], 'BEGIN');
  assert.equal(sql.at(-1), 'ROLLBACK');
  assert.equal(sql.includes('COMMIT'), false);
});

test('a write that touches no row is treated as an error and rolls back', async () => {
  const db = fakeDb({ target: { version: 3 }, writeRowCount: 0 });
  await assert.rejects(createPgShadowApply(db, ALLOW)(change()), /update target missing/);
  assert.equal(sqlOf(db).at(-1), 'ROLLBACK');
});

test('a target table outside the allowlist is refused before any SQL runs', async () => {
  const db = fakeDb();
  await assert.rejects(createPgShadowApply(db, ALLOW)(change({ targetTable: 'users' })), /not allowed/);
  assert.equal(db.log.length, 0);
});

test('column names that are not plain identifiers are refused and roll back', async () => {
  const db = fakeDb({ target: { version: 3 } });
  await assert.rejects(
    createPgShadowApply(db, ALLOW)(change({ after: { 'status; DROP': 'x' } })),
    /invalid column/,
  );
  assert.equal(sqlOf(db).at(-1), 'ROLLBACK');
});

test('stored JSON cannot override company_id, id or version', async () => {
  const db = fakeDb({ target: null });
  await createPgShadowApply(db, ALLOW)(
    change({ operation: 'insert', before: null, after: { id: 'evil', company_id: 'co-b', version: 99, title: 't' }, baseVersion: 0 }),
  );
  const insert = db.log.find((e) => e.text.startsWith('INSERT INTO desk_jobs'));
  assert.deepEqual(insert.values, [COMPANY, TARGET, 1, 't']);
});

test('store.transition is compare-and-set on status and reports whether a row moved', async () => {
  const db = fakeDb();
  const store = createPgShadowStore(db);
  const moved = await store.transition(COMPANY, 'sc-1', 'pending', { status: 'approved', decidedAt: 2000 });
  assert.equal(moved, true);
  const sql = db.log[0].text;
  assert.match(sql, /^UPDATE shadow_changes SET status = \$4, decided_at = \$5 WHERE company_id = \$1 AND id = \$2 AND status = \$3$/);
  assert.deepEqual(db.log[0].values.slice(0, 3), [COMPANY, 'sc-1', 'pending']);
});

test('store.transition returns false when zero rows match', async () => {
  const db = fakeDb();
  const original = db.query;
  db.query = async (text, values) => (text.startsWith('UPDATE shadow_changes') ? { rows: [], rowCount: 0 } : original(text, values));
  assert.equal(await createPgShadowStore(db).transition(COMPANY, 'sc-1', 'pending', { status: 'rejected' }), false);
});

test('store.transition refuses a patch key that is not a known column', async () => {
  const store = createPgShadowStore(fakeDb());
  await assert.rejects(store.transition(COMPANY, 'sc-1', 'pending', { status: 'applied', after_json: {} }), /cannot update/);
});

test('store.get scopes by company and maps the row back to a ShadowChange', async () => {
  const shadow = {
    id: 'sc-1', company_id: COMPANY, run_id: 'run-1', tool_id: 't', category: 'other', target_table: TABLE,
    target_id: TARGET, operation: 'update', before_json: { status: 'open' }, after_json: { status: 'scheduled' },
    base_version: 3, requested_by_agent_id: 'agent-1', requested_by_role_id: 'role-scheduler', policy_version: '1',
    status: 'pending', approved_by_kind: null, approved_by_id: null, created_at: new Date(1000), decided_at: null, applied_at: null,
  };
  const db = fakeDb({ shadow });
  const found = await createPgShadowStore(db).get(COMPANY, 'sc-1');
  assert.deepEqual(db.log[0].values, [COMPANY, 'sc-1']);
  assert.equal(found.companyId, COMPANY);
  assert.equal(found.baseVersion, 3);
  assert.equal(found.policyVersion, 1);
  assert.equal(found.createdAt, 1000);
  assert.equal(found.decidedAt, undefined);
  assert.deepEqual(found.requestedBy, { agentId: 'agent-1', roleId: 'role-scheduler' });
});

test('retry: a change left at approved is re-applied by an explicit call and marked applied', async () => {
  const shadow = {
    id: 'sc-1', company_id: COMPANY, run_id: 'run-1', tool_id: 't', category: 'other', target_table: TABLE,
    target_id: TARGET, operation: 'update', before_json: { status: 'open' }, after_json: { status: 'scheduled' },
    base_version: 3, requested_by_agent_id: 'a', requested_by_role_id: 'r', policy_version: '1',
    status: 'approved', created_at: new Date(1000), decided_at: new Date(1500), applied_at: null,
  };
  const db = fakeDb({ target: { version: 3 }, shadow });
  const store = createPgShadowStore(db);
  const result = await retryApprovedChange({ store, apply: createPgShadowApply(db, ALLOW), now: () => 2500 }, COMPANY, 'sc-1');

  assert.deepEqual(result, { ok: true, status: 'applied' });
  const sql = sqlOf(db);
  assert.ok(sql.includes('COMMIT'));
  const mark = db.log.find((e) => e.text.includes('SET status = $4'));
  assert.ok(mark && mark.text.includes('AND status = $3'));
  assert.equal(mark.values[3], 'applied');
});

test('retry: an apply that throws again leaves the row at approved and rethrows', async () => {
  const shadow = {
    id: 'sc-1', company_id: COMPANY, run_id: 'run-1', tool_id: 't', category: 'other', target_table: TABLE,
    target_id: TARGET, operation: 'update', before_json: null, after_json: { status: 'x' },
    base_version: 3, requested_by_agent_id: 'a', requested_by_role_id: 'r', policy_version: '1',
    status: 'approved', created_at: new Date(1000),
  };
  const db = fakeDb({ target: { version: 3 }, shadow, failWrite: 'UPDATE desk_jobs' });
  const store = createPgShadowStore(db);
  await assert.rejects(
    retryApprovedChange({ store, apply: createPgShadowApply(db, ALLOW), now: () => 1 }, COMPANY, 'sc-1'),
    /write failed/,
  );
  assert.equal(db.log.some((e) => e.text.includes('SET status = $4')), false);
});

test('retry: refuses a change that is not at approved, and runs nothing', async () => {
  const shadow = {
    id: 'sc-1', company_id: COMPANY, run_id: 'run-1', tool_id: 't', category: 'other', target_table: TABLE,
    target_id: TARGET, operation: 'update', after_json: { s: 1 }, base_version: 3,
    requested_by_agent_id: 'a', requested_by_role_id: 'r', policy_version: '1', status: 'applied', created_at: new Date(1000),
  };
  const db = fakeDb({ shadow });
  let applyCalls = 0;
  const result = await retryApprovedChange(
    { store: createPgShadowStore(db), apply: async () => { applyCalls += 1; return 'applied'; }, now: () => 1 },
    COMPANY,
    'sc-1',
  );
  assert.deepEqual(result, { ok: false, reason: 'not_approved' });
  assert.equal(applyCalls, 0);
});

test('retry: another company id finds nothing', async () => {
  const db = fakeDb({ shadow: null });
  const result = await retryApprovedChange(
    { store: createPgShadowStore(db), apply: async () => 'applied', now: () => 1 },
    'co-b',
    'sc-1',
  );
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
  assert.deepEqual(db.log[0].values, ['co-b', 'sc-1']);
});

test('listPending selects by company and pending status, bounded, and maps the rows back', async () => {
  const seen = [];
  const row = {
    id: 'sc-1',
    company_id: COMPANY,
    run_id: 'run-1',
    tool_id: 'tool-job-update',
    category: 'other',
    target_table: TABLE,
    target_id: TARGET,
    operation: 'update',
    before_json: { status: 'open' },
    after_json: { status: 'scheduled' },
    base_version: 3,
    requested_by_agent_id: 'agent-1',
    requested_by_role_id: 'role-scheduler',
    policy_version: '1',
    status: 'pending',
    approved_by_kind: null,
    approved_by_id: null,
    created_at: '2026-11-04T00:00:00.000Z',
    decided_at: null,
    applied_at: null,
  };
  const db = {
    async query(text, values) {
      seen.push({ text, values });
      return { rows: [row], rowCount: 1 };
    },
  };
  const rows = await createPgShadowStore(db).listPending(COMPANY);
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /WHERE company_id = \$1 AND status = \$2 ORDER BY created_at ASC LIMIT \$3/);
  assert.deepEqual(seen[0].values, [COMPANY, 'pending', 200]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].companyId, COMPANY);
  assert.equal(rows[0].status, 'pending');
  assert.deepEqual(rows[0].after, { status: 'scheduled' });
});
