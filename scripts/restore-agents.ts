import { db } from '../server/db';
import { agents } from '../shared/schema';
import { IncomingAgentService } from '../server/services/incoming-agent';
import { FlowAgentService } from '../server/services/flow-agent';

async function main() {
  console.log('Restoring agents...');

  // 1. Restore Flow agent 'test'
  try {
    console.log('Restoring test (flow)...');
    const flowResult = await FlowAgentService.createInElevenLabs({
      userId: "9abdfade-a668-4ae6-9041-79df4cf652fd",
      name: "test",
      flowId: "wta9R0fyaEsXPdh365e8w",
      elevenLabsVoiceId: "dNjJKg63Fr5AXwIdkATa",
      systemPrompt: "",
      firstMessage: "Hello! How can I help you today?",
      language: "en",
      llmModel: "gpt-4o-mini",
      temperature: 0.5,
      maxDurationSeconds: 600,
      voiceStability: 0.5,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 1,
      turnTimeout: 1.5,
      detectLanguageEnabled: false,
      expressiveMode: false,
      knowledgeBaseIds: [],
    });

    await db.insert(agents).values({
      id: "b7a1c02d-b34e-4d6e-890b-50dbfafbc14a",
      userId: "9abdfade-a668-4ae6-9041-79df4cf652fd",
      elevenLabsCredentialId: flowResult.credentialId,
      telephonyProvider: "twilio",
      type: "flow",
      name: "test",
      voiceTone: "professional",
      personality: "helpful",
      systemPrompt: "",
      language: "en",
      firstMessage: "Hello! How can I help you today?",
      llmModel: "gpt-4o-mini",
      temperature: 0.5,
      elevenLabsAgentId: flowResult.elevenLabsAgentId,
      elevenLabsVoiceId: "dNjJKg63Fr5AXwIdkATa",
      voiceStability: 0.5,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 1.0,
      turnTimeout: 1.5,
      flowId: "wta9R0fyaEsXPdh365e8w",
      maxDurationSeconds: 600,
      isActive: true,
    });
    console.log('✅ Flow agent "test" restored successfully!');
  } catch (err: any) {
    console.error('❌ Failed to restore "test":', err.message);
  }

  // 2. Restore Incoming agent 'Geovana'
  try {
    console.log('Restoring Geovana (incoming)...');
    const geoResult = await IncomingAgentService.createInElevenLabs({
      userId: "9abdfade-a668-4ae6-9041-79df4cf652fd",
      name: "Geovana",
      systemPrompt: "You are Geovana, a helpful assistant.",
      elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM", // default fallback
      firstMessage: "Hello! How can I help you today?",
      language: "en",
      llmModel: "gpt-4o-mini",
      temperature: 0.5,
      maxDurationSeconds: 600,
      voiceStability: 0.65,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 0.92,
      turnTimeout: 1.5,
      detectLanguageEnabled: false,
      expressiveMode: false,
      knowledgeBaseIds: [],
    });

    await db.insert(agents).values({
      id: "43f1acc1-d004-4e17-8382-f3e3c64d130f",
      userId: "9abdfade-a668-4ae6-9041-79df4cf652fd",
      elevenLabsCredentialId: geoResult.credentialId,
      telephonyProvider: "twilio",
      type: "incoming",
      name: "Geovana",
      voiceTone: null,
      personality: null,
      systemPrompt: null,
      language: "en",
      firstMessage: "Hello! How can I help you today?",
      llmModel: "gpt-4o-mini",
      temperature: 0.5,
      elevenLabsAgentId: geoResult.elevenLabsAgentId,
      elevenLabsVoiceId: null,
      voiceStability: 0.65,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 0.92,
      turnTimeout: 1.5,
      flowId: null,
      maxDurationSeconds: 600,
      isActive: true,
    });
    console.log('✅ Incoming agent "Geovana" restored successfully!');
  } catch (err: any) {
    console.error('❌ Failed to restore "Geovana":', err.message);
  }

  // 3. Restore Incoming agent 'Stella Sales'
  try {
    console.log('Restoring Stella Sales (incoming)...');
    const stellaResult = await IncomingAgentService.createInElevenLabs({
      userId: "9abdfade-a668-4ae6-9041-79df4cf652fd",
      name: "Stella Sales",
      systemPrompt: "You are Stella Sales, a helpful sales assistant.",
      elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM", // default fallback
      firstMessage: "Hello! How can I help you today?",
      language: "en",
      llmModel: "gpt-4o-mini",
      temperature: 0.5,
      maxDurationSeconds: 600,
      voiceStability: 0.65,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 0.92,
      turnTimeout: 1.5,
      detectLanguageEnabled: false,
      expressiveMode: false,
      knowledgeBaseIds: [],
    });

    await db.insert(agents).values({
      id: "106ff33b-8dd1-4568-b0c8-68f0f1c3511b",
      userId: "9abdfade-a668-4ae6-9041-79df4cf652fd",
      elevenLabsCredentialId: stellaResult.credentialId,
      telephonyProvider: "twilio",
      type: "incoming",
      name: "Stella Sales",
      voiceTone: null,
      personality: null,
      systemPrompt: null,
      language: "en",
      firstMessage: "Hello! How can I help you today?",
      llmModel: "gpt-4o-mini",
      temperature: 0.5,
      elevenLabsAgentId: stellaResult.elevenLabsAgentId,
      elevenLabsVoiceId: null,
      voiceStability: 0.65,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 0.92,
      turnTimeout: 1.5,
      flowId: null,
      maxDurationSeconds: 600,
      isActive: true,
    });
    console.log('✅ Incoming agent "Stella Sales" restored successfully!');
  } catch (err: any) {
    console.error('❌ Failed to restore "Stella Sales":', err.message);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
