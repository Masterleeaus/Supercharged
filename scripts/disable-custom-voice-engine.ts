import { db } from '../server/db.js';
import { globalSettings } from '../shared/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const key = 'plugin_custom-voice-engine_enabled';

  const existing = await db.select().from(globalSettings).where(eq(globalSettings.key, key)).limit(1);

  if (existing.length > 0) {
    await db.update(globalSettings)
      .set({ value: { enabled: true } })
      .where(eq(globalSettings.key, key));
    console.log('Updated plugin_custom-voice-engine_enabled to false');
  } else {
    await db.insert(globalSettings).values({
      key,
      value: { enabled: true },
      description: 'Whether the custom-voice-engine plugin is enabled',
    });
    console.log('Inserted plugin_custom-voice-engine_enabled as false');
  }

  process.exit(0);
}

main();
