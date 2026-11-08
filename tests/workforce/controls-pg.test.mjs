/**
 * Tests for server/workforce/runtime/controls-pg.ts. No database: a fake SqlExecutor holds the control rows in
 * memory and answers the two statements in CONTROL_SQL. The load filters on company_id as the SQL does.
 * Run: node --test --experimental-transform-types tests/workforce/controls-pg.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPgControls, CONTROL_SQL, ControlConflictError } = await import('../../server/workforce/runtime/controls-pg.ts');
const { canStartWork, isRunStopped } = await import('../../server/workforce/runtime/controls.ts');

const COMPANY_A = '6f1c2e3a-1111-4a5b-8c9d-00000000000a';
const COMPANY_B = '6f1c2e3a-2222-4a5b-8c9d-00000000000b';
const AGENT = 'agent-1';
const RUN = 'run-1';
const OWNER = { kind: 'human', userId: 'owner-1' };
const FIXED = () => new Date('2026-11-03T00:00:00.000Z');

/**
 * In-memory control table. Every statement must take the company as $1 and only touches that company's rows.
 * raceBeforeReturn(rows) runs once, after the next load takes its snapshot and before the snapshot is returned,
 * which is where a concurrent writer would commit. staleLoads makes that many loads return an empty snapshot.
 */
function createFakeDb({ raceBeforeReturn = null, staleLoads = 0 } = {}) {
  const rows = new Map();
  const calls = [];
  const wins = [];
  let race = raceBeforeReturn;
  let stale = staleLoads;
  const key = (company, kind, id) => [company, kind, id].join('|');

  return {
    rows,
    calls,
    wins,
    writes() {
      return calls.filter((c) => c.text === CONTROL_SQL.insertIfAbsent || c.text === CONTROL_SQL.updateIfStatus);
    },
    async query(text, values) {
      calls.push({ text, values: [...values] });
      if (text === CONTROL_SQL.loadCompany) {
        const [company] = values;
        const out = [];
        for (const row of rows.values()) {
          if (row.company_id === company) out.push({ ...row });
        }
        if (race) {
          const hook = race;
          race = null;
          hook(rows);
        }
        if (stale > 0) {
          stale -= 1;
          return { rows: [], rowCount: 0 };
        }
        return { rows: out, rowCount: out.length };
      }
      if (text === CONTROL_SQL.insertIfAbsent) {
        const [company, kind, id, status, by, at] = values;
        if (rows.has(key(company, kind, id))) return { rows: [], rowCount: 0 };
        rows.set(key(company, kind, id), { company_id: company, kind, entry_id: id, status, changed_by: by, changed_at: at });
        wins.push(text);
        return { rows: [], rowCount: 1 };
      }
      if (text === CONTROL_SQL.updateIfStatus) {
        const [company, kind, id, status, by, at, expected] = values;
        const row = rows.get(key(company, kind, id));
        if (!row || row.company_id !== company || row.status !== expected) return { rows: [], rowCount: 0 };
        Object.assign(row, { status, changed_by: by, changed_at: at });
        wins.push(text);
        return { rows: [], rowCount: 1 };
      }
      throw new Error('unexpected SQL in fake: ' + text.slice(0, 40));
    },
  };
}

test('every statement is parameterised and takes the company as $1', async () => {
  const db = createFakeDb();
  const controls = createPgControls(db);
  await controls.pause(COMPANY_A, AGENT, OWNER, { now: FIXED });
  await controls.load(COMPANY_B);
  for (const call of db.calls) {
    assert.equal(call.values[0] === COMPANY_A || call.values[0] === COMPANY_B, true);
    assert.equal(call.text.includes(COMPANY_A), false, 'no company id is written into SQL text');
    assert.equal(call.text.includes(COMPANY_B), false, 'no company id is written into SQL text');
  }
});

test('a pause survives a reload', async () => {
  const db = createFakeDb();
  const first = createPgControls(db);
  const paused = await first.pause(COMPANY_A, AGENT, OWNER, { now: FIXED });
  assert.equal(paused.ok, true);

  // A new adapter over the same table stands in for a restarted process.
  const reloaded = await createPgControls(db).load(COMPANY_A);
  assert.deepEqual(canStartWork(reloaded, COMPANY_A, AGENT), { allowed: false, reason: 'agent_paused' });
});

test('a resume is persisted and survives a reload', async () => {
  const db = createFakeDb();
  const controls = createPgControls(db);
  await controls.pause(COMPANY_A, AGENT, OWNER, { now: FIXED });
  const resumed = await controls.resume(COMPANY_A, AGENT, OWNER, { now: FIXED });
  assert.equal(resumed.ok, true);

  const row = db.rows.get([COMPANY_A, 'agent', AGENT].join('|'));
  assert.equal(row.status, 'active');
  assert.equal(row.changed_by, 'human:owner-1');

  const reloaded = await createPgControls(db).load(COMPANY_A);
  assert.deepEqual(canStartWork(reloaded, COMPANY_A, AGENT), { allowed: true });
});

test('a refused change issues no write', async () => {
  const db = createFakeDb();
  const controls = createPgControls(db);
  const refused = await controls.resume(COMPANY_A, AGENT, OWNER, { now: FIXED });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid_transition');
  assert.equal(db.writes().length, 0);
});

test("another company's controls are never read", async () => {
  const db = createFakeDb();
  const controls = createPgControls(db);
  await controls.pause(COMPANY_B, AGENT, OWNER, { now: FIXED });
  await controls.stop(COMPANY_B, RUN, OWNER, { now: FIXED });

  // Company A has no rows of its own, so its load must not see B's pause or B's stop.
  db.calls.length = 0;
  const stateA = await controls.load(COMPANY_A);
  assert.deepEqual(canStartWork(stateA, COMPANY_A, AGENT), { allowed: true });
  assert.equal(isRunStopped(stateA, RUN, COMPANY_A), false);

  // Every statement issued for A's load was bound to A.
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].text, CONTROL_SQL.loadCompany);
  assert.deepEqual(db.calls[0].values, [COMPANY_A]);
  assert.equal(stateA.agents.has(COMPANY_B), false);
  assert.equal(stateA.runs.has(COMPANY_B), false);
});

test("a company's resume does not change another company's pause", async () => {
  const db = createFakeDb();
  const controls = createPgControls(db);
  await controls.pause(COMPANY_A, AGENT, OWNER, { now: FIXED });
  await controls.pause(COMPANY_B, AGENT, OWNER, { now: FIXED });
  await controls.resume(COMPANY_A, AGENT, OWNER, { now: FIXED });

  const reloadedB = await createPgControls(db).load(COMPANY_B);
  assert.deepEqual(canStartWork(reloadedB, COMPANY_B, AGENT), { allowed: false, reason: 'agent_paused' });
});

test('a stop is persisted and survives a reload', async () => {
  const db = createFakeDb();
  const stopped = await createPgControls(db).stop(COMPANY_A, RUN, OWNER, { now: FIXED });
  assert.equal(stopped.ok, true);
  const reloaded = await createPgControls(db).load(COMPANY_A);
  assert.equal(isRunStopped(reloaded, RUN, COMPANY_A), true);
});

test('seeding writes back only the entries it changed', async () => {
  const db = createFakeDb();
  const controls = createPgControls(db);
  await controls.seed(COMPANY_A, [{ agentId: 'agent-2', status: 'retired' }], { now: FIXED });
  assert.equal(db.writes().length, 1);
  assert.equal(db.rows.get([COMPANY_A, 'agent', 'agent-2'].join('|')).status, 'retired');
});

const stampRow = (company, kind, id, status, by) => ({
  company_id: company,
  kind,
  entry_id: id,
  status,
  changed_by: by,
  changed_at: FIXED().toISOString(),
});

test('compare-and-set: a pause that loses a race to a concurrent pause is refused and writes nothing', async () => {
  const db = createFakeDb({
    raceBeforeReturn: (rows) => rows.set([COMPANY_A, 'agent', AGENT].join('|'), stampRow(COMPANY_A, 'agent', AGENT, 'paused', 'human:owner-2')),
  });
  const result = await createPgControls(db).pause(COMPANY_A, AGENT, OWNER, { now: FIXED });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_transition');
  assert.deepEqual(db.wins, [], 'the losing pause writes nothing');
  assert.equal(db.rows.get([COMPANY_A, 'agent', AGENT].join('|')).changed_by, 'human:owner-2');
});

test('compare-and-set: a resume that loses a race to a disable reloads and resumes from disabled, not from the stale paused state', async () => {
  const key = [COMPANY_A, 'agent', AGENT].join('|');
  // The concurrent writer disables the agent after our snapshot, so our write's expected status ('paused') is stale.
  const raced = createFakeDb({
    raceBeforeReturn: (rows) => rows.set(key, stampRow(COMPANY_A, 'agent', AGENT, 'disabled', 'human:owner-2')),
  });
  raced.rows.set(key, stampRow(COMPANY_A, 'agent', AGENT, 'paused', 'human:owner-1'));
  const resumed = await createPgControls(raced).resume(COMPANY_A, AGENT, OWNER, { now: FIXED });
  assert.equal(resumed.ok, true);
  assert.equal(raced.rows.get(key).status, 'active');
  assert.equal(raced.writes().length, 2, 'one lost write, then one winning write');
  assert.equal(raced.wins.length, 1);
});

test('compare-and-set: a change that keeps losing gives up with ControlConflictError and changes nothing', async () => {
  const key = [COMPANY_A, 'agent', AGENT].join('|');
  const db = createFakeDb({ staleLoads: 3 });
  db.rows.set(key, stampRow(COMPANY_A, 'agent', AGENT, 'paused', 'human:owner-1'));
  await assert.rejects(
    createPgControls(db).pause(COMPANY_A, AGENT, OWNER, { now: FIXED }),
    (error) => error instanceof ControlConflictError,
  );
  assert.equal(db.rows.get(key).status, 'paused');
  assert.equal(db.rows.get(key).changed_by, 'human:owner-1');
  assert.deepEqual(db.wins, []);
});

test('compare-and-set: a stop that loses a race keeps the first stamp and reports the run stopped', async () => {
  const key = [COMPANY_A, 'run', RUN].join('|');
  const db = createFakeDb({
    raceBeforeReturn: (rows) => rows.set(key, stampRow(COMPANY_A, 'run', RUN, 'stopped', 'human:owner-2')),
  });
  const stopped = await createPgControls(db).stop(COMPANY_A, RUN, OWNER, { now: FIXED });
  assert.equal(stopped.ok, true);
  assert.equal(db.rows.get(key).changed_by, 'human:owner-2', 'the first stopper keeps its stamp');
  assert.deepEqual(db.wins, [], 'the second stop writes nothing');
});

test('compare-and-set: a seed that loses a race is retried from a fresh load', async () => {
  const key = [COMPANY_A, 'agent', 'agent-2'].join('|');
  const db = createFakeDb({
    raceBeforeReturn: (rows) => rows.set(key, stampRow(COMPANY_A, 'agent', 'agent-2', 'disabled', 'human:owner-2')),
  });
  const after = await createPgControls(db).seed(COMPANY_A, [{ agentId: 'agent-2', status: 'retired' }], { now: FIXED });
  assert.equal(db.rows.get(key).status, 'retired', 'the roster may tighten a disable to a retire');
  assert.equal(after.agents.get(COMPANY_A).get('agent-2').status, 'retired');
});

