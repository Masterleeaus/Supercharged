/**
 * CI-only PostgreSQL fixture for the Approvals tenant isolation tests.
 * Applies the approvals migrations 0010b (tables) and 0013 (revoked status) unchanged to a
 * disposable database, and creates the restricted desk_app role that withTenant() switches
 * into. Never run against a persistent database. Production migrations are not modified.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const MIGRATIONS = [
  new URL('../migrations/0010b_approvals.sql', import.meta.url),
  new URL('../migrations/0013_approvals_revoked_status.sql', import.meta.url),
];

export async function prepareApprovalsPostgres(connectionString) {
  if (process.env.APPROVALS_PG_DISPOSABLE !== 'true') {
    throw new Error('Approvals PostgreSQL fixture requires APPROVALS_PG_DISPOSABLE=true');
  }
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('APPROVALS_PG_INTEGRATION_URL is required');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Restricted role that withTenant() switches into. Test-only; the app does not create roles.
    await client.query(`DO $role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
        CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $role$;`);
    await client.query('BEGIN');
    try {
      for (const file of MIGRATIONS) await client.query(readFileSync(file, 'utf8'));
      await client.query('GRANT USAGE ON SCHEMA public TO desk_app');
      await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON approvals, approval_rules TO desk_app');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  await prepareApprovalsPostgres(process.env.APPROVALS_PG_INTEGRATION_URL);
  console.log('Disposable Approvals PostgreSQL schema prepared (0010b, 0013). Production migrations unchanged.');
}
