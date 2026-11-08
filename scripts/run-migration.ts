import { db } from '../server/db';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

async function main() {
  try {
    const sqlContent = fs.readFileSync('plugins/custom-voice-engine/migrations/004_add_agent_models.sql', 'utf-8');
    await db.execute(sql.raw(sqlContent));
    console.log("Migration executed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

main();
