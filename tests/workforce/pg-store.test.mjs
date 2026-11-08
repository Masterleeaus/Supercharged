import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// No database. A fake SqlExecutor keeps the two tables in memory and answers the statements that
// pg-store.ts issues. It records every statement so the tests can check the SQL text as well as the result.
const { createPgRunStore } = await import('../../server/workforce/runtime/pg-store.ts');
const { RunVersionConflictError } = await import('../../server/workforce/runtime/store.ts');
const { AiRuntimeError } = await import('../../server/services/ai-runtime/types.ts');

const COMPANY_A = '6f1c2e3a-1111-4a5b-8c9d-00000000000a';
const COMPANY_B = '6f1c2e3a-2222-4a5b-8c9d-00000000000b';

const norm = (text) => text.replace(/\s+/g, ' ').trim();
const parse = (value) => (value === null || value === undefined ? null : JSON.parse(value));
const cloneRow = (row) => structuredClone(row);

function createFakeDb() {
  const runs = new Map(); // id -> row
  const audit = [];
  const calls = [];
  let seq = 0;

  return {
    calls,
    runs,
    audit,
    async query(text, values) {
      calls.push({ text, values: [...values] });
      const sql = norm(text);

      if (sql.startsWith('INSERT INTO workforce_runs')) {
        const [id, company, status, team, path, delegations, limits, maxTokens, maxToolCalls, tokensUsed, toolCalls, retry, pending, reason, createdAt, updatedAt] = values;
        if (runs.has(id)) return { rows: [], rowCount: 0 };
        const row = {
          id, company_id: company, status, version: 1,
          team: parse(team), path: parse(path), delegations: parse(delegations), limits: parse(limits),
          budget_max_tokens: maxTokens, budget_max_tool_calls: maxToolCalls,
          budget_tokens_used: tokensUsed, budget_tool_calls: toolCalls,
          retry: parse(retry), pending_approval: parse(pending), reason,
          created_at: new Date(createdAt), updated_at: new Date(updatedAt),
        };
        runs.set(id, row);
        return { rows: [cloneRow(row)], rowCount: 1 };
      }

      if (sql.startsWith('UPDATE workforce_runs')) {
        const [company, id, expected, status, team, path, delegations, limits, maxTokens, maxToolCalls, tokensUsed, toolCalls, retry, pending, reason, updatedAt] = values;
        const row = runs.get(id);
        if (!row || row.company_id !== company || row.version !== expected) return { rows: [], rowCount: 0 };
        Object.assign(row, {
          status, team: parse(team), path: parse(path), delegations: parse(delegations), limits: parse(limits),
          budget_max_tokens: maxTokens, budget_max_tool_calls: maxToolCalls,
          budget_tokens_used: tokensUsed, budget_tool_calls: toolCalls,
          retry: parse(retry), pending_approval: parse(pending), reason,
          updated_at: new Date(updatedAt), version: row.version + 1,
        });
        return { rows: [cloneRow(row)], rowCount: 1 };
      }

      if (sql.startsWith('SELECT version FROM workforce_runs')) {
        const [company, id] = values;
        const row = runs.get(id);
        const hit = row && row.company_id === company ? [{ version: row.version }] : [];
        return { rows: hit, rowCount: hit.length };
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM workforce_runs WHERE company_id = $1 AND id = $2')) {
        const [company, id] = values;
        const row = runs.get(id);
        const hit = row && row.company_id === company ? [cloneRow(row)] : [];
        return { rows: hit, rowCount: hit.length };
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM workforce_runs WHERE company_id = $1 ORDER BY')) {
        const [company] = values;
        const hit = [...runs.values()]
          .filter((r) => r.company_id === company)
          .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
          .map(cloneRow);
        return { rows: hit, rowCount: hit.length };
      }

      if (sql.startsWith('INSERT INTO workforce_audit_events')) {
        const [id, company, runId, kind, actor, outcome, data, at] = values;
        audit.push({ seq: ++seq, id, company_id: company, run_id: runId, kind, actor, outcome, data: parse(data), created_at: new Date(at) });
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM workforce_audit_events WHERE company_id = $1')) {
        const [company, runId] = values;
        const hit = audit
          .filter((e) => e.company_id === company && (values.length < 2 || e.run_id === runId))
          .sort((a, b) => a.seq - b.seq)
          .map((e) => ({ id: e.id, company_id: e.company_id, run_id: e.run_id, kind: e.kind, data: e.data, created_at: e.created_at }));
        return { rows: hit, rowCount: hit.length };
      }

      throw new Error(`fake db: unexpected statement: ${sql}`);
    },
  };
}

function makeRun(companyId, overrides = {}) {
  return {
    id: randomUUID(),
    companyId,
    status: 'queued',
    version: 0,
    createdAt: '2026-11-03T09:00:00.000Z',
    updatedAt: '2026-11-03T09:00:00.000Z',
    team: {
      id: 'team-1',
      name: 'Field',
      coordinator: 'coord',
      members: ['coord', 'tech'],
      roles: { coord: { id: 'coord', handoffTo: ['tech'] }, tech: { id: 'tech', handoffTo: [] } },
    },
    path: ['coord'],
    delegations: [],
    limits: { maxDelegationDepth: 3, maxFanOut: 4 },
    budget: { maxTokens: 1000, maxToolCalls: 10, tokensUsed: 0, toolCalls: 0 },
    retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 },
    pendingApproval: null,
    reason: null,
    ...overrides,
  };
}

function makeAudit(companyId, runId, overrides = {}) {
  return {
    id: randomUUID(),
    companyId,
    runId,
    kind: 'run.status',
    at: '2026-11-03T09:00:01.000Z',
    data: { from: 'queued', to: 'running', reason: null },
    ...overrides,
  };
}

test('insertRun stores version 1 and getRun returns the same record for the same company', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const run = makeRun(COMPANY_A);
  const stored = await store.insertRun(COMPANY_A, run);
  assert.deepEqual(stored, { ...run, version: 1 });
  assert.deepEqual(await store.getRun(COMPANY_A, run.id), { ...run, version: 1 });
});

test('insertRun refuses a duplicate id and a run whose companyId differs from the call', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const run = makeRun(COMPANY_A);
  await store.insertRun(COMPANY_A, run);
  await assert.rejects(store.insertRun(COMPANY_A, run), /run already exists/);
  await assert.rejects(store.insertRun(COMPANY_A, makeRun(COMPANY_B)), /does not match the store call/);
});

test('updateRun is a compare-and-set: the matching version wins and the stale writer gets a conflict', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const run = makeRun(COMPANY_A);
  const v1 = await store.insertRun(COMPANY_A, run);

  const v2 = await store.updateRun(COMPANY_A, { ...v1, status: 'running', reason: 'started' }, 1);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'running');

  // A second writer that read version 1 must lose, and must not overwrite the row.
  await assert.rejects(
    store.updateRun(COMPANY_A, { ...v1, status: 'failed' }, 1),
    (err) => err instanceof RunVersionConflictError && err.code === 'run_version_conflict',
  );
  const stored = await store.getRun(COMPANY_A, run.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.status, 'running');
});

test('updateRun conflict check is in the UPDATE itself, and the row count decides the outcome', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const run = makeRun(COMPANY_A);
  const v1 = await store.insertRun(COMPANY_A, run);
  db.calls.length = 0;
  await store.updateRun(COMPANY_A, v1, 1);
  const update = db.calls.find((c) => norm(c.text).startsWith('UPDATE workforce_runs'));
  assert.ok(update, 'an UPDATE was issued');
  assert.match(norm(update.text), /WHERE company_id = \$1 AND id = \$2 AND version = \$3/);
  assert.match(norm(update.text), /version = version \+ 1/);
  assert.equal(update.values[2], 1);
});

test('updateRun on a run that does not exist is a not-found error, not a version conflict', async () => {
  const store = createPgRunStore(createFakeDb());
  const ghost = makeRun(COMPANY_A);
  await assert.rejects(store.updateRun(COMPANY_A, ghost, 1), (err) => {
    assert.ok(!(err instanceof RunVersionConflictError));
    assert.match(err.message, /run not found/);
    return true;
  });
});

test('updateRun rejects a version that is not a positive integer before any query', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const v1 = await store.insertRun(COMPANY_A, makeRun(COMPANY_A));
  db.calls.length = 0;
  await assert.rejects(store.updateRun(COMPANY_A, v1, 0), /positive integer/);
  await assert.rejects(store.updateRun(COMPANY_A, v1, 1.5), /positive integer/);
  assert.equal(db.calls.length, 0);
});

test('pending approval, delegations and budget counters survive an update round trip', async () => {
  const store = createPgRunStore(createFakeDb());
  const run = makeRun(COMPANY_A);
  const v1 = await store.insertRun(COMPANY_A, run);
  const delegation = { id: 'd1', parentId: null, fromRole: 'coord', toRole: 'tech', depth: 1, status: 'open' };
  const pendingApproval = { approvalId: 'a1', toolId: 'invoice.send', paramsSha256: 'abc', actorKey: 'agent:tech' };
  const next = {
    ...v1,
    status: 'awaiting_approval',
    path: ['coord', 'tech'],
    delegations: [delegation],
    budget: { ...v1.budget, tokensUsed: 120, toolCalls: 3 },
    pendingApproval,
    reason: 'needs owner approval',
    updatedAt: '2026-11-03T09:10:00.000Z',
  };
  const saved = await store.updateRun(COMPANY_A, next, 1);
  assert.deepEqual(saved, { ...next, version: 2 });
  assert.deepEqual(await store.getRun(COMPANY_A, run.id), { ...next, version: 2 });
});

test('getRun and updateRun never return or change another company\'s run', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const run = makeRun(COMPANY_A);
  const v1 = await store.insertRun(COMPANY_A, run);

  assert.equal(await store.getRun(COMPANY_B, run.id), null);
  assert.deepEqual(await store.listRuns(COMPANY_B), []);
  await assert.rejects(store.updateRun(COMPANY_B, { ...v1, companyId: COMPANY_B, status: 'failed' }, 1), /run not found/);
  await assert.rejects(store.updateRun(COMPANY_A, { ...v1, companyId: COMPANY_B }, 1), /does not match/);

  const stored = await store.getRun(COMPANY_A, run.id);
  assert.equal(stored.status, 'queued');
  assert.equal(stored.version, 1);
});

test('listRuns returns only the caller\'s runs', async () => {
  const store = createPgRunStore(createFakeDb());
  await store.insertRun(COMPANY_A, makeRun(COMPANY_A));
  await store.insertRun(COMPANY_A, makeRun(COMPANY_A));
  await store.insertRun(COMPANY_B, makeRun(COMPANY_B));
  assert.equal((await store.listRuns(COMPANY_A)).length, 2);
  assert.equal((await store.listRuns(COMPANY_B)).length, 1);
  assert.ok((await store.listRuns(COMPANY_A)).every((r) => r.companyId === COMPANY_A));
});

test('every query carries the caller\'s company_id as a filter or column, and that value is bound', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);

  for (const company of [COMPANY_A, COMPANY_B]) {
    const start = db.calls.length;
    const run = await store.insertRun(company, makeRun(company));
    await store.getRun(company, run.id);
    await store.listRuns(company);
    await store.updateRun(company, { ...run, status: 'running' }, 1).catch(() => {});
    await store.updateRun(company, { ...run, status: 'failed' }, 99).catch(() => {});
    await store.appendAudit(makeAudit(company, run.id));
    await store.listAudit(company);
    await store.listAudit(company, run.id);

    const issued = db.calls.slice(start);
    assert.ok(issued.length >= 9, 'every method issued at least one query');
    for (const call of issued) {
      const sql = norm(call.text);
      assert.match(sql, /company_id/, `company_id missing from: ${sql}`);
      assert.ok(call.values.includes(company), `caller company not bound in: ${sql}`);
      if (!sql.startsWith('INSERT')) {
        assert.match(sql, /WHERE company_id = \$1/, `company filter not first predicate: ${sql}`);
        assert.equal(call.values[0], company);
      }
    }
  }
});

test('an invalid or missing company id is refused before any query runs', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  await assert.rejects(store.getRun('', 'x'), (err) => err instanceof AiRuntimeError && err.code === 'company_id_required');
  await assert.rejects(store.listRuns('bad id with spaces'), (err) => err instanceof AiRuntimeError && err.code === 'company_id_invalid');
  await assert.rejects(store.listAudit(undefined), (err) => err instanceof AiRuntimeError && err.code === 'company_id_required');
  assert.equal(db.calls.length, 0);
});

test('audit is append-only: listAudit returns events in append order, filtered by company and run', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const runA1 = randomUUID();
  const runA2 = randomUUID();
  const e1 = makeAudit(COMPANY_A, runA1, { kind: 'run.created', data: { teamId: 'team-1' } });
  const e2 = makeAudit(COMPANY_A, runA2, { kind: 'run.status', at: '2026-11-03T09:00:02.000Z' });
  const e3 = makeAudit(COMPANY_A, runA1, { kind: 'tool.decision', at: '2026-11-03T09:00:03.000Z', data: { toolId: 't', outcome: 'refused', actorId: 'agent:tech' } });
  const eB = makeAudit(COMPANY_B, randomUUID());
  for (const e of [e1, e2, e3, eB]) await store.appendAudit(e);

  const all = await store.listAudit(COMPANY_A);
  assert.deepEqual(all.map((e) => e.id), [e1.id, e2.id, e3.id]);
  assert.deepEqual((await store.listAudit(COMPANY_A, runA1)).map((e) => e.id), [e1.id, e3.id]);
  assert.deepEqual((await store.listAudit(COMPANY_B)).map((e) => e.id), [eB.id]);
  assert.deepEqual(all[0].data, e1.data);
  assert.equal(all[0].at, e1.at);

  // The outcome and actor are lifted into their own columns for filtering.
  const row = db.audit.find((r) => r.id === e3.id);
  assert.equal(row.outcome, 'refused');
  assert.equal(row.actor, 'agent:tech');
});

test('appendAudit refuses an event with no company, or an unknown kind, before any query runs', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  await assert.rejects(store.appendAudit(makeAudit(null, null)), /cannot be stored/);
  await assert.rejects(store.appendAudit(makeAudit(COMPANY_A, null, { kind: 'run.deleted' })), /unknown audit kind/);
  assert.equal(db.calls.length, 0);
});

test('audit has no update or delete surface, and no statement changes an audit row', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  assert.deepEqual(Object.keys(store).sort(), ['appendAudit', 'getRun', 'insertRun', 'listAudit', 'listRuns', 'updateRun']);
  assert.ok(Object.keys(store).every((k) => !/audit/i.test(k) || /^(appendAudit|listAudit)$/.test(k)));

  const run = await store.insertRun(COMPANY_A, makeRun(COMPANY_A));
  await store.appendAudit(makeAudit(COMPANY_A, run.id));
  await store.listAudit(COMPANY_A, run.id);
  for (const call of db.calls.filter((c) => /workforce_audit_events/.test(c.text))) {
    assert.match(norm(call.text), /^(INSERT INTO|SELECT)\b/, `audit table touched by: ${norm(call.text)}`);
  }
});

test('draft migration: DRAFT header, IF NOT EXISTS everywhere, company_id NOT NULL, no foreign keys', () => {
  const sql = readFileSync(new URL('../../migrations/DRAFT_workforce_runs.sql', import.meta.url), 'utf8');
  const header = sql.split('\n').slice(0, 3).join('\n');
  assert.match(header, /DRAFT/);
  assert.match(header, /NOT APPLIED/);
  assert.equal(sql.match(/CREATE TABLE\b/g).length, 4);
  assert.equal(sql.match(/CREATE TABLE IF NOT EXISTS\b/g).length, 4);
  assert.equal(sql.match(/CREATE INDEX\b/g).length, sql.match(/CREATE INDEX IF NOT EXISTS\b/g).length);
  assert.equal(sql.match(/company_id\s+uuid\s+NOT NULL/g).length, 4);
  assert.doesNotMatch(sql, /\bREFERENCES\b|\bFOREIGN KEY\s*\(/i);
  for (const table of ['workforce_runs', 'workforce_tasks', 'workforce_tool_calls', 'workforce_audit_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
});

test('schema.ts and schema.js both define the four workforce tables, and schema.ts keeps CRLF', () => {
  const ts = readFileSync(new URL('../../shared/schema.ts', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../../shared/schema.js', import.meta.url), 'utf8');
  for (const name of ['workforce_runs', 'workforce_tasks', 'workforce_tool_calls', 'workforce_audit_events']) {
    assert.match(ts, new RegExp(`pgTable\\("${name}"`));
    assert.match(js, new RegExp(`pgTable\\("${name}"`));
  }
  const lines = ts.split('\n');
  assert.ok(lines.slice(0, -1).every((line) => line.endsWith('\r')), 'every line of schema.ts ends with CRLF');
});
