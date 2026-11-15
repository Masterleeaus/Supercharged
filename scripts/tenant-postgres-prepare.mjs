/**
 * CI-only PostgreSQL fixture for the tenant isolation tests.
 * Applies the promoted migrations 0010c (chatbot parent tables), 0014 (workforce tables),
 * 0015 (company quiet hours), 0016 (chatbot outbox, webhooks, reminder ledger) and 0017
 * (user company memberships) unchanged to a disposable database. A minimal users stub is created only
 * when the table is absent, because the base schema (0000) is not applied in this job. Never run against a persistent database. Production migrations
 * and the migration manifest are not modified.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const MIGRATIONS = [
  new URL('../migrations/0010c_chatbot.sql', import.meta.url),
  new URL('../migrations/0014_workforce_tool_tables.sql', import.meta.url),
  new URL('../migrations/0015_company_quiet_hours.sql', import.meta.url),
  new URL('../migrations/0016_chatbot_reminder_pipeline.sql', import.meta.url),
  new URL('../migrations/0017_user_company_memberships.sql', import.meta.url),
];

export async function prepareTenantPostgres(connectionString) {
  if (process.env.TENANT_PG_DISPOSABLE !== 'true') {
    throw new Error('Tenant PostgreSQL fixture requires TENANT_PG_DISPOSABLE=true');
  }
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('TENANT_PG_INTEGRATION_URL is required');
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
      // Test-only stub so the membership foreign key has a target. Not created when the real table exists.
      await client.query('CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY)');
      for (const file of MIGRATIONS) await client.query(readFileSync(file, 'utf8'));
      await client.query('GRANT USAGE ON SCHEMA public TO desk_app');
      await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON company_quiet_hours TO desk_app');
      await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON user_company_memberships TO desk_app');
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
  await prepareTenantPostgres(process.env.TENANT_PG_INTEGRATION_URL);
  console.log('Disposable tenant PostgreSQL schema prepared (0010c chatbot, 0014 workforce, 0015 quiet hours, 0016 chatbot pipeline, 0017 memberships). Production migrations unchanged.');
}
