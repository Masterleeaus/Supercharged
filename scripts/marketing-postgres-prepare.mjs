/**
 * CI-only PostgreSQL fixture. Never run against a persistent database.
 * Explicitly requires a disposable-db opt-in, then applies the REVIEW CANDIDATE
 * without modifying the production migration manifest.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CANDIDATE, validateMarketingMigration } from './check-marketing-migration.mjs';

export async function prepareMarketingIntegrationDatabase(connectionString) {
  if (process.env.MARKETING_PG_DISPOSABLE !== 'true') {
    throw new Error('Marketing migration fixture requires MARKETING_PG_DISPOSABLE=true');
  }
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('MARKETING_PG_INTEGRATION_URL is required');
  }
  const sql = readFileSync(CANDIDATE, 'utf8');
  const problems = validateMarketingMigration(sql);
  if (problems.length) throw new Error('Marketing migration preflight failed: ' + problems.join('; '));
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // This setup is for throwaway CI PostgreSQL only, not application startup.
    await client.query(`DO $role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
        CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $role$;`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
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
  await prepareMarketingIntegrationDatabase(process.env.MARKETING_PG_INTEGRATION_URL);
  console.log('Disposable Marketing PostgreSQL candidate prepared; production migrations unchanged.');
}
