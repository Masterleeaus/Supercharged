/**
 * CI-only PostgreSQL fixture for the durable suppression tests.
 * Creates the restricted desk_app role (test-only; the app does not create roles), then applies
 * migration 0022 unchanged. Never run against a persistent database.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const MIGRATION = new URL('../migrations/0022_comms_suppressions.sql', import.meta.url);

export async function prepareSuppressionPostgres(connectionString) {
  if (process.env.SUPPRESSION_PG_DISPOSABLE !== 'true') {
    throw new Error('Suppression PostgreSQL fixture requires SUPPRESSION_PG_DISPOSABLE=true');
  }
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('SUPPRESSION_PG_INTEGRATION_URL is required');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DO $role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
        CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $role$;`);
    await client.query('GRANT USAGE ON SCHEMA public TO desk_app');
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(MIGRATION, 'utf8'));
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
  await prepareSuppressionPostgres(process.env.SUPPRESSION_PG_INTEGRATION_URL);
  console.log('Disposable suppression PostgreSQL schema prepared (migration 0022).');
}
