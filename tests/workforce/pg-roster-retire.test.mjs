import test from 'node:test';
import assert from 'node:assert/strict';

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

const { createPgRoster } = await import('../../server/workforce/pg-roster.ts');

const COMPANY = 'co-1';
const OTHER = 'co-2';

/** A fake SqlExecutor that keeps workforce_agents rows in memory and records every call. */
function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    rows,
    async query(text, values) {
      calls.push({ text, values });
      if (text.startsWith('SELECT')) {
        const [companyId, agentId] = values;
        const row = rows.find((r) => r.company_id === companyId && r.id === agentId);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (text.startsWith("UPDATE workforce_agents SET status = 'retired'")) {
        const [companyId, agentId] = values;
        const row = rows.find((r) => r.company_id === companyId && r.id === agentId && r.status !== 'retired');
        if (!row) return { rows: [], rowCount: 0 };
        row.status = 'retired';
        return { rows: [{ ...row }], rowCount: 1 };
      }
      throw new Error('unexpected query in test');
    },
  };
}

function agentRow(overrides = {}) {
  return {
    id: 'agent-1',
    company_id: COMPANY,
    role_id: 'role-x',
    team_id: null,
    channels: '["email"]',
    permissions: '[]',
    autonomy: 'assist',
    status: 'active',
    ...overrides,
  };
}

function roster(db) {
  return createPgRoster({ db, catalogue: new Map(), now: () => new Date('2026-11-04T00:00:00Z') });
}

const actor = 'user-1';

test('retires an idle agent and scopes the write to the company', async () => {
  const db = fakeDb([agentRow()]);
  const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor, isRunning: () => false });
  assert.equal(result.ok, true);
  assert.equal(result.agent.status, 'retired');
  assert.equal(db.rows[0].status, 'retired');
  const update = db.calls.find((c) => c.text.startsWith('UPDATE'));
  assert.match(update.text, /company_id = \$1/);
  assert.match(update.text, /status <> 'retired'/);
  assert.equal(update.values[0], COMPANY);
});

test('refuses with agent_running and writes nothing while a task is in progress', async () => {
  const db = fakeDb([agentRow()]);
  const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor, isRunning: async () => true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_running');
  assert.equal(db.rows[0].status, 'active');
  assert.equal(db.calls.some((c) => c.text.startsWith('UPDATE')), false);
});

test('fails closed with run_check_unavailable when the check throws, is missing or is not a boolean', async () => {
  const cases = [
    { isRunning: () => { throw new Error('store down'); } },
    { isRunning: () => 'no' },
    { isRunning: undefined },
  ];
  for (const options of cases) {
    const db = fakeDb([agentRow()]);
    const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor, ...options });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'run_check_unavailable');
    assert.equal(db.rows[0].status, 'active');
    assert.equal(db.calls.some((c) => c.text.startsWith('UPDATE')), false);
  }
});

test('another company\'s agent id is reported as agent_not_found and not changed', async () => {
  const db = fakeDb([agentRow({ company_id: OTHER })]);
  const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor, isRunning: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_not_found');
  assert.equal(db.rows[0].status, 'active');
});

test('an already retired agent is refused with agent_retired', async () => {
  const db = fakeDb([agentRow({ status: 'retired' })]);
  const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor, isRunning: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_retired');
});

test('a retirement that races with another one matches no row and is refused with agent_retired', async () => {
  const db = fakeDb([agentRow()]);
  // The other request retires the agent after the first read but before the conditional UPDATE.
  const isRunning = async () => {
    db.rows[0].status = 'retired';
    return false;
  };
  const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor, isRunning });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_retired');
});

test('an missing actor is refused with invalid_input before any query', async () => {
  const db = fakeDb([agentRow()]);
  const result = await roster(db).retireAgent(COMPANY, 'agent-1', { actor: '', isRunning: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_input');
  assert.equal(db.calls.length, 0);
});
