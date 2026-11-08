import { db } from '../server/db.js';
import { globalSettings } from '../shared/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  console.log("Connecting to the database to set default allowed LLM models...");

  try {
    const defaultModels = ['openai/gpt-4o-mini', 'anthropic/claude-3-haiku', 'google/gemini-flash-1.5'];

    console.log(`Setting ve_llm_allowed_models to: ${JSON.stringify(defaultModels)}`);

    // Check if it already exists
    const existing = await db.select().from(globalSettings).where(eq(globalSettings.key, 've_llm_allowed_models')).limit(1);

    if (existing.length > 0) {
      await db.update(globalSettings)
        .set({ value: defaultModels })
        .where(eq(globalSettings.key, 've_llm_allowed_models'));
    } else {
      await db.insert(globalSettings).values({
        key: 've_llm_allowed_models',
        value: defaultModels,
        description: 'Voice Engine: Allowed LLM models array'
      });
    }

    console.log("✅ Successfully updated ve_llm_allowed_models in the global_settings table!");
  } catch (error: any) {
    console.error("❌ Database update failed:", error.message);
  }

  process.exit(0);
}

main();
