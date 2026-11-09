/**
 * Safe incremental database migration runner.
 *
 * Applies migrations in order:
 *   - 0001_add_missing_columns.sql   — ADD COLUMN IF NOT EXISTS for missing agent/call columns
 *   - 0002_add_google_sheets_credentials.sql — CREATE TABLE IF NOT EXISTS for Google Sheets OAuth
 *
 * Usage:  node scripts/run-safe-migration.mjs
 *
 * Requirements:
 *   - DATABASE_URL environment variable must be set (or a .env file in the
 *     project root with DATABASE_URL=...)
 *   - The target database must already have the base schema applied
 *     (either via `npm run db:push` on a fresh install, or via the
 *     migrations/0000_damp_spectrum.sql file)
 *
 * All migrations are idempotent (IF NOT EXISTS) — safe to re-run.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Load .env if present (before importing pg so DATABASE_URL is populated)
const envPath = resolve(rootDir, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('❌ DATABASE_URL environment variable is not set.');
  console.error('   Set it in your environment or in a .env file at the project root.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const { Pool } = pg;

// Each entry names a file in migrations/ and whether it is required.
//   required: true  - a missing file exits 1 before any database work.
//   required: false - a missing file prints a loud warning and is skipped.
//
// 008 and 009 are REQUIRED. They create the Custom Voice Engine (ve_*) tables and the
// leads / ve_sessions / ve_voice_agents columns those tables use. Both files are committed.
const MIGRATIONS = [
  { file: '0001_add_missing_columns.sql', required: true },
  { file: '0002_add_google_sheets_credentials.sql', required: true },
  { file: '0003_campaign_contact_retry.sql', required: true },
  { file: '0004_add_missing_tables.sql', required: true },
  { file: '0005_add_missing_agent_messaging_columns.sql', required: true },
  { file: '0006_add_default_campaign_type.sql', required: true },
  { file: '0007_add_external_fonoster_phone_id.sql', required: true },
  { file: '008_add_ve_session_id_and_voice_engine_tables.sql', required: true },
  { file: '009_fix_ve_session_id_and_all_missing_columns.sql', required: true },
  { file: '0010_add_yookassa_columns.sql', required: true },
  { file: '0010a_inbox.sql', required: true },
  { file: '0011_inbox_channels_and_providers.sql', required: true },
  { file: '0010b_approvals.sql', required: true },
  { file: '0013_approvals_revoked_status.sql', required: true },
  { file: '0010c_chatbot.sql', required: true },
  { file: '0014_workforce_tool_tables.sql', required: true },
  { file: '0015_company_quiet_hours.sql', required: true },
  { file: '0016_company_memberships.sql', required: true },
];

const migrationPath = (file) => resolve(rootDir, 'migrations', file);

// Check every entry before touching the database. A missing required file is fatal.
const missingRequired = MIGRATIONS.filter((m) => m.required && !existsSync(migrationPath(m.file)));
const missingOptional = MIGRATIONS.filter((m) => !m.required && !existsSync(migrationPath(m.file)));

if (missingOptional.length > 0) {
  const names = missingOptional.map((m) => m.file).join(', ');
  console.warn('');
  console.warn('!!! WARNING: OPTIONAL MIGRATION FILES ARE MISSING FROM THIS REPOSITORY !!!');
  console.warn(`!!! ${names}`);
  console.warn('!!! The schema they create is NOT applied by this run. It must be supplied by the owner.');
  console.warn('');
}

if (missingRequired.length > 0) {
  console.error('❌ Required migration files are missing. Nothing was applied.');
  for (const m of missingRequired) {
    console.error(`   - ${m.file}`);
  }
  process.exit(1);
}

/**
 * Count top-level SQL statements in a migration file. Naïve `split(';')`
 * would over-count because dollar-quoted PL/pgSQL bodies (used in 0004
 * for FK guards: `DO $$ BEGIN ... END $$;`) contain their own semicolons.
 * This walker tracks the open dollar tag (e.g. `$$` or `$tag$`) so only
 * top-level `;` characters are counted. Returns the number of executable
 * statements terminated by `;` (line comments and blank lines ignored).
 */
function countStatements(sql) {
  const stripped = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  let i = 0;
  let count = 0;
  let openTag = null; // current dollar tag, e.g. "$$" or "$plpgsql$"
  while (i < stripped.length) {
    const ch = stripped[i];
    if (openTag) {
      if (stripped.startsWith(openTag, i)) {
        i += openTag.length;
        openTag = null;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(stripped.slice(i));
      if (m) {
        openTag = m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === "'") {
      // skip single-quoted string (handles '' escape)
      i++;
      while (i < stripped.length) {
        if (stripped[i] === "'") {
          if (stripped[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ';') {
      count++;
    }
    i++;
  }
  return count;
}

async function runMigrations() {
  const pool = new Pool({ connectionString: dbUrl });

  console.log('🔄 Running safe database migration...\n');

  try {
    const client = await pool.connect();
    try {
      for (const entry of MIGRATIONS) {
        const migrationFile = migrationPath(entry.file);
        if (!existsSync(migrationFile)) {
          // Only optional entries reach here (required ones were checked above).
          console.warn(`!!! OPTIONAL migration not present, skipping: ${entry.file}`);
          continue;
        }

        const sql = readFileSync(migrationFile, 'utf8');
        const fileName = migrationFile.split('/').pop();
        const statementCount = countStatements(sql);

        console.log(`📄 Applying: ${fileName} (${statementCount} statements)`);

        // Execute the entire migration file as a single multi-statement
        // simple Query (pg sends it through to PostgreSQL's parser as-is).
        // Doing this — rather than naively splitting on `;` — preserves
        // dollar-quoted PL/pgSQL bodies like `DO $$ BEGIN ... END $$;`
        // used in 0004 for idempotent FK guards. We also wrap each file
        // in BEGIN/COMMIT so a failure halfway through can never leave the
        // schema in a half-applied state.
        const t0 = Date.now();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
          const durationMs = Date.now() - t0;
          // Structured machine-readable line so the system-update service
          // can parse per-file results and surface them in the admin UI
          // (task #196). Format is intentionally a single JSON object on
          // one line, sandwiched in `__MIGRATION_RESULT__:` markers.
          console.log(`__MIGRATION_RESULT__:${JSON.stringify({
            file: fileName,
            statements: statementCount,
            durationMs,
            status: 'applied',
          })}`);
          console.log(`   ✅ ${fileName} applied (${statementCount} statements, ${durationMs}ms)`);
        } catch (err) {
          const durationMs = Date.now() - t0;
          console.log(`__MIGRATION_RESULT__:${JSON.stringify({
            file: fileName,
            statements: statementCount,
            durationMs,
            status: 'failed',
            error: err.message,
          })}`);
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          console.error(`   ❌ Failed: ${fileName}`);
          console.error(`      ${err.message}`);
          throw err;
        }
        console.log('');
      }

      console.log('✅ Migration complete. Your database is up to date.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
