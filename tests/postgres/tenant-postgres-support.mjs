/** Real PostgreSQL fixture for CI-only tenant isolation tests (Settings quiet hours). */
import pg from 'pg';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const enabled = process.env.TENANT_PG_DISPOSABLE === 'true' && Boolean(process.env.TENANT_PG_INTEGRATION_URL);
/**
 * Insert test users. The CI stub users table has only `id`; a fresh base schema (0000) also
 * requires email, password and name. Fill those when the table has them, so the same test
 * passes on both. `company_id` is written only when a row supplies it.
 */
export async function insertUsers(pool, rows) {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users'
        AND column_name = ANY($1::text[])`,
    [['email', 'password', 'name']],
  );
  const names = ['id', ...cols.map(c => c.column_name)];
  const withCompany = rows.some(r => 'company_id' in r);
  if (withCompany) names.push('company_id');
  const values = [];
  const tuples = rows.map((row, i) => {
    const offset = i * names.length;
    for (const name of names) {
      if (name === 'id') values.push(row.id);
      else if (name === 'email') values.push(`${row.id}@test.invalid`);
      else if (name === 'company_id') values.push(row.company_id ?? null);
      else values.push(`test-${row.id}`);
    }
    return `(${names.map((_, j) => `$${offset + j + 1}`).join(', ')})`;
  });
  await pool.query(`INSERT INTO users (${names.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

export function fixture() {
  if (!enabled) throw new Error('Disposable tenant PostgreSQL fixture must be explicitly enabled');
  const pool = new pg.Pool({ connectionString: process.env.TENANT_PG_INTEGRATION_URL, max: 4 });
  return { pool, settings: createCompanySettingsStore({ pool }), close: () => pool.end() };
}
