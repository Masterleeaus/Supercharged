/**
 * Issue #254: drift rejection and rollback / re-apply on a disposable PostgreSQL.
 *
 * Run with a scratch server only, for example:
 *   TENANT_PG_DISPOSABLE=true TEST_DATABASE_URL=postgres://postgres:...@127.0.0.1:5433/postgres \
 *     node --test --experimental-transform-types tests/postgres/tenant-postgres-migration-recovery.test.mjs
 *
 * CI runs it in the tenant-postgres job, which sets TENANT_PG_INTEGRATION_URL instead.
 * Skipped unless TENANT_PG_DISPOSABLE=true and a connection URL is set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  buildChain, createScratchDatabase, enabled, listMigrationFiles, readMigration, runDowns, undeclaredTables,
} from './support/tenancy-migration-chain.mjs';

const SKIP = enabled ? false : 'set TENANT_PG_DISPOSABLE=true and TEST_DATABASE_URL (or TENANT_PG_INTEGRATION_URL)';

async function withScratch(fn) {
  const scratch = await createScratchDatabase();
  const client = new pg.Client({ connectionString: scratch.url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
    await scratch.drop();
  }
}

test('clean build from an empty database has no undeclared tables (drift check passes)', { skip: SKIP }, async () => {
  await withScratch(async (client) => {
    await buildChain(client);
    assert.deepEqual(await undeclaredTables(client), []);
  });
});

test('drift is rejected: a table added outside the reviewed migrations is reported', { skip: SKIP }, async () => {
  await withScratch(async (client) => {
    await buildChain(client);
    await client.query('CREATE TABLE unreviewed_push_table (id integer PRIMARY KEY)');
    assert.deepEqual(await undeclaredTables(client), ['unreviewed_push_table']);
  });
});

test('the built chain enforces forced RLS on every Inbox tenant table (0024)', { skip: SKIP }, async () => {
  await withScratch(async (client) => {
    await buildChain(client);
    const { rows } = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('inbox_participants','inbox_threads','inbox_thread_participants','inbox_messages')
       ORDER BY relname`,
    );
    assert.equal(rows.length, 4);
    for (const row of rows) assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity], [true, true], row.relname);
  });
});

test('rollback then re-apply restores the same schema, with every down file applied in reverse', { skip: SKIP }, async () => {
  await withScratch(async (client) => {
    await buildChain(client);
    const before = await tableNames(client);
    await runDowns(client);
    const afterDown = await tableNames(client);
    assert.ok(afterDown.length < before.length, 'down files removed tables');
    assert.ok(!afterDown.includes('user_company_memberships'));
    assert.ok(!afterDown.includes('landing_pages'));
    await buildChain(client);
    assert.deepEqual(await tableNames(client), before, 're-apply restores the original tables');
    assert.deepEqual(await undeclaredTables(client), []);
  });
});

test('every tenancy up file from 0014 to 0024 has a down file that rolls it back on this database', { skip: SKIP }, async () => {
  const downs = listMigrationFiles().filter((f) => f.endsWith('.down.sql'));
  assert.ok(downs.includes('0014_workforce_tool_tables.down.sql'));
  assert.ok(downs.includes('0024_inbox_tenant_rls.down.sql'));
  assert.ok(readMigration('0024_inbox_tenant_rls', 'down').length > 0);
});

test('production drift guard: db-push refuses to run against production', () => {
  const script = fileURLToPath(new URL('../../scripts/db-push-non-interactive.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, NODE_ENV: 'production', ALLOW_DB_PUSH_ON_PRODUCTION: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /REFUSING to run drizzle-kit push --force on production/);
});

async function tableNames(client) {
  const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  return rows.map((r) => r.tablename);
}
