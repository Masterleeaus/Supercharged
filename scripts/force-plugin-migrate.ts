import fs from 'fs';
import path from 'path';
import { db } from '../server/db.ts';
import { sql } from 'drizzle-orm';

async function run() {
  const migrationsPath = path.join(process.cwd(), 'plugins/custom-voice-engine/migrations');
  const files = fs.readdirSync(migrationsPath).sort();
  
  for (const file of files) {
    if (file.endsWith('.sql')) {
      console.log(`Running ${file}...`);
      const sqlContent = fs.readFileSync(path.join(migrationsPath, file), 'utf-8');
      try {
        await db.execute(sql.raw(sqlContent));
        console.log(`✅ Success: ${file}`);
      } catch (err) {
        console.error(`❌ Failed: ${file}`, err.message);
      }
    }
  }
  process.exit(0);
}

run();
