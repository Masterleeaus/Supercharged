import { logger } from "../../utils/logger";
import type { Express, Response } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { agents, llmModels } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { authenticateToken, type AuthRequest } from "../../middleware/auth";
import { elevenLabsService, ElevenLabsService, isAgentOnSipPhoneNumber, getSipTrunkOutboundAddress } from "../../services/elevenlabs";
import { sanitizeLlmModel } from "../../utils/llm-sanitize";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { flows, FlowNode, FlowEdge } from "@shared/schema";
import { ElevenLabsFlowCompiler } from "../../services/elevenlabs-flow-compiler";
import { safeErrorMessage } from "../../utils/safe-error";

export function registerElevenLabsAgentRoutes(app: Express): void {
  // ElevenLabs Agents routes
  app.get("/api/elevenlabs/agents", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agents = await storage.getUserAgents(req.userId!);
      res.json(agents);
    } catch (error: any) {
      logger.error("Get agents error:", error);
      res.status(500).json({ error: "Failed to get agents" });
    }
  });

  app.post("/api/elevenlabs/agents", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const {
        type = 'natural',
        name,
        voiceTone,
        personality,
        systemPrompt,
        elevenLabsVoiceId,
        language,
        model,
        firstMessage,
        temperature,
        transferRules,
        knowledgeBaseIds,
        flowId,
        maxDurationSeconds,
        voiceStability,
        voiceSimilarityBoost,
        voiceSpeed,
        detectLanguageEnabled,
      } = req.body;

      // Base validation - name and voice required for both types
      // Note: Both agent types need elevenLabsVoiceId:
      //   - Natural agents: voice for ElevenLabs Conversational AI
      //   - Flow agents: voice for ElevenLabs TTS (text-to-speech)
      if (!name || !elevenLabsVoiceId) {
        return res.status(400).json({ error: "Agent name and voice are required" });
      }

      // Type-specific validation
      if (type === 'natural' && !systemPrompt) {
        return res.status(400).json({ error: "Natural agents require a system prompt" });
      }

      if (type === 'flow' && !flowId) {
        return res.status(400).json({ error: "Flow agents require a flow to be selected" });
      }

      // Check user's plan limits
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      // Count existing agents
      const existingAgents = await storage.getUserAgents(req.userId!);
      // Skip limit check if explicitly unlimited (-1 or 999)
      if (plan.maxAgents !== -1 && plan.maxAgents !== 999 && existingAgents.length >= plan.maxAgents) {
        return res.status(403).json({
          error: `Agent limit reached. Your ${plan.displayName} plan allows maximum ${plan.maxAgents} agent(s). Please upgrade to create more agents.`,
          upgradeRequired: true
        });
      }

      // Build tools configuration if transfer rules are provided
      const tools = transferRules && transferRules.length > 0 ? [{
        type: "transfer_to_number" as const,
        description: "Transfer user to human support when needed",
        transfer_rules: transferRules,
      }] : undefined;

      // Create ElevenLabs agent based on type
      let elevenLabsAgentId: string | null = null;
      let agentLink: string | null = null;
      let usedCredentialId: string | null = null;

      if (type === 'natural') {
        // Use user credential affinity - ensures all user's resources stay on same ElevenLabs account
        const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);
        if (!credential) {
          return res.status(500).json({ error: "No available ElevenLabs API keys" });
        }
        usedCredentialId = credential.id;
        const credentialService = new ElevenLabsService(credential.apiKey);

        // Natural Agent: Create ElevenLabs Conversational AI agent
        // Get KB objects from our knowledge base IDs
        let knowledgeBases: Array<{ type: string; title: string; elevenLabsDocId: string }> | undefined;
        if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
          const kbItems = await Promise.all(
            knowledgeBaseIds.map((id: string) => storage.getKnowledgeBaseItem(id))
          );
          // Verify ownership and filter valid items
          knowledgeBases = kbItems
            .filter(item => item && item.userId === req.userId && item.elevenLabsDocId)
            .map(item => ({
              type: item!.type,
              title: item!.title,
              elevenLabsDocId: item!.elevenLabsDocId!
            }));

          logger.info(`📚 Filtered ${knowledgeBases.length} valid knowledge base items from ${knowledgeBaseIds.length} selected`);
        }

        // Create agent in ElevenLabs
        const elevenLabsAgent = await credentialService.createAgent({
          name,
          prompt: systemPrompt!,
          voice_id: elevenLabsVoiceId,
          language: language || "en",
          model: model || "gpt-4o-mini",
          first_message: firstMessage || "Hello! How can I help you today?",
          temperature: temperature !== undefined ? temperature : 0.5,
          voice_tone: voiceTone,
          personality: personality,
          tools: tools,
          knowledge_bases: knowledgeBases,
        });

        elevenLabsAgentId = elevenLabsAgent.agent_id;
        agentLink = `https://elevenlabs.io/app/conversational-ai/call/${elevenLabsAgent.agent_id}`;
      } else if (type === 'flow') {
        // Use user credential affinity - ensures all user's resources stay on same ElevenLabs account
        const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);
        if (!credential) {
          return res.status(500).json({ error: "No available ElevenLabs API keys" });
        }
        usedCredentialId = credential.id;
        const credentialService = new ElevenLabsService(credential.apiKey);

        // Flow Agent: Compile flow and create ElevenLabs agent with workflow
        logger.info(`🔄 Creating Flow Agent with flowId: ${flowId}`);

        // Fetch the flow from database
        const [flow] = await db
          .select()
          .from(flows)
          .where(and(eq(flows.id, flowId), eq(flows.userId, req.userId!)));

        if (!flow) {
          return res.status(404).json({ error: "Flow not found or access denied" });
        }

        logger.info(`📋 Found flow: ${flow.name} with ${(flow.nodes as FlowNode[]).length} nodes`);

        // Compile the flow to ElevenLabs workflow format
        const compiler = new ElevenLabsFlowCompiler(
          flow.nodes as FlowNode[],
          flow.edges as FlowEdge[]
        );
        const compileResult = compiler.compile();
        const compiledWorkflow = compileResult.workflow;
        const flowFirstMessage = compileResult.firstMessage;

        // Validate the compiled workflow
        const validation = compiler.validate();
        if (!validation.valid) {
          logger.warn(`⚠️ Flow validation warnings:`, validation.errors);
        }

        logger.info(`✅ Compiled workflow: ${Object.keys(compiledWorkflow.nodes).length} nodes, ${Object.keys(compiledWorkflow.edges).length} edges`);
        if (flowFirstMessage) {
          logger.info(`📝 First message from flow: "${flowFirstMessage.substring(0, 50)}..."`);
        }

        // For Flow agents: Flow's extracted first message takes PRIORITY over request's firstMessage
        // This ensures the agent says the scripted message from the flow, not a form default
        const effectiveFirstMessage = flowFirstMessage || firstMessage;

        // Smart TTS model selection: English uses eleven_turbo_v2, non-English uses admin setting or eleven_multilingual_v2
        // Note: ElevenLabs requires "turbo or flash v2" for conversational agents - v2_5 models are NOT supported
        const isEnglishAgent2 = (language || 'en') === 'en';
        let adminTtsModel: string;
        if (isEnglishAgent2) {
          adminTtsModel = 'eleven_turbo_v2';
        } else {
          const ttsModelSetting = await storage.getGlobalSetting('default_tts_model');
          adminTtsModel = (ttsModelSetting?.value as string) || 'eleven_multilingual_v2';
        }

        // Fetch KB objects with full details (ElevenLabs requires type, id, and name)
        const flowKnowledgeBases: Array<{ type: string; name: string; id: string }> = [];
        if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length > 0) {
          logger.info(`📚 [Flow] Preparing ${knowledgeBaseIds.length} knowledge base(s)`);

          for (const kbId of knowledgeBaseIds) {
            try {
              const kbItem = await storage.getKnowledgeBaseItem(kbId);

              if (!kbItem) {
                logger.warn(`⚠️  Knowledge base item ${kbId} not found, skipping`);
                continue;
              }

              if (!kbItem.elevenLabsDocId) {
                logger.warn(`⚠️  Knowledge base item ${kbId} has no ElevenLabs doc ID, skipping`);
                continue;
              }

              logger.info(`   Adding KB "${kbItem.title}" (${kbItem.elevenLabsDocId})`);
              flowKnowledgeBases.push({
                type: kbItem.type === 'text' ? 'text' : 'file',
                name: kbItem.title,
                id: kbItem.elevenLabsDocId
              });
            } catch (error: any) {
              logger.error(`   ❌ Failed to fetch KB ${kbId}:`, error.message);
            }
          }
        }

        // Create Flow Agent in ElevenLabs with compiled workflow
        const elevenLabsAgent = await credentialService.createFlowAgent({
          name,
          voice_id: elevenLabsVoiceId,
          language: language || "en",
          maxDurationSeconds: maxDurationSeconds ?? 600,
          voiceStability: voiceStability ?? 0.5,
          voiceSimilarityBoost: voiceSimilarityBoost ?? 0.75,
          voiceSpeed: voiceSpeed ?? 1.0,
          detectLanguageEnabled: detectLanguageEnabled || false,
          systemPrompt: systemPrompt || undefined,
          firstMessage: effectiveFirstMessage || undefined, // Use extracted first message from flow
          knowledgeBases: flowKnowledgeBases.length > 0 ? flowKnowledgeBases : undefined,
          ttsModel: adminTtsModel,
          workflow: compiledWorkflow,
        });

        elevenLabsAgentId = elevenLabsAgent.agent_id;
        agentLink = `https://elevenlabs.io/app/conversational-ai/call/${elevenLabsAgent.agent_id}`;

        logger.info(`✅ Flow Agent created in ElevenLabs: ${elevenLabsAgentId}`);
      }

      // Store in database - save all fields for both agent types
      const agent = await storage.createAgent({
        type: type as 'natural' | 'flow',
        userId: req.userId!,
        name,
        voiceTone: voiceTone || (type === 'natural' ? "professional" : null),
        personality: personality || (type === 'natural' ? "helpful" : null),
        systemPrompt: systemPrompt || null,
        language: language || "en",
        firstMessage: firstMessage || (type === 'natural' ? "Hello! How can I help you today?" : null),
        llmModel: model || (type === 'natural' ? "gpt-4o-mini" : null),
        temperature: temperature !== undefined ? temperature : (type === 'natural' ? 0.5 : null),
        elevenLabsVoiceId: elevenLabsVoiceId,
        elevenLabsAgentId: elevenLabsAgentId,
        agentLink: agentLink,
        // Multi-key pool affinity - store which credential created this agent
        elevenLabsCredentialId: usedCredentialId,
        // Knowledge base - enabled for both natural and flow agents
        knowledgeBaseIds: knowledgeBaseIds || null,
        // Flow Agent fields
        flowId: flowId || null,
        maxDurationSeconds: maxDurationSeconds ?? (type === 'flow' ? 600 : null),
        voiceStability: voiceStability ?? (type === 'flow' ? 0.5 : null),
        voiceSimilarityBoost: voiceSimilarityBoost ?? (type === 'flow' ? 0.75 : null),
        voiceSpeed: voiceSpeed ?? (type === 'flow' ? 1.0 : null),
        // System Tools - enabled for flow agents
        detectLanguageEnabled: type === 'flow' ? (detectLanguageEnabled || false) : false,
        config: {
          elevenLabsVoiceId,
          model: model || "gpt-4o-mini",
          firstMessage,
          temperature,
          transferRules: type === 'natural' ? transferRules : null,
          knowledgeBaseIds: knowledgeBaseIds || [],
        },
      });

      res.json(agent);
    } catch (error: any) {
      logger.error("Create agent error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to create agent") });
    }
  });

  app.patch("/api/elevenlabs/agents/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const {
        type,
        name,
        voiceTone,
        personality,
        systemPrompt,
        elevenLabsVoiceId,
        language,
        model,
        firstMessage,
        temperature,
        transferRules,
        knowledgeBaseIds,
        flowId,
        maxDurationSeconds,
        voiceStability,
        voiceSimilarityBoost,
        voiceSpeed,
        detectLanguageEnabled,
      } = req.body;

      // Build tools configuration if transfer rules are provided
      const tools = transferRules && transferRules.length > 0 ? [{
        type: "transfer_to_number" as const,
        description: "Transfer user to human support when needed",
        transfer_rules: transferRules,
      }] : undefined;

      // Get ElevenLabs doc IDs from our knowledge base IDs
      let elevenLabsKbIds: string[] | undefined;
      if (knowledgeBaseIds !== undefined) {
        if (knowledgeBaseIds.length > 0) {
          const kbItems = await Promise.all(
            knowledgeBaseIds.map((id: string) => storage.getKnowledgeBaseItem(id))
          );
          // Verify ownership and filter valid items
          elevenLabsKbIds = kbItems
            .filter(item => item && item.userId === req.userId && item.elevenLabsDocId)
            .map(item => item!.elevenLabsDocId!);

          logger.info(`📚 Filtered ${elevenLabsKbIds.length} valid knowledge base items from ${knowledgeBaseIds.length} selected`);
        } else {
          elevenLabsKbIds = [];
        }
      }

      // Update in database first - this ensures user changes are saved even if ElevenLabs is down
      const existingConfig = (agent.config ?? {}) as import('@shared/schema').AgentConfig;
      const updatedConfig: import('@shared/schema').AgentConfig = {
        ...existingConfig,
        ...(elevenLabsVoiceId && { elevenLabsVoiceId }),
        ...(model && { model }),
        ...(firstMessage !== undefined && { firstMessage }),
        ...(temperature !== undefined && { temperature }),
        ...(transferRules !== undefined && { transferRules }),
        ...(knowledgeBaseIds !== undefined && { knowledgeBaseIds }),
      };

      const updateData: Partial<any> = {
        ...(type && { type }),
        ...(name && { name }),
        ...(voiceTone !== undefined && { voiceTone }),
        ...(personality !== undefined && { personality }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(elevenLabsVoiceId && { elevenLabsVoiceId }),
        ...(language && { language }),
        ...(firstMessage !== undefined && { firstMessage }),
        ...(model && { llmModel: model }),
        ...(temperature !== undefined && { temperature }),
        ...(flowId !== undefined && { flowId }),
        ...(maxDurationSeconds !== undefined && { maxDurationSeconds }),
        ...(voiceStability !== undefined && { voiceStability }),
        ...(voiceSimilarityBoost !== undefined && { voiceSimilarityBoost }),
        ...(voiceSpeed !== undefined && { voiceSpeed }),
        ...(detectLanguageEnabled !== undefined && { detectLanguageEnabled }),
        config: updatedConfig,
      };

      await storage.updateAgent(req.params.id, updateData);

      // Get the agent type (either updated or existing)
      const agentType = type || agent.type || 'natural';

      // Try to sync with ElevenLabs with retry logic
      if (agentType === 'natural' && agent.elevenLabsAgentId && (name || systemPrompt || elevenLabsVoiceId || language || model || firstMessage || temperature !== undefined || voiceTone || personality || tools || elevenLabsKbIds !== undefined)) {
        // Natural Agent: Sync properties
        const effectiveLanguage4 = language || agent.language;
        const isNonEnglish4 = effectiveLanguage4 && effectiveLanguage4 !== 'en';

        // Smart TTS model selection for non-English agents
        let adminTtsModel4: string | undefined;
        if (isNonEnglish4) {
          const ttsModelSetting4 = await storage.getGlobalSetting('default_tts_model');
          adminTtsModel4 = (ttsModelSetting4?.value as string) || 'eleven_multilingual_v2';
        }

        // Resolve and sanitize LLM model ID
        let resolvedModelId = model;
        if (model) {
          const modelRecord = await db
            .select({ modelId: llmModels.modelId })
            .from(llmModels)
            .where(eq(llmModels.name, model))
            .limit(1);

          resolvedModelId = modelRecord.length > 0 ? modelRecord[0].modelId : model;
          resolvedModelId = sanitizeLlmModel(resolvedModelId);
          logger.info(`📝 Natural agent ElevenLabs sync - LLM model: ${resolvedModelId}`);
        }

        // Build update payload - no double spreading
        const updatePayload: any = {
          ...(name && { name }),
          ...(systemPrompt && { prompt: systemPrompt }),
          ...(elevenLabsVoiceId && { voice_id: elevenLabsVoiceId }),
          ...(resolvedModelId && { model: resolvedModelId }),
          ...(firstMessage && { first_message: firstMessage }),
          ...(temperature !== undefined && { temperature }),
          ...(voiceTone && { voice_tone: voiceTone }),
          ...(personality && { personality }),
          ...(tools && { tools }),
          ...(elevenLabsKbIds !== undefined && { knowledge_base_ids: elevenLabsKbIds }),
        };

        // For non-English agents: ALWAYS include language and TTS model
        // For English agents changing language: include the new language
        if (isNonEnglish4) {
          updatePayload.language = effectiveLanguage4;
          updatePayload.tts_model = adminTtsModel4;
        } else if (language) {
          updatePayload.language = language;
        }

        // Retry logic: 3 attempts with exponential backoff
        let lastError: any = null;
        const maxRetries = 3;
        const delays = [0, 1000, 2000]; // 0ms, 1s, 2s

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              logger.info(`🔄 Retry attempt ${attempt + 1}/${maxRetries} for ElevenLabs sync...`);
              await new Promise(resolve => setTimeout(resolve, delays[attempt]));
            }

            await elevenLabsService.updateAgent(agent.elevenLabsAgentId!, updatePayload);
            logger.info("✅ ElevenLabs agent synced successfully");
            break; // Success - exit retry loop
          } catch (error: any) {
            lastError = error;
            logger.warn(`⚠️ Attempt ${attempt + 1}/${maxRetries} failed:`, error.message);

            // If this was the last attempt, return with warning
            if (attempt === maxRetries - 1) {
              logger.error("❌ All retry attempts failed. Changes saved locally only.");
              return res.json({
                success: true,
                warning: "Agent updated locally. ElevenLabs sync failed after 3 attempts. Please try editing again later."
              });
            }
          }
        }
      } else if (agentType === 'flow' && agent.elevenLabsAgentId && (flowId !== undefined || maxDurationSeconds !== undefined || detectLanguageEnabled !== undefined || elevenLabsVoiceId || name || language || model || temperature !== undefined)) {
        // Flow Agent: Sync workflow when flowId, maxDuration, language detection, voice, or other settings change
        logger.info(`🔄 Syncing Flow Agent: ${agent.elevenLabsAgentId}`);

        // Get the flow to compile (use new flowId if provided, otherwise use existing)
        const flowToUse = flowId || agent.flowId;

        if (flowToUse) {
          try {
            // Fetch the flow from database
            const [flow] = await db
              .select()
              .from(flows)
              .where(and(eq(flows.id, flowToUse), eq(flows.userId, req.userId!)));

            if (flow) {
              // Compile the flow to ElevenLabs workflow format
              const compiler = new ElevenLabsFlowCompiler(
                flow.nodes as FlowNode[],
                flow.edges as FlowEdge[]
              );
              const compileResult = compiler.compile();
              const compiledWorkflow = compileResult.workflow;
              const flowFirstMessage = compileResult.firstMessage;

              logger.info(`📋 Recompiled flow: ${flow.name} with ${Object.keys(compiledWorkflow.nodes).length} nodes`);
              if (flowFirstMessage) {
                logger.info(`📝 First message from flow: "${flowFirstMessage.substring(0, 50)}..."`);
              }

              // For Flow agents, prioritize the flow's extracted first message over agent's stored value
              const effectiveFirstMessage5 = flowFirstMessage || firstMessage;

              // Determine effective language and TTS model for non-English agents
              const effectiveLanguage5 = language || agent.language;
              const isNonEnglish5 = effectiveLanguage5 && effectiveLanguage5 !== 'en';

              // Smart TTS model selection for non-English agents
              let adminTtsModel5: string | undefined;
              if (isNonEnglish5) {
                const ttsModelSetting5 = await storage.getGlobalSetting('default_tts_model');
                adminTtsModel5 = (ttsModelSetting5?.value as string) || 'eleven_multilingual_v2';
              }

              // Resolve LLM model if provided
              let effectiveLlmModel5: string | undefined;
              if (model) {
                const { llmModels } = await import("@shared/schema");
                const modelRecord = await db
                  .select({ modelId: llmModels.modelId })
                  .from(llmModels)
                  .where(eq(llmModels.name, model))
                  .limit(1);

                effectiveLlmModel5 = modelRecord.length > 0 ? modelRecord[0].modelId : model;

                // Sanitize the model ID for ElevenLabs compatibility
                effectiveLlmModel5 = sanitizeLlmModel(effectiveLlmModel5);

                logger.info(`📝 Flow agent ElevenLabs sync - LLM model: ${effectiveLlmModel5}`);
              }

              const strictWorkflowPrompt5 = `You are a call agent that must strictly follow a predefined workflow.

RULES:
1. Say EXACTLY what each workflow node instructs you to say.
2. Do NOT add extra words, greetings, questions, or small talk unless specifically written.
3. After speaking a node message, STOP and wait for the user's response.
4. Move to the next workflow node only based on the workflow edge rules.
5. If the user asks a question outside the workflow, use the ask_knowledge tool to respond briefly and accurately — then return to the workflow.
6. If the user asks to speak with a human (e.g. "connect me", "transfer", "agent", "representative"), immediately trigger the transfer.
7. Do NOT improvise or generate random speech.
8. NEVER override instructions from workflow nodes.
9. IGNORE any background noise, side conversations, or ambient speech that is not directed at you. Only respond to the primary speaker who is directly addressing you on the call.
10. If you hear unrelated words or topics from the background environment, do NOT change the conversation topic or respond to them. Stay on your current workflow step.

When using a tool:
- Do not announce you are using a tool.
- Do not say "invoking tool" or similar.
- Only say a short acknowledgment if needed (e.g. "Let me check that for you.")`;

              const userCustomPrompt5 = systemPrompt || agent.systemPrompt;
              const basePrompt5 = userCustomPrompt5
                ? `${strictWorkflowPrompt5}\n\n--- ADDITIONAL AGENT INSTRUCTIONS (provided by the agent creator) ---\nThe following instructions define your persona, domain, and behavioral constraints. You MUST follow these AT ALL TIMES, even while executing the workflow:\n\n${userCustomPrompt5}\n\n--- END OF ADDITIONAL INSTRUCTIONS ---\nRemember: Follow BOTH the workflow steps AND the additional instructions above. Never deviate from your assigned domain or persona.`
                : strictWorkflowPrompt5;

              // Update the ElevenLabs agent with new workflow and TTS config
              await elevenLabsService.updateFlowAgentWorkflow(
                agent.elevenLabsAgentId,
                compiledWorkflow,
                maxDurationSeconds ?? (agent.maxDurationSeconds || 600),
                detectLanguageEnabled !== undefined ? detectLanguageEnabled : (agent.detectLanguageEnabled || false),
                isNonEnglish5 ? effectiveLanguage5 : undefined,  // Pass language for non-English
                isNonEnglish5 ? adminTtsModel5 : undefined,  // Pass TTS model for non-English
                effectiveLlmModel5,  // Pass LLM model if provided
                temperature,  // Pass temperature if provided
                effectiveFirstMessage5,  // Pass first message extracted from flow
                elevenLabsVoiceId,  // Pass voice ID if provided
                { basePrompt: basePrompt5 }
              );

              logger.info("✅ Flow Agent workflow synced successfully");
            } else {
              logger.warn(`⚠️ Flow not found for sync: ${flowToUse}`);
            }
          } catch (error: any) {
            logger.error("❌ Flow Agent sync failed:", error.message);
            return res.json({
              success: true,
              warning: "Agent updated locally. ElevenLabs workflow sync failed. Please try editing again later."
            });
          }
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      logger.error("Update agent error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to update agent") });
    }
  });

  app.delete("/api/elevenlabs/agents/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Delete from ElevenLabs if exists
      if (agent.elevenLabsAgentId) {
        try {
          await elevenLabsService.deleteAgent(agent.elevenLabsAgentId);
        } catch (error) {
          logger.error("Failed to delete from ElevenLabs:", error);
        }
      }

      // Decrement the assigned agents count for the credential
      if (agent.elevenLabsCredentialId) {
        try {
          await ElevenLabsPoolService.updateAssignmentCount(agent.elevenLabsCredentialId, false);
          logger.info(`📊 [Agent Delete] Decremented agent count for credential [redacted]`);
        } catch (countError) {
          logger.warn("Failed to update credential agent count:", countError);
        }
      }

      // Delete from database
      await storage.deleteAgent(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete agent error:", error);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  // Test endpoint to add call transfer to an agent
  // Note: Flow agents should NOT use this endpoint - they have transfer nodes in their visual flow
  app.post("/api/elevenlabs/agents/:id/configure-transfer", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Reject Flow agents - they should use transfer nodes in the flow builder instead
      if (agent.type === 'flow') {
        return res.status(400).json({
          error: "Flow agents cannot use this endpoint. Use the Transfer node in your flow instead."
        });
      }

      const { transferNumber, condition, customerMessage, operatorMessage } = req.body;

      if (!transferNumber) {
        return res.status(400).json({ error: "Transfer number is required" });
      }

      let transferTypeForRules: "conference" | "sip_refer" = "conference";
      let sipTrunkAddress: string | null = null;
      try {
        if (await isAgentOnSipPhoneNumber(req.params.id)) {
          transferTypeForRules = "sip_refer";
          sipTrunkAddress = await getSipTrunkOutboundAddress(req.params.id);
          logger.info(`   📞 [Transfer Config] SIP agent detected - using sip_refer transfer type (trunk: ${sipTrunkAddress})`);
        }
      } catch (err: any) { logger.warn('SIP trunk check failed during transfer config; using conference transfer', { agentId: req.params.id, error: err?.message }, 'Routes'); }

      let numberType: "phone" | "sip_uri" = "phone";
      let destination = transferNumber;
      if (transferTypeForRules === "sip_refer" && sipTrunkAddress) {
        numberType = "sip_uri";
        const phoneNum = transferNumber.startsWith('+') ? transferNumber : `+${transferNumber}`;
        destination = `sip:${phoneNum}@${sipTrunkAddress}`;
        logger.info(`   📞 [Transfer Config] SIP REFER: [redacted] → ${destination}`);
      }

      const transferRules = [{
        transfer_type: transferTypeForRules,
        number_type: numberType,
        destination: destination,
        condition: condition || "User explicitly requests to speak to a human or customer care representative",
        customer_message: customerMessage || "Please hold while I transfer you to our support team",
        operator_message: operatorMessage || "Customer needs assistance",
      }];

      const tools = [{
        type: "transfer_to_number" as const,
        description: "Transfer user to human support when needed",
        transfer_rules: transferRules,
      }];

      // Update in ElevenLabs
      if (agent.elevenLabsAgentId) {
        await elevenLabsService.updateAgent(agent.elevenLabsAgentId, { tools });
        logger.info(`✅ Call transfer configured for agent ${agent.name} (${agent.elevenLabsAgentId})`);
      }

      // Update in database
      const existingConfig = (agent.config ?? {}) as import('@shared/schema').AgentConfig;
      const updatedConfig: import('@shared/schema').AgentConfig = {
        ...existingConfig,
        transferRules,
      };

      await storage.updateAgent(req.params.id, { config: updatedConfig });

      res.json({
        success: true,
        message: `Call transfer configured successfully. The AI will now transfer calls to ${transferNumber} when appropriate.`
      });
    } catch (error: any) {
      logger.error("Configure transfer error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to configure call transfer") });
    }
  });
}
