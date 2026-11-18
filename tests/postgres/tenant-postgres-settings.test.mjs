import test from 'node:test';
import assert from 'node:assert/strict';
import { A, B, enabled, fixture } from './tenant-postgres-support.mjs';

test('PostgreSQL settings: company quiet hours are isolated per company', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    assert.equal((await f.settings.setQuietHours(A, { startHour: 21, endHour: 7, timezone: 'Australia/Sydney' })).ok, true);
    assert.equal((await f.settings.setQuietHours(B, { startHour: 22, endHour: 6, timezone: 'Europe/London' })).ok, true);
    const readA = await f.settings.getQuietHours(A);
    const readB = await f.settings.getQuietHours(B);
    assert.equal(readA.settings.companyId, A);
    assert.equal(readA.settings.timezone, 'Australia/Sydney');
    assert.equal(readB.settings.companyId, B);
    assert.equal(readB.settings.timezone, 'Europe/London');
    // Company A clearing its own settings must not remove company B's row.
    assert.deepEqual(await f.settings.clearQuietHours(A), { ok: true, cleared: true });
    assert.equal((await f.settings.getQuietHours(A)).settings, null);
    assert.equal((await f.settings.getQuietHours(B)).settings.timezone, 'Europe/London');
  } finally {
    await f.close();
  }
});

// Issue #127 batch 1: names company_quiet_hours directly. Checks the tenant key on the real table.
// Row-level security is not part of migration 0015, so this checks the key and the per-company row shape,
// not database-enforced isolation. Behaviour per company is covered by the test above.
test('PostgreSQL schema: company_quiet_hours is keyed by a NOT NULL company_id, one row per company', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    const col = await f.pool.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'company_quiet_hours' AND column_name = 'company_id'`,
    );
    assert.equal(col.rows.length, 1);
    assert.equal(col.rows[0].is_nullable, 'NO');
    assert.equal(col.rows[0].data_type, 'uuid');
    const pk = await f.pool.query(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'company_quiet_hours'::regclass AND i.indisprimary`,
    );
    assert.deepEqual(pk.rows.map((r) => r.attname), ['company_id']);
    await f.settings.setQuietHours(A, { startHour: 21, endHour: 7, timezone: 'Australia/Sydney' });
    await f.settings.setQuietHours(B, { startHour: 22, endHour: 6, timezone: 'Europe/London' });
    const rows = await f.pool.query(`SELECT company_id::text AS company_id FROM company_quiet_hours WHERE company_id IN ($1, $2) ORDER BY company_id`, [A, B]);
    assert.deepEqual(rows.rows.map((r) => r.company_id), [A, B].sort());
    await f.pool.query(`DELETE FROM company_quiet_hours WHERE company_id IN ($1, $2)`, [A, B]);
  } finally {
    await f.close();
  }
});
