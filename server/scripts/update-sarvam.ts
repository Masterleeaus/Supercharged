import { db } from '../db.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log("Updating ve_tts_sarvam_model to bulbul:v3 in DB...");

  try {
    try {
      await db.execute(sql`UPDATE settings SET value = '"bulbul:v3"' WHERE key = 've_tts_sarvam_model'`);
      console.log("✅ Successfully updated ve_tts_sarvam_model in 'settings' table!");
    } catch (err: any) {
      // If settings table doesn't exist, try global_settings
      await db.execute(sql`UPDATE global_settings SET value = '"bulbul:v3"' WHERE key = 've_tts_sarvam_model'`);
      console.log("✅ Successfully updated ve_tts_sarvam_model in 'global_settings' table!");
    }
  } catch (error: any) {
    console.error("❌ Database update failed:", error.message);
  }

  process.exit(0);
}
main();
