import { db } from '../db';
import { globalSettings } from '@shared/schema';
import { inArray } from 'drizzle-orm';
import { logger } from '../utils/logger.ts';

async function run() {
  try {
    const result = await db.select().from(globalSettings).where(inArray(globalSettings.key, ['ve_tts_sarvam_model', 've_tts_sarvam_speaker']));
    logger.info("Settings:");
    result.forEach(row => {
      logger.info(`${row.key}: ${row.value}`);
    });
  } catch (error) {
    logger.error("Database query failed:", error);
  }
  process.exit(0);
}

run();
