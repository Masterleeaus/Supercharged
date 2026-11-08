import 'dotenv/config';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL environment variable is missing in .env.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const client = await pool.connect();
  try {
    console.log("Running database migrations for website_widgets...");

    // 1. Drop the constraint
    await client.query(`
      ALTER TABLE "website_widgets" DROP CONSTRAINT IF EXISTS "website_widgets_agent_id_agents_id_fk";
    `);
    console.log("✓ Dropped website_widgets_agent_id_agents_id_fk constraint.");

    // 2. Add missing columns
    await client.query(`
      ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "max_concurrent_calls" integer DEFAULT 5 NOT NULL;
    `);
    await client.query(`
      ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "max_call_duration" integer DEFAULT 300 NOT NULL;
    `);
    await client.query(`
      ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "cooldown_minutes" integer DEFAULT 0 NOT NULL;
    `);
    await client.query(`
      ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "appointment_booking_enabled" boolean DEFAULT false NOT NULL;
    `);
    console.log("✓ Ensured all columns exist on website_widgets table.");

    console.log("Database update completed successfully!");
  } catch (err: any) {
    console.error("Error updating database:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
