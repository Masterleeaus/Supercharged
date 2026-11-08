/**
 * Runtime wiring of the governance modules into the tool registry (lane 5).
 *  - R4: an executed write commits with its action_journal row, in one transaction (action-journal-pg.ts).
 *  - R5: the handler receives the provider idempotency key, not the Desk intent key (provider-idempotency.ts).
 *  - R6: an uncertain write is read back first, and the owner is told only if the record still does not show the outcome.
 *  - R8: a predictive agent's direct write is refused and staged as a shadow change (predictive-staging.ts).
 *
 * No network, no database, no real timers beyond the short tool timeout. The SQL executor and shadow are fakes.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/runtime-wiring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../server/workforce/runtime/tool-registry.ts';
import { createIdempotencyStore, idempotencyKey } from '../../server/workforce/runtime/idempotency.ts';
import { providerIdempotencyKey } from '../../server/workforce/runtime/provider-idempotency.ts';

const CO = 'company-1';
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const autoAgent = { kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy: 'auto' };
const predictiveAgent = { kind: 'agent', agentId: 'pa-1', roleId: 'forecaster', autonomy: 'predictive' };

const unusedGate = () => {
  const fail = async () => {
    throw new Error('approval gate should not be used');
  };
  return { gateAction: fail, readApproval: fail, claimApproval: fail };
};

/** A single-connection SQL executor that records every statement. failOn(text) makes a statement throw. */
function fakeDb(failOn = () => false) {
  const log = [];
  return {
    log,
    query: async (text, values) => {
      log.push({ text, values });
      if (failOn(text)) throw new Error('db down');
      return { rows: [], rowCount: 1 };
    },
  };
}

function setup(definitions, extra = {}) {
  const registry = createToolRegistry({
    gate: unusedGate(),
    redact: (value) => value,
    audit: { record: async () => {} },
    now: () => new Date(NOW),
    timeoutMs: 20,
    ...extra,
  });
  for (const definition of definitions) registry.register(definition);
  return registry;
}

const writeCall = (toolId, actor = autoAgent, extra = {}) => ({
  companyId: CO,
  toolId,
  params: { note: 'x' },
  actor,
  runId: 'run-1',
  callIndex: 0,
  ...extra,
});

// ---- R4: journal in the same transaction -------------------------------------------------------------------------

test('R4: an executed write commits its journal row in the same transaction, after the handler writes', async () => {
  const db = fakeDb();
  const registry = setup(
    [
      {
        id: 'notes.save',
        risk: 'low',
        access: 'write',
        schema: { note: { type: 'string' } },
        handler: async (params, context) => {
          await context.db.query('UPDATE notes SET body = $1', [params.note]);
          return { saved: true };
        },
      },
    ],
    { journal: { db } },
  );

  const result = await registry.invoke(writeCall('notes.save'));

  assert.equal(result.outcome, 'executed');
  assert.deepEqual(
    db.log.map((entry) => entry.text.split(' ')[0]),
    ['BEGIN', 'UPDATE', 'INSERT', 'COMMIT'],
    'the handler write and the journal INSERT share one transaction',
  );
  const insert = db.log.find((entry) => entry.text.startsWith('INSERT INTO action_journal'));
  assert.match(insert.text, /\(company_id, run_id, tool_id, tier, actor_kind, actor_id, role_id, params_sha256, idempotency_key, attempts, handler_outcome, created_at\)/);
  assert.ok(insert.values.includes('notes.save'), 'the journal row records the tool');
});

test('R4: when the journal INSERT fails, the write is rolled back, reported uncertain, and never transient', async () => {
  const db = fakeDb((text) => text.startsWith('INSERT INTO action_journal'));
  let handlerRan = false;
  const registry = setup(
    [
      {
        id: 'notes.save',
        risk: 'low',
        access: 'write',
        schema: { note: { type: 'string' } },
        handler: async (params, context) => {
          handlerRan = true;
          await context.db.query('UPDATE notes SET body = $1', [params.note]);
          return { saved: true };
        },
      },
    ],
    { journal: { db } },
  );

  const result = await registry.invoke(writeCall('notes.save'));

  assert.equal(handlerRan, true);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'journal_failed');
  assert.equal(result.uncertain, true, 'the external effect may have happened');
  assert.equal(result.transient, false);
  assert.ok(db.log.some((entry) => entry.text === 'ROLLBACK'), 'the transaction is rolled back');
  assert.ok(!db.log.some((entry) => entry.text === 'COMMIT'), 'nothing is committed');
});

test('R4: a handler that keeps its executor after the attempt returns cannot write outside the transaction', async () => {
  const db = fakeDb();
  let kept = null;
  const registry = setup(
    [
      {
        id: 'notes.save',
        risk: 'low',
        access: 'write',
        schema: { note: { type: 'string' } },
        handler: async (_params, context) => {
          kept = context.db;
          return { saved: true };
        },
      },
    ],
    { journal: { db } },
  );

  await registry.invoke(writeCall('notes.save'));
  await assert.rejects(kept.query('UPDATE notes SET body = $1', ['late']), /transaction is closed/);
  assert.ok(!db.log.some((entry) => entry.text.startsWith('UPDATE')), 'the late statement never reaches the connection');
});

test('R4: without a journal, a write issues no SQL and the handler gets no executor', async () => {
  let sawDb = 'unset';
  const registry = setup([
    {
      id: 'notes.save',
      risk: 'low',
      access: 'write',
      schema: { note: { type: 'string' } },
      handler: async (_params, context) => {
        sawDb = context.db;
        return { saved: true };
      },
    },
  ]);

  const result = await registry.invoke(writeCall('notes.save'));

  assert.equal(result.outcome, 'executed');
  assert.equal(sawDb, undefined);
});

// ---- R5: provider idempotency key -------------------------------------------------------------------------------

test('R5: the handler receives the provider key, which differs from the Desk intent key and is the same on every retry', async () => {
  const received = [];
  const registry = setup(
    [
      {
        id: 'notes.write',
        risk: 'low',
        access: 'write',
        schema: { note: { type: 'string' } },
        handler: async (_params, context) => {
          received.push(context.idempotencyKey);
          if (received.length === 1) await new Promise((resolve) => setTimeout(resolve, 200));
          return { done: true };
        },
      },
    ],
    { idempotencyStore: createIdempotencyStore() },
  );

  const result = await registry.invoke(writeCall('notes.write'));

  assert.equal(result.outcome, 'executed');
  assert.equal(received.length, 2, 'one timeout, then one retry');
  assert.equal(received[1], received[0], 'the retry reuses the provider key');
  const expected = providerIdempotencyKey({ companyId: CO, runId: 'run-1', callIndex: 0, toolId: 'notes.write', params: { note: 'x' } });
  const intent = idempotencyKey({ companyId: CO, runId: 'run-1', callIndex: 0, tool: 'notes.write', params: { note: 'x' } });
  assert.equal(received[0], expected, 'the provider key comes from providerIdempotencyKey');
  assert.notEqual(received[0], intent, 'the provider never sees the Desk intent key');
});

test('R5: an unkeyed write (no idempotency store) gets no provider key', async () => {
  let key = 'unset';
  const registry = setup([
    {
      id: 'notes.write',
      risk: 'low',
      access: 'write',
      schema: { note: { type: 'string' } },
      handler: async (_params, context) => {
        key = context.idempotencyKey;
        return { done: true };
      },
    },
  ]);

  await registry.invoke(writeCall('notes.write'));

  assert.equal(key, undefined);
});

// ---- R6: unknown outcomes are read back first ---------------------------------------------------------------------

/** A write whose handler outlives the timeout, so the result is uncertain. Its check reads a record value. */
function uncertainWrite(readBack, { withCheck = true } = {}) {
  const calls = { n: 0 };
  const definition = {
    id: 'bookings.move',
    risk: 'low',
    access: 'write',
    schema: { note: { type: 'string' } },
    handler: async () => {
      calls.n += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { moved: true };
    },
  };
  if (withCheck) {
    definition.outcomeCheck = {
      plan: () => ({ id: 'b1', before: 'old', after: 'new' }),
      readBack,
    };
  }
  return { definition, calls };
}

test('R6: a read-back that shows the change settles the uncertain write as applied, with no owner notice', async () => {
  const notices = [];
  const { definition, calls } = uncertainWrite(async () => 'new');
  const registry = setup([definition], { notifyOwner: (notice) => notices.push(notice) });

  const result = await registry.invoke(writeCall('bookings.move'));

  assert.equal(calls.n, 1, 'an unkeyed write still runs once');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.uncertain, true);
  assert.equal(result.transient, false);
  assert.equal(result.resolution, 'applied');
  assert.equal(notices.length, 0);
});

test('R6: a read-back that shows the prior state settles the uncertain write as not applied', async () => {
  const notices = [];
  const { definition } = uncertainWrite(async () => 'old');
  const registry = setup([definition], { notifyOwner: (notice) => notices.push(notice) });

  const result = await registry.invoke(writeCall('bookings.move'));

  assert.equal(result.resolution, 'not_applied');
  assert.equal(notices.length, 0);
});

test('R6: a read-back that shows neither state leaves the owner to decide, and the owner is notified', async () => {
  const notices = [];
  const { definition } = uncertainWrite(async () => 'something else');
  const registry = setup([definition], { notifyOwner: (notice) => notices.push(notice) });

  const result = await registry.invoke(writeCall('bookings.move'));

  assert.equal(result.resolution, 'owner_decides');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].toolId, 'bookings.move');
  assert.equal(notices[0].runId, 'run-1');
  assert.equal(notices[0].change.id, 'b1');
});

test('R6: a read-back that fails leaves the owner to decide', async () => {
  const notices = [];
  const { definition } = uncertainWrite(async () => {
    throw new Error('read failed');
  });
  const registry = setup([definition], { notifyOwner: (notice) => notices.push(notice) });

  const result = await registry.invoke(writeCall('bookings.move'));

  assert.equal(result.resolution, 'owner_decides');
  assert.equal(notices.length, 1);
});

test('R6: an uncertain write with no outcome check goes straight to the owner, with no change attached', async () => {
  const notices = [];
  const { definition } = uncertainWrite(null, { withCheck: false });
  const registry = setup([definition], { notifyOwner: (notice) => notices.push(notice) });

  const result = await registry.invoke(writeCall('bookings.move'));

  assert.equal(result.resolution, 'owner_decides');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].change, null);
});

test('R6: a failed owner notice does not hide the uncertain outcome', async () => {
  const { definition } = uncertainWrite(async () => 'something else');
  const registry = setup([definition], {
    notifyOwner: () => {
      throw new Error('inbox down');
    },
  });

  const result = await registry.invoke(writeCall('bookings.move'));

  assert.equal(result.outcome, 'failed');
  assert.equal(result.uncertain, true);
  assert.equal(result.resolution, 'owner_decides');
});

// ---- R8: predictive writes are staged, not run -------------------------------------------------------------------

function predictiveWriteTool(handlerCalls) {
  return {
    id: 'jobs.reschedule',
    risk: 'low',
    access: 'write',
    schema: { note: { type: 'string' } },
    stage: () => ({
      category: 'other',
      change: {
        runId: 'unused',
        targetTable: 'jobs',
        targetId: 'j1',
        operation: 'update',
        before: { status: 'booked' },
        after: { status: 'moved' },
        baseVersion: 3,
      },
    }),
    handler: async () => {
      handlerCalls.n += 1;
      return { done: true };
    },
  };
}

function fakeShadow() {
  const requests = [];
  return {
    requests,
    request: async (input) => {
      requests.push(input);
      return { ok: true, change: { id: 'chg_1', status: 'pending' } };
    },
  };
}

test('R8: a predictive direct write is refused, staged as a pending change, and its handler does not run', async () => {
  const handlerCalls = { n: 0 };
  const shadow = fakeShadow();
  const registry = setup([predictiveWriteTool(handlerCalls)], { predictiveShadow: shadow });

  const result = await registry.invoke(writeCall('jobs.reschedule', predictiveAgent));

  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'direct_write_refused');
  assert.equal(result.stagedChangeId, 'chg_1');
  assert.equal(handlerCalls.n, 0, 'nothing ran');
  assert.equal(shadow.requests.length, 1);
  assert.equal(shadow.requests[0].runId, 'run-1', 'the staged change carries the run of the call');
  assert.equal(shadow.requests[0].requestedBy.agentId, 'pa-1');
  assert.equal(shadow.requests[0].requestedBy.roleId, 'forecaster');
});

test('R8: a predictive direct write with no shadow service is refused and nothing is staged', async () => {
  const handlerCalls = { n: 0 };
  const registry = setup([predictiveWriteTool(handlerCalls)]);

  const result = await registry.invoke(writeCall('jobs.reschedule', predictiveAgent));

  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'direct_write_refused');
  assert.equal(result.stagedChangeId, undefined);
  assert.equal(handlerCalls.n, 0);
});

test('R8: a predictive write for a tool that cannot be staged is refused, not run', async () => {
  const handlerCalls = { n: 0 };
  const shadow = fakeShadow();
  const tool = predictiveWriteTool(handlerCalls);
  delete tool.stage;
  const registry = setup([tool], { predictiveShadow: shadow });

  const result = await registry.invoke(writeCall('jobs.reschedule', predictiveAgent));

  assert.equal(result.reason, 'direct_write_refused');
  assert.equal(handlerCalls.n, 0);
  assert.equal(shadow.requests.length, 0);
});

test('R8: predictive reads still run directly', async () => {
  const handlerCalls = { n: 0 };
  const registry = setup([
    {
      id: 'jobs.list',
      risk: 'low',
      access: 'read',
      schema: { note: { type: 'string' } },
      handler: async () => {
        handlerCalls.n += 1;
        return { jobs: [] };
      },
    },
  ]);

  const result = await registry.invoke(writeCall('jobs.list', predictiveAgent));

  assert.equal(result.outcome, 'executed');
  assert.equal(handlerCalls.n, 1);
});
