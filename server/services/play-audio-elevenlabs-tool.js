import { getDomain } from "../utils/domain.js";
function getPlayAudioWebhookTool(nodeId, audioUrl, audioFileName, interruptible, waitForComplete, elevenLabsAgentId) {
  const domain = getDomain();
  const webhookUrl = `${domain}/api/elevenlabs/tools/play-audio/${elevenLabsAgentId}`;
  const toolName = `play_audio_${nodeId.slice(-8)}`;
  console.log(`\u{1F50A} [PlayAudio Tool] Creating webhook tool for agent ${elevenLabsAgentId}`);
  console.log(`   Tool name: ${toolName}`);
  console.log(`   Audio URL: ${audioUrl}`);
  console.log(`   Webhook URL: ${webhookUrl}`);
  return {
    type: "webhook",
    name: toolName,
    description: `Play the audio file "${audioFileName}". Call this tool to play the audio during the conversation.`,
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: {
          audioUrl: {
            type: "string",
            description: "The URL of the audio file to play",
            const: audioUrl
          },
          interruptible: {
            type: "boolean",
            description: "Whether the audio can be interrupted",
            const: interruptible
          },
          waitForComplete: {
            type: "boolean",
            description: "Whether to wait for audio to complete",
            const: waitForComplete
          }
        },
        required: ["audioUrl"]
      }
    }
  };
}
export {
  getPlayAudioWebhookTool
};
