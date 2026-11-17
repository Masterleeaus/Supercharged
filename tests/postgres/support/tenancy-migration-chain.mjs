/**
 * Shared helpers for the disposable-database migration chain (issue #254).
 *
 * Connection: TEST_DATABASE_URL, falling back to TENANT_PG_INTEGRATION_URL (the CI tenant job).
 * Every test here also needs TENANT_PG_DISPOSABLE=true, so a developer cannot point it at a real
 * database by accident. The helpers create a fresh, uniquely named database and drop it at the end.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';

export const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

// Chain used by the recovery test: the tenancy migrations this repo can apply to a stub schema.
// 0018 is not in the chain: it needs a full users table (is_active, is_deleted, deleted_at, role).
export const CHAIN = [
  '0010a_inbox',
  '0010c_chatbot',
  '0014_workforce_tool_tables',
  '0015_company_quiet_hours',
  '0016_chatbot_reminder_pipeline',
  '0017_user_company_memberships',
  '0019_central_sso_pending_logins',
  '0020_scheduled_booking_mirror',
  '0023_marketing_tables_tenant_rls',
  '0024_inbox_tenant_rls',
];

export const enabled = process.env.TENANT_PG_DISPOSABLE === 'true' && Boolean(connectionUrl());

export function connectionUrl() {
  return process.env.TEST_DATABASE_URL || process.env.TENANT_PG_INTEGRATION_URL || '';
}

export function readMigration(name, kind = 'up') {
  const file = kind === 'down' ? `${name}.down.sql` : `${name}.sql`;
  return readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
}

/** Creates a fresh database on the same server and returns { url, drop }. */
export async function createScratchDatabase() {
  const base = new URL(connectionUrl());
  const name = `tenancy_mig_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const scratch = new URL(base.toString());
  scratch.pathname = `/${name}`;
  const url = scratch.toString();
  return {
    url,
    drop: async () => {
      const c = new pg.Client({ connectionString: base.toString() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export async function ensureRestrictedRole(client) {
  await client.query(`DO $role$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
      CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END $role$;`);
}

/** Tables created by the chain's up files, read from their CREATE TABLE statements. */
export function declaredTables() {
  const names = new Set(['users']); // test-only stub, see buildChain
  for (const name of CHAIN) {
    for (const m of readMigration(name).matchAll(/CREATE TABLE IF NOT EXISTS\s+(?:public\.)?(\w+)/g)) names.add(m[1]);
  }
  return names;
}

/** Drift check: every public table must be declared by a reviewed migration. Returns the undeclared names. */
export async function undeclaredTables(client) {
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const declared = declaredTables();
  return rows.map((r) => r.tablename).filter((t) => !declared.has(t));
}

export async function buildChain(client) {
  await ensureRestrictedRole(client);
  await client.query('CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY)');
  for (const name of CHAIN) await client.query(readMigration(name));
  await client.query('GRANT USAGE ON SCHEMA public TO desk_app');
}

// Base chain files 0010a and 0010c are not tenancy migrations and have no down file; they stay in place.
export async function runDowns(client) {
  for (const name of [...CHAIN].reverse()) {
    if (existsSync(new URL(`${name}.down.sql`, MIGRATIONS_DIR))) await client.query(readMigration(name, 'down'));
  }
}

export function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
}
