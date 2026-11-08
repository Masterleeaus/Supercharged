import { sql } from 'drizzle-orm';
import { db } from '../server/db.js';

async function main() {
  console.log('Adding missing columns to ve_sessions...');
  try {
    await db.execute(sql`ALTER TABLE ve_sessions ADD COLUMN IF NOT EXISTS classification TEXT;`);
    console.log('✅ Added "classification" column.');

    await db.execute(sql`ALTER TABLE ve_sessions ADD COLUMN IF NOT EXISTS sentiment TEXT;`);
    console.log('✅ Added "sentiment" column.');

    await db.execute(sql`ALTER TABLE ve_sessions ADD COLUMN IF NOT EXISTS ai_summary TEXT;`);
    console.log('✅ Added "ai_summary" column.');

    console.log('🎉 Done fixing columns.');
  } catch (err: any) {
    console.error('❌ Error applying column changes:', err.message);
  }
  process.exit(0);
}

main();
