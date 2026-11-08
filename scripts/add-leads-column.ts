import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Adding ve_session_id to leads table...');
  await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ve_session_id varchar`);
  console.log('Column added successfully or already exists!');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
