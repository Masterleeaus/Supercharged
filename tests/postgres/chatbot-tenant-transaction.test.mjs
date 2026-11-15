// Real PostgreSQL: the company id set by withTenantTransaction is visible inside the transaction,
// never leaks to the next use of the same pooled connection, and is cleared on rollback.
// Runs only against a disposable database (TENANT_PG_DISPOSABLE=true and TENANT_PG_INTEGRATION_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { withTenantTransaction } from '../../server/infrastructure/database/tenant-transaction.ts';
import { A, B, enabled } from './tenant-postgres-support.mjs';

test('PostgreSQL chatbot tenant: the setting is visible inside the transaction only', { skip: !enabled }, async () => {
  // One connection, so every step below reuses the same pooled session.
  const pool = new pg.Pool({ connectionString: process.env.TENANT_PG_INTEGRATION_URL, max: 1 });
  const db = drizzle(pool);
  const readSetting = async (run) => {
    const result = await run.query("SELECT coalesce(current_setting('app.company_id', true), '') AS company");
    return result.rows[0].company;
  };
  try {
    const inside = await withTenantTransaction(db, A, async (tx) => {
      const rows = await tx.execute(sql`select coalesce(current_setting('app.company_id', true), '') as company`);
      return rows.rows[0].company;
    });
    assert.equal(inside, A, 'inside withTenantTransaction the company id is set');

    // The next request on the same connection must not inherit company A.
    const after = await pool.connect();
    try {
      assert.equal(await readSetting(after), '', 'after commit the setting is empty on the reused connection');
    } finally {
      after.release();
    }

    // A second company gets its own value, not the first one.
    const second = await withTenantTransaction(db, B, async (tx) => {
      const rows = await tx.execute(sql`select current_setting('app.company_id', true) as company`);
      return rows.rows[0].company;
    });
    assert.equal(second, B);

    // A failure inside the transaction rolls back and leaves no setting behind.
    await assert.rejects(
      () => withTenantTransaction(db, A, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    const afterError = await pool.connect();
    try {
      assert.equal(await readSetting(afterError), '', 'after rollback the setting is empty');
    } finally {
      afterError.release();
    }
  } finally {
    await pool.end();
  }
});
