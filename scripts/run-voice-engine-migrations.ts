/**
 * Run all Custom Voice Engine plugin migrations.
 *
 * Applies migrations/001 through 003 in order to the ve_voice_agents table.
 * All statements use IF NOT EXISTS — safe to re-run.
 *
 * Usage:  npx tsx scripts/run-voice-engine-migrations.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sql } from 'drizzle-orm';
import { db } from '../server/db.js';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'plugins', 'custom-voice-engine', 'migrations');

const MIGRATIONS = [
  '001_voice_engine_tables.sql',
  '002_add_detect_language.sql',
  '003_add_system_tools.sql',
  '004_add_agent_models.sql',
];

async function main() {
  console.log('Running Custom Voice Engine plugin migrations...\n');

  for (const file of MIGRATIONS) {
    const filePath = resolve(MIGRATIONS_DIR, file);
    console.log(`📄 Applying: ${file}`);

    try {
      const content = readFileSync(filePath, 'utf8');
      const t0 = Date.now();
      await db.execute(sql.raw(content));
      const durationMs = Date.now() - t0;
      console.log(`   ✅ ${file} applied (${durationMs}ms)`);
    } catch (err: any) {
      console.error(`   ❌ ${file} failed: ${err.message}`);
    }

    console.log('');
  }

  console.log('✅ Voice Engine migrations complete.');
  process.exit(0);
}

main();
