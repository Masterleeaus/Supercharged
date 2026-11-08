/**
 * Safe incremental database migration runner.
 *
 * Applies the files listed in MIGRATIONS (below), in that order.
 *
 * Usage:
 *   node scripts/run-safe-migration.mjs                       apply to DATABASE_URL
 *   node scripts/run-safe-migration.mjs --dry-run             print the ordered set, touch no database
 *   node scripts/run-safe-migration.mjs --migrations-dir=DIR  read files from DIR (used by tests)
 *
 * Requirements:
 *   - DATABASE_URL environment variable must be set (or a .env file in the
 *     project root with DATABASE_URL=...). Not needed for --dry-run.
 *   - The target database must already have the base schema applied
 *     (either via `npm run db:push` on a fresh install, or via the
 *     migrations/0000_damp_spectrum.sql file)
 *
 * Missing files: every MIGRATIONS entry must exist unless it is in
 * OPTIONAL_MIGRATIONS. A missing required file exits 1 before any database
 * work, so no later migration is applied.
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

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const migrationsDirArg = args.find((a) => a.startsWith('--migrations-dir='));
const migrationsDir = migrationsDirArg
  ? resolve(migrationsDirArg.slice('--migrations-dir='.length))
  : resolve(rootDir, 'migrations');

/**
 * Ordered list of migration files, relative to the migrations folder.
 * The order is intentional (owner decision O-08): 0010b_approvals runs after
 * 0011_inbox_channels_and_providers. Do not re-sort this list.
 */
const MIGRATIONS = [
  '0001_add_missing_columns.sql',
  '0002_add_google_sheets_credentials.sql',
  '0003_campaign_contact_retry.sql',
  '0004_add_missing_tables.sql',
  '0005_add_missing_agent_messaging_columns.sql',
  '0006_add_default_campaign_type.sql',
  '0007_add_external_fonoster_phone_id.sql',
  '008_add_ve_session_id_and_voice_engine_tables.sql',
  '009_fix_ve_session_id_and_all_missing_columns.sql',
  '0010_add_yookassa_columns.sql',
  '0010a_inbox.sql',
  '0011_inbox_channels_and_providers.sql',
  '0010b_approvals.sql',
  '0013_approvals_revoked_status.sql',
  '0010c_chatbot.sql',
];

/**
 * Entries that may be missing from the folder without failing the run.
 * Empty on purpose: any missing file in MIGRATIONS is an error. Add a name
 * here only with a comment saying why the schema does not need it.
 *
 * 008_ and 009_ are NOT optional. schema.ts (leads.veSessionId) and the voice
 * engine code use ve_session_id and ve_sessions, and neither file exists in
 * this repo. Until the owner supplies them or removes them from MIGRATIONS
 * (checklist decision D-B2-4), the runner fails on purpose.
 */
const OPTIONAL_MIGRATIONS = new Set([]);

/**
 * Check every MIGRATIONS entry against the folder before anything runs.
 * Returns the ordered plan and the list of missing required files.
 */
function planMigrations(dir) {
  const plan = [];
  const missing = [];
  for (const name of MIGRATIONS) {
    const path = resolve(dir, name);
    if (!existsSync(path)) {
      if (OPTIONAL_MIGRATIONS.has(name)) {
        console.warn(`⚠️  Optional migration not found, skipping: ${name}`);
      } else {
        missing.push(name);
      }
      continue;
    }
    const sql = readFileSync(path, 'utf8');
    plan.push({ name, path, statements: countStatements(sql) });
  }
  return { plan, missing };
}

/**
 * Compare the drizzle journal with the files. Warnings only: the journal is
 * not read by this runner yet, so mismatches are reported, not enforced.
 */
function journalWarnings(dir) {
  const journalPath = resolve(dir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return ['no meta/_journal.json found'];
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const tags = journal.entries.map((e) => e.tag);
  const warnings = [];
  for (const tag of tags) {
    if (!existsSync(resolve(dir, `${tag}.sql`))) {
      warnings.push(`journal entry ${tag} has no file ${tag}.sql`);
    }
  }
  for (const name of MIGRATIONS) {
    const tag = name.replace(/\.sql$/, '');
    if (!tags.includes(tag)) warnings.push(`runner file ${name} is not in the journal`);
  }
  return warnings;
}

function runDryRun() {
  const { plan, missing } = planMigrations(migrationsDir);
  console.log(`Dry run. No database is touched. Folder: ${migrationsDir}\n`);
  if (missing.length) {
    for (const name of missing) console.error(`❌ Required migration missing: ${name}`);
    console.error(`\n❌ ${missing.length} required migration file(s) missing. Nothing would be applied.`);
    process.exit(1);
  }
  console.log('Would apply, in order:');
  plan.forEach((m, i) => console.log(`  ${i + 1}. ${m.name} (${m.statements} statements)`));
  console.log('\nJournal check (warnings only):');
  const warnings = journalWarnings(migrationsDir);
  if (warnings.length === 0) console.log('  none');
  for (const w of warnings) console.log(`  - ${w}`);
  process.exit(0);
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

async function runMigrations(plan) {
  const dbUrl = process.env.DATABASE_URL;
  const { default: pg } = await import('pg');
  const { Pool } = pg;
  const pool = new Pool({ connectionString: dbUrl });

  console.log('🔄 Running safe database migration...\n');

  try {
    const client = await pool.connect();
    try {
      for (const entry of plan) {
        const fileName = entry.name;
        const statementCount = entry.statements;
        const sql = readFileSync(entry.path, 'utf8');

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

// Pre-flight: check every required file before any database work. A missing
// required file stops the run here, so no later migration is applied.
if (DRY_RUN) {
  runDryRun();
} else {
  const { plan, missing } = planMigrations(migrationsDir);
  if (missing.length) {
    for (const name of missing) console.error(`❌ Required migration missing: ${name}`);
    console.error(`\n❌ ${missing.length} required migration file(s) missing. Nothing was applied.`);
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ DATABASE_URL environment variable is not set.');
    console.error('   Set it in your environment or in a .env file at the project root.');
    process.exit(1);
  }
  await runMigrations(plan);
}
