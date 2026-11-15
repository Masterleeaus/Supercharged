/**
 * Tenant isolation for the promoted Inbox RLS migration (migrations/0021_inbox_tenant_rls.sql).
 *
 * Runs against a fresh database created for this file and dropped afterwards. Requires a disposable
 * PostgreSQL server: INBOX_PG_DISPOSABLE=true and INBOX_PG_INTEGRATION_URL pointing at a role that can
 * CREATE DATABASE and CREATE ROLE. It never touches an existing database.
 *
 *   INBOX_PG_DISPOSABLE=true INBOX_PG_INTEGRATION_URL=postgres://... \
 *     node --test --experimental-transform-types tests/postgres/inbox-rls-migration.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { verifyInboxSchema } from '../../server/modules/inbox/schema-readiness.ts';

const enabled = process.env.INBOX_PG_DISPOSABLE === 'true' && Boolean(process.env.INBOX_PG_INTEGRATION_URL);
const migrationSql = (file) => readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
const A = randomUUID();
const B = randomUUID();

// Swaps the database segment of a postgres URL. Plain string work, because WHATWG URL rejects socket-style URLs with an empty host.
function withDatabase(raw, name) {
  const m = /^(postgres(?:ql)?:\/\/[^/?]*)(\/[^?]*)?(\?.*)?$/.exec(raw);
  if (!m) throw new Error('INBOX_PG_INTEGRATION_URL is not a postgres URL');
  return `${m[1]}/${name}${m[3] ?? ''}`;
}

async function withFreshDatabase(run) {
  const admin = new pg.Client({ connectionString: process.env.INBOX_PG_INTEGRATION_URL });
  await admin.connect();
  const name = `inbox_rls_${randomUUID().replace(/-/g, '')}`;
  let pool = null;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    pool = new pg.Pool({ connectionString: withDatabase(process.env.INBOX_PG_INTEGRATION_URL, name), max: 2 });
    // Idle clients can be terminated by the server during teardown; that is expected and must not fail the test.
    pool.on('error', () => {});
    // Same role as scripts/inbox-postgres-prepare.mjs. The migration guard requires it and does not create it.
    await admin.query(`DO $r$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $r$;`);
    // 0010a creates the Inbox tables; 0018 is the migration under test. Each runs in its own transaction, as the runner does.
    const migrator = await pool.connect();
    try {
      for (const file of ['0010a_inbox.sql', '0021_inbox_tenant_rls.sql']) {
        await migrator.query('BEGIN');
        await migrator.query(migrationSql(file));
        await migrator.query('COMMIT');
      }
    } finally {
      migrator.release();
    }
    await run(pool);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

// Acts as the restricted app role with a tenant set for one transaction only.
async function asTenant(pool, companyId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE "desk_app"');
    if (companyId) await c.query('SELECT set_config($1,$2,true)', ['app.company_id', companyId]);
    const out = await fn(c);
    await c.query('ROLLBACK');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

test('0018 applies to a fresh database and the startup readiness check passes', { skip: !enabled }, async () => {
  await withFreshDatabase(async (pool) => {
    const readiness = await verifyInboxSchema(pool);
    assert.deepEqual(readiness.issues, []);
    assert.equal(readiness.ready, true);
  });
});

test('tenant isolation: cross-company reads return no rows', { skip: !enabled }, async () => {
  await withFreshDatabase(async (pool) => {
    const threadA = randomUUID(), threadB = randomUUID();
    await pool.query('INSERT INTO inbox_threads(id,company_id,channel) VALUES($1,$2,$3),($4,$5,$3)', [threadA, A, 'email', threadB, B]);

    const seenByA = await asTenant(pool, A, c => c.query('SELECT id,company_id FROM inbox_threads').then(r => r.rows));
    assert.deepEqual(seenByA.map(r => r.id), [threadA]);

    const bLookup = await asTenant(pool, A, c => c.query('SELECT id FROM inbox_threads WHERE id=$1', [threadB]).then(r => r.rows));
    assert.deepEqual(bLookup, []);

    const noContext = await asTenant(pool, null, c => c.query('SELECT id FROM inbox_threads').then(r => r.rows));
    assert.deepEqual(noContext, []);
  });
});

test('tenant isolation: cross-company writes are rejected or affect no rows', { skip: !enabled }, async () => {
  await withFreshDatabase(async (pool) => {
    const threadB = randomUUID();
    await pool.query('INSERT INTO inbox_threads(id,company_id,channel) VALUES($1,$2,$3)', [threadB, B, 'email']);

    // Insert claiming company B while the session is company A: WITH CHECK rejects it.
    await assert.rejects(
      asTenant(pool, A, c => c.query('INSERT INTO inbox_threads(id,company_id,channel) VALUES($1,$2,$3)', [randomUUID(), B, 'email'])),
      /row-level security/i,
    );

    // Update and delete of company B's row under company A: USING hides the row, so nothing changes.
    const updated = await asTenant(pool, A, c => c.query("UPDATE inbox_threads SET status='closed' WHERE id=$1", [threadB]));
    assert.equal(updated.rowCount, 0);
    const deleted = await asTenant(pool, A, c => c.query('DELETE FROM inbox_threads WHERE id=$1', [threadB]));
    assert.equal(deleted.rowCount, 0);

    // The owner sees the row unchanged.
    const { rows } = await pool.query('SELECT status FROM inbox_threads WHERE id=$1', [threadB]);
    assert.deepEqual(rows, [{ status: 'open' }]);
  });
});
