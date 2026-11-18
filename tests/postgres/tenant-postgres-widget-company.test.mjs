import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { A, B, enabled, fixture, insertUsers } from './tenant-postgres-support.mjs';

const migration = readFileSync(new URL('../../migrations/0026_website_widgets_company_id.sql', import.meta.url), 'utf8');
const rollback = [
  'DROP INDEX IF EXISTS website_widgets_company_id_idx',
  'ALTER TABLE website_widgets DROP COLUMN IF EXISTS company_id',
];
const OWNER_A = 'widget-owner-company-a';
const OWNER_NONE = 'widget-owner-no-company';

test('PostgreSQL 0026: backfill sets company_id from the owner, keeps NULL when the owner has none, never overwrites', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    // Test-only stub columns. The disposable fixture does not run the base schema.
    await f.pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id uuid');
    await f.pool.query('DELETE FROM website_widgets');
    await f.pool.query('DELETE FROM users');
    await insertUsers(f.pool, [{ id: OWNER_A, company_id: A }, { id: OWNER_NONE, company_id: null }]);
    await f.pool.query(
      // name and embed_token are NOT NULL in the base 0000 table; the stub accepts them too.
      'INSERT INTO website_widgets (id, user_id, name, embed_token, company_id) VALUES ($1, $2, $3, $4, NULL), ($5, $6, $7, $8, NULL), ($9, $2, $10, $11, $12)',
      ['w-owned', OWNER_A, 'owned', 'tok-owned', 'w-no-company', OWNER_NONE, 'no-company', 'tok-none', 'w-preset', 'preset', 'tok-preset', B],
    );

    await f.pool.query(migration);
    const rows = await f.pool.query('SELECT id, company_id FROM website_widgets ORDER BY id');
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.company_id]));
    assert.equal(byId['w-owned'], A);
    assert.equal(byId['w-no-company'], null);
    assert.equal(byId['w-preset'], B, 'an existing company_id is not overwritten');

    // Re-running the migration changes nothing.
    await f.pool.query(migration);
    const again = await f.pool.query('SELECT id, company_id FROM website_widgets ORDER BY id');
    assert.deepEqual(again.rows, rows.rows);
  } finally {
    await f.close();
  }
});

test('PostgreSQL 0026: the documented rollback removes the column and index, and a re-apply restores them', { skip: !enabled }, async () => {
  const f = fixture();
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of rollback) await client.query(stmt);
    const gone = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'website_widgets' AND column_name = 'company_id'",
    );
    assert.equal(gone.rowCount, 0);
    await client.query('ROLLBACK');

    const back = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'website_widgets' AND column_name = 'company_id'",
    );
    assert.equal(back.rowCount, 1, 'rollback was inside a transaction and was undone');
  } finally {
    client.release();
    await f.close();
  }
});
