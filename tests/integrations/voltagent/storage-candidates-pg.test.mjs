/**
 * Issue #386: runtime proof for the VoltAgent storage candidate migrations.
 *
 * The string checks in storage-candidates.test.mjs run everywhere. This file applies the
 * candidate SQL to a disposable PostgreSQL and checks tenant isolation and constraints as a
 * restricted role (NOBYPASSRLS, not the table owner), which is how the app will connect.
 *
 * Gated like the other disposable-database tests (tests/postgres/support):
 *   TENANT_PG_DISPOSABLE=true TEST_DATABASE_URL=postgres://... \
 *     node --test --experimental-transform-types tests/integrations/voltagent/storage-candidates-pg.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { createScratchDatabase, enabled } from '../../postgres/support/tenancy-migration-chain.mjs';

const SKIP = enabled ? false : 'set TENANT_PG_DISPOSABLE=true and TEST_DATABASE_URL (or TENANT_PG_INTEGRATION_URL)';
const CANDIDATES = new URL('../../../migrations/candidates/', import.meta.url);
const sql = readdirSync(CANDIDATES)
  .filter((f) => f.startsWith('voltagent_'))
  .sort()
  .map((f) => readFileSync(new URL(f, CANDIDATES), 'utf8'))
  .join('\n');

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const APP_ROLE = `voltagent_app_${process.pid}`;

async function withDb(fn) {
  const scratch = await createScratchDatabase();
  const owner = new pg.Client({ connectionString: scratch.url });
  await owner.connect();
  try {
    await owner.query(sql);
    await owner.query(`CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA voltagent TO ${APP_ROLE}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA voltagent TO ${APP_ROLE}`);
    await fn(owner);
  } finally {
    await owner.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    await owner.end();
    await scratch.drop();
  }
}

/** Runs fn inside a transaction as the restricted role, scoped to one company. */
async function asTenant(client, companyId, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    if (companyId) await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function insertRun(client, companyId, agent = 'desk') {
  const { rows } = await client.query(
    `INSERT INTO voltagent.agent_runs (company_id, agent_name, session_id) VALUES ($1, $2, 's1') RETURNING id`,
    [companyId, agent],
  );
  return rows[0].id;
}

async function expectRejected(promise, pattern) {
  await assert.rejects(promise, pattern);
}

test('candidate SQL applies to a clean database and creates the three voltagent tables', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    const { rows } = await owner.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'voltagent' ORDER BY tablename`,
    );
    assert.deepEqual(rows.map((r) => r.tablename), ['agent_runs', 'eval_scores', 'tool_calls']);
  });
});

test('the restricted app role cannot bypass row-level security', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    const { rows } = await owner.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    assert.equal(rows[0].rolbypassrls, false);
    assert.equal(rows[0].rolsuper, false);
  });
});

test('negative: a tenant sees no rows that belong to another company', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    await asTenant(owner, COMPANY_A, (c) => insertRun(c, COMPANY_A, 'a-agent'));
    const seenByB = await asTenant(owner, COMPANY_B, async (c) => {
      const { rows } = await c.query(`SELECT agent_name FROM voltagent.agent_runs`);
      return rows;
    });
    assert.deepEqual(seenByB, []);
    const seenByA = await asTenant(owner, COMPANY_A, async (c) => {
      const { rows } = await c.query(`SELECT agent_name FROM voltagent.agent_runs`);
      return rows.map((r) => r.agent_name);
    });
    assert.deepEqual(seenByA, ['a-agent']);
  });
});

test('negative: with no company context, reads return nothing and writes are refused', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    await asTenant(owner, COMPANY_A, (c) => insertRun(c, COMPANY_A));
    const rows = await asTenant(owner, null, async (c) => (await c.query(`SELECT id FROM voltagent.agent_runs`)).rows);
    assert.deepEqual(rows, []);
    await expectRejected(
      asTenant(owner, null, (c) => insertRun(c, COMPANY_A)),
      /row-level security/i,
    );
  });
});

test('negative: a tenant cannot write a row tagged with another company', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    await expectRejected(
      asTenant(owner, COMPANY_B, (c) => insertRun(c, COMPANY_A)),
      /row-level security/i,
    );
  });
});

test('integration: tool calls and eval scores are tenant-scoped and tied to their run', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    const runId = await asTenant(owner, COMPANY_A, (c) => insertRun(c, COMPANY_A));
    await asTenant(owner, COMPANY_A, (c) =>
      c.query(
        `INSERT INTO voltagent.tool_calls (company_id, run_id, tool_name, status, duration_ms)
         VALUES ($1, $2, 'clients.list', 'success', 12)`,
        [COMPANY_A, runId],
      ),
    );
    await asTenant(owner, COMPANY_A, (c) =>
      c.query(
        `INSERT INTO voltagent.eval_scores (company_id, run_id, agent_name, session_id, task_completion_rate,
           hallucination_flag, tool_accuracy, response_latency_ms, composite_score)
         VALUES ($1, $2, 'desk', 's1', 90, 0, 95, 300, 92)`,
        [COMPANY_A, runId],
      ),
    );
    const seenByB = await asTenant(owner, COMPANY_B, async (c) => (await c.query(`SELECT 1 FROM voltagent.tool_calls`)).rows.length);
    assert.equal(seenByB, 0);
    // Deleting the run cascades to tool calls; the eval score keeps its row with run_id nulled.
    await asTenant(owner, COMPANY_A, (c) => c.query(`DELETE FROM voltagent.agent_runs WHERE id = $1`, [runId]));
    const remaining = await asTenant(owner, COMPANY_A, async (c) => ({
      calls: (await c.query(`SELECT 1 FROM voltagent.tool_calls`)).rows.length,
      scores: (await c.query(`SELECT run_id FROM voltagent.eval_scores`)).rows,
    }));
    assert.equal(remaining.calls, 0);
    assert.deepEqual(remaining.scores, [{ run_id: null }]);
  });
});

test('negative: CHECK constraints refuse bad status, negative duration, reversed time and out-of-range scores', { skip: SKIP }, async () => {
  await withDb(async (owner) => {
    const runId = await asTenant(owner, COMPANY_A, (c) => insertRun(c, COMPANY_A));
    await expectRejected(
      asTenant(owner, COMPANY_A, (c) =>
        c.query(`UPDATE voltagent.agent_runs SET status = 'exploded' WHERE id = $1`, [runId])),
      /check constraint/i,
    );
    await expectRejected(
      asTenant(owner, COMPANY_A, (c) =>
        c.query(
          `INSERT INTO voltagent.tool_calls (company_id, run_id, tool_name, status, duration_ms)
           VALUES ($1, $2, 'x', 'success', -1)`,
          [COMPANY_A, runId],
        )),
      /check constraint/i,
    );
    await expectRejected(
      asTenant(owner, COMPANY_A, (c) =>
        c.query(
          `UPDATE voltagent.agent_runs SET ended_at = started_at - interval '1 second' WHERE id = $1`,
          [runId],
        )),
      /check constraint/i,
    );
    await expectRejected(
      asTenant(owner, COMPANY_A, (c) =>
        c.query(
          `INSERT INTO voltagent.eval_scores (company_id, agent_name, session_id, task_completion_rate,
             hallucination_flag, tool_accuracy, response_latency_ms, composite_score)
           VALUES ($1, 'desk', 's1', 101, 0, 95, 300, 92)`,
          [COMPANY_A],
        )),
      /check constraint/i,
    );
  });
});
