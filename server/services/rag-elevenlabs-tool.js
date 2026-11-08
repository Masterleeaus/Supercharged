import { RAGKnowledgeService } from "./rag-knowledge.js";
import { getDomain } from "../utils/domain.js";
import { ElevenLabsService } from "./elevenlabs.js";
import { ElevenLabsPoolService } from "./elevenlabs-pool.js";
import { getAppointmentToolForAgent } from "./appointment-elevenlabs-tool.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
const PERSISTED_SECRET_PATH = path.join(process.cwd(), ".rag-webhook-secret");
let ragWebhookSecret = null;
function getRAGWebhookSecret() {
  if (!ragWebhookSecret) {
    if (process.env.RAG_WEBHOOK_SECRET) {
      ragWebhookSecret = process.env.RAG_WEBHOOK_SECRET;
    } else {
      try {
        if (fs.existsSync(PERSISTED_SECRET_PATH)) {
          ragWebhookSecret = fs.readFileSync(PERSISTED_SECRET_PATH, "utf-8").trim();
          console.log(`\u{1F4DA} [RAG Tool] Loaded persisted webhook secret from file`);
        }
      } catch (err) {
      }
      if (!ragWebhookSecret) {
        const baseKey = process.env.JWT_SECRET || process.env.ELEVENLABS_AGENT_SECRET;
        if (baseKey) {
          ragWebhookSecret = crypto.createHmac("sha256", baseKey).update("agentlabs:rag-webhook-secret:v1").digest("hex");
          console.log(`\u{1F4DA} [RAG Tool] Derived stable webhook secret from server key`);
          try {
            fs.writeFileSync(PERSISTED_SECRET_PATH, ragWebhookSecret, { mode: 384 });
          } catch (err) {
          }
        }
      }
      if (!ragWebhookSecret) {
        ragWebhookSecret = crypto.randomBytes(32).toString("hex");
        console.log(`\u{1F4DA} [RAG Tool] Generated new webhook secret`);
        try {
          fs.writeFileSync(PERSISTED_SECRET_PATH, ragWebhookSecret, { mode: 384 });
        } catch (err) {
        }
      }
    }
  }
  return ragWebhookSecret;
}
function validateRAGWebhookToken(providedToken) {
  if (!providedToken) {
    return false;
  }
  const secret = getRAGWebhookSecret();
  const providedBuffer = Buffer.from(providedToken);
  const secretBuffer = Buffer.from(secret);
  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}
function getAskKnowledgeWebhookTool(elevenLabsAgentId) {
  const domain = getDomain();
  const secret = getRAGWebhookSecret();
  const webhookUrl = `${domain}/api/webhooks/elevenlabs/rag-tool/${secret}/${elevenLabsAgentId}`;
  const agentIdSuffix = elevenLabsAgentId.slice(-8);
  const toolName = `ask_knowledge_${agentIdSuffix}`;
  console.log(`\u{1F4DA} [RAG Tool] Creating webhook tool config for ElevenLabs agent ${elevenLabsAgentId}`);
  console.log(`   Tool name: ${toolName}`);
  console.log(`   Webhook URL: ${webhookUrl.replace(secret, "[TOKEN]")}`);
  return {
    type: "webhook",
    name: toolName,
    description: "Search the company knowledge base for information. Use this tool when you need to look up specific details, facts, policies, procedures, or any information that might be stored in the knowledge base. Pass the user's question or relevant keywords as the query.",
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query - the question or keywords to search for in the knowledge base"
          }
        },
        required: ["query"]
      }
    }
  };
}
async function handleAskKnowledgeToolCall(query, knowledgeBaseIds, userId) {
  console.log(`[RAG Tool] Processing query: "${query.substring(0, 50)}..."`);
  if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) {
    return {
      response: "No knowledge base is configured for this agent.",
      sources: []
    };
  }
  try {
    const results = await RAGKnowledgeService.searchKnowledge(
      query,
      knowledgeBaseIds,
      userId,
      3
      // Top 3 results for concise response
    );
    if (results.length === 0) {
      return {
        response: "I couldn't find any relevant information in the knowledge base for that question.",
        sources: []
      };
    }
    const formattedResponse = RAGKnowledgeService.formatResultsForAgent(results, 400);
    return {
      response: formattedResponse,
      sources: results.map((r) => ({
        id: r.chunk.knowledgeBaseId,
        relevance: r.score
      }))
    };
  } catch (error) {
    console.error("[RAG Tool] Error:", error.message);
    return {
      response: "I encountered an error searching the knowledge base. Please try again.",
      sources: []
    };
  }
}
function isRAGEnabled() {
  const val = (process.env.USE_RAG_KNOWLEDGE || "").toLowerCase().trim();
  return val !== "false" && val !== "0" && val !== "no";
}
async function setupRAGToolForAgent(elevenLabsAgentId, agentId, hasKnowledgeBase, systemTools, appointmentBookingEnabled) {
  const credential = await ElevenLabsPoolService.getCredentialForAgent(agentId);
  if (!credential) {
    console.warn(`\u{1F4DA} [RAG Tool] No credential found for agent ${agentId}`);
    return;
  }
  const elevenLabsService = new ElevenLabsService(credential.apiKey);
  let agent = null;
  try {
    agent = await elevenLabsService.getAgent(elevenLabsAgentId);
  } catch (err) {
    console.warn(`\u{1F4DA} [RAG Tool] Failed to fetch agent details: ${err.message}`);
  }
  if (agent && hasKnowledgeBase && isRAGEnabled()) {
    const prompt = agent.conversation_config?.agent?.prompt?.prompt || "";
    const agentIdSuffix = elevenLabsAgentId.slice(-8);
    const correctToolName = `ask_knowledge_${agentIdSuffix}`;
    if (prompt && prompt.includes("ask_knowledge") && !prompt.includes(correctToolName)) {
      console.log(`\u{1F4DA} [RAG Tool] Correcting generic tool name references in prompt to '${correctToolName}'`);
      const updatedPrompt = prompt.replace(/\bask_knowledge\b/g, correctToolName);
      if (updatedPrompt !== prompt) {
        try {
          await elevenLabsService.patchAgentRaw(elevenLabsAgentId, {
            conversation_config: {
              agent: {
                prompt: {
                  prompt: updatedPrompt
                }
              }
            }
          });
          console.log(`\u2705 [RAG Tool] Corrected system prompt saved to ElevenLabs`);
        } catch (patchErr) {
          console.warn(`\u274C [RAG Tool] Failed to update prompt with corrected tool name: ${patchErr.message}`);
        }
      }
    }
  }
  const webhookTools = [];
  if (appointmentBookingEnabled) {
    try {
      const appointmentTool = getAppointmentToolForAgent(elevenLabsAgentId);
      const toolId = await elevenLabsService.getOrCreateWorkspaceTool(appointmentTool);
      const existingToolIds = agent?.conversation_config?.agent?.prompt?.tool_ids || [];
      const updatedToolIds = Array.from(/* @__PURE__ */ new Set([...existingToolIds, toolId]));
      console.log(`\u{1F4C5} [RAG Tool] Attaching appointment tool ID ${toolId} to agent ${elevenLabsAgentId}`);
      await elevenLabsService.patchAgentRaw(elevenLabsAgentId, {
        conversation_config: {
          agent: {
            prompt: {
              tool_ids: updatedToolIds
            }
          }
        }
      });
      console.log(`\u2705 [RAG Tool] Appointment tool attached via tool_ids`);
    } catch (appointmentError) {
      console.warn(`\u274C [RAG Tool] Failed to attach appointment tool via tool_ids: ${appointmentError.message}`);
    }
  }
  if (!hasKnowledgeBase || !isRAGEnabled()) {
    if (webhookTools.length === 0) {
      console.log(`\u{1F4DA} [RAG Tool] No knowledge base or RAG disabled - clearing webhook tools but preserving system tools`);
    } else {
      console.log(`\u{1F4DA} [RAG Tool] No knowledge base or RAG disabled - linking ${webhookTools.length} webhook tool(s) with system tools`);
    }
    try {
      await elevenLabsService.linkToolsToAgent(elevenLabsAgentId, webhookTools, systemTools);
    } catch (error) {
      console.warn(`\u{1F4DA} [RAG Tool] Failed to update tools: ${error.message}`);
    }
    return;
  }
  console.log(`\u{1F4DA} [RAG Tool] Setting up RAG tool for agent ${elevenLabsAgentId}`);
  if (systemTools && systemTools.length > 0) {
    console.log(`   Preserving system tools: ${systemTools.map((t) => t.name).join(", ")}`);
  }
  try {
    const toolConfig = getAskKnowledgeWebhookTool(elevenLabsAgentId);
    webhookTools.push(toolConfig);
    try {
      await elevenLabsService.getOrCreateWorkspaceTool(toolConfig);
      console.log(`\u{1F4DA} [RAG Tool] Workspace tool created/verified for dashboard visibility`);
    } catch (wsError) {
      console.warn(`\u{1F4DA} [RAG Tool] Workspace tool creation skipped: ${wsError.message}`);
    }
    console.log(`\u{1F4DA} [RAG Tool] Linking ${webhookTools.length} webhook tool(s): ${webhookTools.map((t) => t.name).join(", ")}`);
    await elevenLabsService.linkToolsToAgent(elevenLabsAgentId, webhookTools, systemTools);
    console.log(`\u2705 [RAG Tool] Tool added to agent successfully`);
  } catch (error) {
    console.error(`\u274C [RAG Tool] Failed to setup RAG tool: ${error.message}`);
  }
}
function buildRAGToolsArray(elevenLabsAgentId, hasKnowledgeBase) {
  if (!isRAGEnabled() || !hasKnowledgeBase) {
    console.log(`\u{1F4DA} [RAG Tool] Skipping - RAG enabled: ${isRAGEnabled()}, hasKB: ${hasKnowledgeBase}`);
    return [];
  }
  console.log(`\u{1F4DA} [RAG Tool] Building webhook tool for ElevenLabs agent ${elevenLabsAgentId}`);
  return [getAskKnowledgeWebhookTool(elevenLabsAgentId)];
}
var rag_elevenlabs_tool_default = {
  getAskKnowledgeWebhookTool,
  handleAskKnowledgeToolCall,
  isRAGEnabled,
  buildRAGToolsArray,
  setupRAGToolForAgent,
  getRAGWebhookSecret,
  validateRAGWebhookToken
};
export {
  buildRAGToolsArray,
  rag_elevenlabs_tool_default as default,
  getAskKnowledgeWebhookTool,
  getRAGWebhookSecret,
  handleAskKnowledgeToolCall,
  isRAGEnabled,
  setupRAGToolForAgent,
  validateRAGWebhookToken
};
