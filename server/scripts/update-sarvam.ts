import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.ts';

async function main() {
  logger.info("Updating ve_tts_sarvam_model to bulbul:v3 in DB...");

  try {
    try {
      await db.execute(sql`UPDATE settings SET value = '"bulbul:v3"' WHERE key = 've_tts_sarvam_model'`);
      logger.info("✅ Successfully updated ve_tts_sarvam_model in 'settings' table!");
    } catch (err: any) {
      // If settings table doesn't exist, try global_settings
      await db.execute(sql`UPDATE global_settings SET value = '"bulbul:v3"' WHERE key = 've_tts_sarvam_model'`);
      logger.info("✅ Successfully updated ve_tts_sarvam_model in 'global_settings' table!");
    }
  } catch (error: any) {
    logger.error("❌ Database update failed:", error.message);
  }

  process.exit(0);
}
main();
