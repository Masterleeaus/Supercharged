/**
 * Tests for server/workforce/runtime/action-journal-pg.ts. A fake single-connection SqlExecutor records every SQL call
 * in order and keeps a committed/rolled-back store, so the tests can check what survives a failure.
 * Run: node --test --experimental-transform-types tests/workforce/action-journal-pg.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runActionWithJournal } from '../../server/workforce/runtime/action-journal-pg.ts';

/**
 * Fake executor. Writes made by the action and journal INSERTs are staged, then made visible on COMMIT and
 * discarded on ROLLBACK. `failOn` makes a statement containing that text throw.
 */
function fakeDb({ failOn = null } = {}) {
  const log = [];
  let staged = [];
  const committed = { actions: [], journal: [] };
  const db = {
    log,
    committed,
    async query(text, values = []) {
      log.push({ text, values });
      if (failOn && text.includes(failOn)) throw new Error(`failed: ${failOn}`);
      if (text === 'BEGIN') {
        staged = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'COMMIT') {
        for (const entry of staged) committed[entry.table].push(entry.row);
        staged = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        staged = [];
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('INSERT INTO action_journal')) {
        staged.push({ table: 'journal', row: values });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO desk_jobs')) {
        staged.push({ table: 'actions', row: values });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return db;
}

const journalRow = {
  id: 'j-1',
  company_id: 'co-a',
  run_id: 'run-1',
  tool_id: 'tool-job-update',
  payload: { status: 'scheduled' },
};

const action = (db) => db.query('INSERT INTO desk_jobs (id) VALUES ($1)', ['job-7']).then(() => 'done');

test('action and journal row are committed together, in order, on one connection', async () => {
  const db = fakeDb();
  const result = await runActionWithJournal(db, { journalRow, action: (d) => action(d) });

  assert.equal(result, 'done');
  assert.deepEqual(
    db.log.map((entry) => entry.text.split(' (')[0]),
    ['BEGIN', 'INSERT INTO desk_jobs', 'INSERT INTO action_journal', 'COMMIT'],
  );
  assert.equal(db.committed.actions.length, 1);
  assert.equal(db.committed.journal.length, 1);
  assert.deepEqual(db.committed.journal[0][0], 'j-1');
  assert.equal(db.committed.journal[0][4], JSON.stringify({ status: 'scheduled' }));
});

test('the journal INSERT uses the column names from journalRow with $n placeholders', async () => {
  const db = fakeDb();
  await runActionWithJournal(db, { journalRow, action: (d) => action(d) });
  const insert = db.log.find((entry) => entry.text.startsWith('INSERT INTO action_journal'));
  assert.equal(
    insert.text,
    'INSERT INTO action_journal (id, company_id, run_id, tool_id, payload) VALUES ($1, $2, $3, $4, $5)',
  );
});

test('a failing action rolls back and leaves no journal row', async () => {
  const db = fakeDb();
  await assert.rejects(
    runActionWithJournal(db, {
      journalRow,
      action: async (d) => {
        await d.query('INSERT INTO desk_jobs (id) VALUES ($1)', ['job-7']);
        throw new Error('action exploded');
      },
    }),
    /action exploded/,
  );

  assert.equal(db.log.at(-1).text, 'ROLLBACK');
  assert.equal(db.log.some((entry) => entry.text === 'COMMIT'), false);
  assert.equal(db.committed.journal.length, 0);
  assert.equal(db.committed.actions.length, 0);
});

test('a failing journal INSERT rolls back the action too', async () => {
  const db = fakeDb({ failOn: 'INSERT INTO action_journal' });
  await assert.rejects(runActionWithJournal(db, { journalRow, action: (d) => action(d) }), /failed: INSERT INTO action_journal/);

  assert.equal(db.log.at(-1).text, 'ROLLBACK');
  assert.equal(db.committed.actions.length, 0);
  assert.equal(db.committed.journal.length, 0);
});

test('the original error is reported when ROLLBACK also fails', async () => {
  const db = fakeDb();
  const original = fakeDb();
  const failingRollback = {
    async query(text, values) {
      if (text === 'ROLLBACK') throw new Error('rollback failed');
      return original.query(text, values);
    },
  };
  await assert.rejects(
    runActionWithJournal(failingRollback, {
      journalRow,
      action: async () => {
        throw new Error('action exploded');
      },
    }),
    /action exploded/,
  );
  assert.equal(db.committed.journal.length, 0);
});

test('an empty or unsafe journalRow is refused before BEGIN', async () => {
  const db = fakeDb();
  await assert.rejects(runActionWithJournal(db, { journalRow: {}, action }), /journalRow is empty/);
  await assert.rejects(
    runActionWithJournal(db, { journalRow: { 'id; DROP TABLE x': 1 }, action }),
    /invalid action journal column/,
  );
  assert.equal(db.log.length, 0);
});
