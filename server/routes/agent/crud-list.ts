/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */

/** Agent routes: agent list and create routes. Split from server/routes/agent-routes.ts (issue #17). Paths and handlers are unchanged. */
import { Router, Request, Response } from "express";
import { RouteContext, AuthRequest } from "../common";
import { eq, and, sql } from "drizzle-orm";
import { llmModels, flows, FlowNode, FlowEdge, knowledgeBase } from "@shared/schema";
import { ElevenLabsService, isAgentOnSipPhoneNumber, getSipTrunkOutboundAddress } from "../../services/elevenlabs";
import { sanitizeLlmModel } from "../../utils/llm-sanitize";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { OpenAIPoolService } from "../../engines/plivo/services/openai-pool.service";
import { IncomingAgentService } from "../../services/incoming-agent";
import { FlowAgentService } from "../../services/flow-agent";
import { setupRAGToolForAgent, isRAGEnabled } from "../../services/rag-elevenlabs-tool";
import { logger } from "../../utils/logger";
import { fetchWhatsappTemplateNames } from "./whatsapp-templates";

export function registerAgentCrudListRoutes(router: Router, ctx: RouteContext): void {
  const { db, storage, authenticateHybrid, elevenLabsService } = ctx;
  // Agent CRUD Routes
  // ========================================

  router.get("/api/agents", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      let agents = await storage.getUserAgents(req.userId!);

      const typeFilter = req.query.type as string | undefined;
      if (typeFilter && (typeFilter === 'incoming' || typeFilter === 'flow')) {
        agents = agents.filter(agent => agent.type === typeFilter);
      }

      // Query and append Custom Voice Engine agents
      let veAgents: any[] = [];
      try {
        const veAgentsResult = await db.execute(sql`
          SELECT * FROM ve_voice_agents WHERE user_id = ${req.userId!} ORDER BY created_at DESC
        `);
        veAgents = (veAgentsResult.rows as any[]).map(veAgent => ({
          id: veAgent.id,
          userId: veAgent.user_id,
          name: veAgent.name,
          // Set type dynamically to match filters, enabling use as both incoming and flow
          type: typeFilter || 'incoming',
          telephonyProvider: 'custom-voice-engine',
          systemPrompt: veAgent.system_prompt,
          firstMessage: veAgent.first_message,
          language: veAgent.language,
          llmModel: veAgent.llm_model,
          temperature: veAgent.temperature,
          openaiVoice: veAgent.tts_voice,
          ttsProvider: veAgent.tts_provider,
          sttProvider: veAgent.stt_provider,
          ttsModel: veAgent.tts_model,
          sttModel: veAgent.stt_model,
          maxDurationSeconds: veAgent.max_duration_seconds,
          isActive: veAgent.is_active,
          createdAt: veAgent.created_at,
          updatedAt: veAgent.updated_at,
          elevenLabsCredentialId: null,
          sipTrunkId: null,
          sipPhoneNumberId: null,
          openaiCredentialId: null,
          transferPhoneNumber: veAgent.transfer_phone_number || null,
          transferEnabled: veAgent.transfer_enabled || false,
          detectLanguageEnabled: veAgent.detect_language_enabled || false,
          endConversationEnabled: veAgent.end_conversation_enabled || false,
          appointmentBookingEnabled: veAgent.appointment_booking_enabled || false,
          messagingEmailEnabled: veAgent.messaging_email_enabled || false,
          messagingWhatsappEnabled: veAgent.messaging_whatsapp_enabled || false,
          messagingEmailTemplate: veAgent.messaging_email_template || null,
          messagingWhatsappTemplate: veAgent.messaging_whatsapp_template || null,
          messagingWhatsappVariables: null,
          expressiveMode: false,
          knowledgeBaseIds: veAgent.knowledge_base_ids || null,
          elevenLabsVoiceId: null,
          voiceStability: 0.65,
          voiceSimilarityBoost: 0.85,
          voiceSpeed: 0.92,
          turnTimeout: 1.5,
          flowId: null,
          agentLink: null,
          config: {
            ttsProvider: veAgent.tts_provider,
            sttProvider: veAgent.stt_provider,
            ttsModel: veAgent.tts_model,
            sttModel: veAgent.stt_model,
            interruptible: veAgent.interruptible,
            silenceTimeoutMs: veAgent.silence_timeout_ms,
            endCallOnSilence: veAgent.end_call_on_silence,
            businessRules: veAgent.business_rules,
            enabledTools: veAgent.enabled_tools,
            enableMemory: veAgent.enable_memory,
            memoryRetentionDays: veAgent.memory_retention_days,
          },
        }));
      } catch (err) {
        logger.error("Error querying ve_voice_agents for user:", err);
      }

      res.json([...agents, ...veAgents]);
    } catch (error: any) {
      logger.error("Get agents error:", error);
      res.status(500).json({ error: "Failed to get agents" });
    }
  });

  router.post("/api/agents", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const {
        type,
        name,
        voiceTone,
        personality,
        systemPrompt,
        config,
        elevenLabsVoiceId,
        firstMessage,
        language,
        llmModel,
        temperature,
        knowledgeBaseIds,
        transferEnabled,
        transferPhoneNumber,
        transferMessage,
        detectLanguageEnabled,
        endConversationEnabled,
        appointmentBookingEnabled,
        messagingEmailEnabled,
        messagingWhatsappEnabled,
        messagingEmailTemplate,
        messagingWhatsappTemplate,
        messagingWhatsappVariables,
        expressiveMode,
        voiceStability,
        voiceSimilarityBoost,
        voiceSpeed,
        turnTimeout,
        telephonyProvider,
        openaiVoice
      } = req.body;

      if (!type || (type !== 'incoming' && type !== 'flow')) {
        return res.status(400).json({ error: "Valid agent type is required (incoming or flow)" });
      }

      if (!name) {
        return res.status(400).json({ error: "Agent name is required" });
      }

      if (type === 'incoming' && !systemPrompt) {
        return res.status(400).json({ error: "System prompt is required for incoming agents" });
      }

      if (type === 'flow' && (!voiceTone || !personality)) {
        return res.status(400).json({ error: "Voice tone and personality are required for flow agents" });
      }

      // Voice validation depends on telephony provider
      // OpenAI-based providers (plivo, twilio_openai, openai-sip) use OpenAI voices, not ElevenLabs
      // SIP providers (elevenlabs-sip, openai-sip) need special handling
      const isOpenAIProvider = telephonyProvider === 'plivo' || telephonyProvider === 'twilio_openai' || telephonyProvider === 'openai-sip';
      const isSipProvider = telephonyProvider === 'elevenlabs-sip' || telephonyProvider === 'openai-sip';
      const isCustomVoiceEngine = telephonyProvider === 'custom-voice-engine';

      if (type === 'incoming') {
        if (isCustomVoiceEngine) {
          logger.info(`📞 Creating Custom Voice Engine agent with voice: ${openaiVoice || 'aura-asteria-en'}`);
        } else if (isOpenAIProvider) {
          // OpenAI-based agents use OpenAI voices - openaiVoice has a default in schema ('alloy')
          // No validation needed as schema provides default
          logger.info(`📞 Creating ${telephonyProvider} agent with OpenAI voice: ${openaiVoice || 'alloy'}`);
        } else {
          // Twilio/ElevenLabs agents require elevenLabsVoiceId
          if (!elevenLabsVoiceId) {
            return res.status(400).json({ error: "Voice ID is required for incoming agents" });
          }
        }
      }

      if (type === 'incoming' && transferEnabled && !transferPhoneNumber?.trim()) {
        return res.status(400).json({ error: "Transfer phone number is required when call transfer is enabled" });
      }

      // Sanitize sipPhoneNumberId: convert empty string to null to avoid foreign key constraint violation
      if ('sipPhoneNumberId' in req.body && req.body.sipPhoneNumberId === '') {
        req.body.sipPhoneNumberId = null;
      }

      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      const existingAgents = await storage.getUserAgents(req.userId!);
      // Skip limit check if explicitly unlimited (-1 or 999)
      if (plan.maxAgents !== -1 && plan.maxAgents !== 999 && existingAgents.length >= plan.maxAgents) {
        return res.status(403).json({
          error: `Agent limit reached. Your ${plan.displayName} allows maximum ${plan.maxAgents} agent(s).`,
          upgradeRequired: true
        });
      }

      if (llmModel) {
        const { getUserPlanCapabilities } = await import('../../services/membership-service');
        const capabilities = await getUserPlanCapabilities(req.userId!);

        if (!capabilities.canChooseLlm) {
          const { or } = await import('drizzle-orm');
          const requestedModel = await db
            .select({ tier: llmModels.tier })
            .from(llmModels)
            .where(or(eq(llmModels.name, llmModel), eq(llmModels.modelId, llmModel)))
            .limit(1);

          const modelTier = requestedModel.length > 0 ? requestedModel[0].tier : null;

          if (modelTier && modelTier !== 'free') {
            return res.status(403).json({
              error: "Plan upgrade required",
              message: `Your ${capabilities.planDisplayName} plan only allows free-tier LLM models. Please upgrade to Pro to use premium models.`,
              upgradeRequired: true
            });
          }
        }
      }

      let elevenLabsAgentId = null;
      let effectiveLlmModelId: string | null = "gpt-4o-mini";

      if (llmModel) {
        const modelRecord = await db
          .select({ modelId: llmModels.modelId })
          .from(llmModels)
          .where(eq(llmModels.name, llmModel))
          .limit(1);

        if (modelRecord.length > 0) {
          effectiveLlmModelId = modelRecord[0].modelId;
          logger.info(`📝 Using user-selected LLM model: ${llmModel} → ${effectiveLlmModelId}`);
        } else {
          effectiveLlmModelId = llmModel;
          logger.info(`📝 Using user-provided LLM model ID: ${effectiveLlmModelId}`);
        }

        // Sanitize the model ID for ElevenLabs compatibility
        effectiveLlmModelId = sanitizeLlmModel(effectiveLlmModelId!);
      } else {
        const defaultSetting = await storage.getGlobalSetting('default_llm_free');
        if (defaultSetting?.value) {
          const displayName = String(defaultSetting.value).replace(/^"|"$/g, '');
          logger.info(`📝 Admin default LLM display name: ${displayName}`);

          const modelRecord = await db
            .select({ modelId: llmModels.modelId })
            .from(llmModels)
            .where(eq(llmModels.name, displayName))
            .limit(1);

          if (modelRecord.length > 0) {
            effectiveLlmModelId = modelRecord[0].modelId;
            logger.info(`📝 Resolved to model ID: ${effectiveLlmModelId}`);
          } else {
            logger.warn(`⚠️  Could not find model for "${displayName}", using default: ${effectiveLlmModelId}`);
          }
        }
      }

      // Validate that the model is a conversational model, not a transcription model
      // Transcription models like "scribe_v2_realtime" are not valid for ElevenLabs Conversational AI
      const INVALID_TRANSCRIPTION_MODELS = ['scribe_v2_realtime', 'scribe_v2', 'scribe'];
      if (effectiveLlmModelId && INVALID_TRANSCRIPTION_MODELS.some(m => effectiveLlmModelId!.toLowerCase().includes(m))) {
        return res.status(400).json({
          error: "Invalid LLM model for conversational agents",
          message: "Scribe models are designed for transcription, not conversational AI. Please select a different LLM model such as GPT-4o Mini, Claude 3, or Gemini."
        });
      }

      let usedCredentialId: string | null = null;

      // Only create ElevenLabs agent for Twilio-based incoming agents (not OpenAI providers)
      if (type === 'incoming' && !isOpenAIProvider) {
        const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);
        if (!credential) {
          return res.status(500).json({ error: "No available ElevenLabs API keys" });
        }
        usedCredentialId = credential.id;

        try {
          const knowledgeBases: Array<{ type: string; title: string; elevenLabsDocId: string }> = [];
          if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length > 0) {
            logger.info(`📚 Preparing ${knowledgeBaseIds.length} knowledge base(s) for agent creation`);

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
                knowledgeBases.push({
                  type: kbItem.type,
                  title: kbItem.title,
                  elevenLabsDocId: kbItem.elevenLabsDocId
                });
              } catch (error: any) {
                logger.error(`   ❌ Failed to fetch KB ${kbId}:`, error.message);
              }
            }
          }

          const incomingElevenLabsService = new ElevenLabsService(credential.apiKey);

          const agentResponse = await incomingElevenLabsService.createAgent({
            name,
            voice_id: elevenLabsVoiceId,
            prompt: systemPrompt,
            first_message: firstMessage || "Hello! How can I help you today?",
            language: language || "en",
            model: effectiveLlmModelId!,
            temperature: temperature || 0.5,
            personality: personality || "helpful",
            voice_tone: voiceTone || "professional",
            knowledge_bases: knowledgeBases.length > 0 ? knowledgeBases : undefined,
            transferEnabled: transferEnabled || false,
            transferPhoneNumber: transferPhoneNumber || undefined,
            detectLanguageEnabled: detectLanguageEnabled || false,
            endConversationEnabled: endConversationEnabled || false,
            suggestedAudioTags: expressiveMode || false,
            voiceStability: voiceStability ?? 0.65,
            voiceSimilarityBoost: voiceSimilarityBoost ?? 0.85,
            voiceSpeed: voiceSpeed ?? 0.92,
            turnTimeout: turnTimeout ?? 1.5,
            skipWorkflow: true,
          });

          elevenLabsAgentId = agentResponse.agent_id;
        } catch (error) {
          logger.error("Error creating ElevenLabs agent:", error);
          return res.status(500).json({ error: "Failed to create ElevenLabs agent" });
        }
      }

      // Log OpenAI-based agent creation
      if (type === 'incoming' && isOpenAIProvider) {
        logger.info(`📞 [${telephonyProvider} Agent Create] Creating ${telephonyProvider} agent "${name}" with OpenAI voice: ${openaiVoice || 'alloy'}`);
      }

      if (type === 'flow') {
        const { flowId, maxDurationSeconds } = req.body;

        if (!flowId) {
          return res.status(400).json({ error: "Flow ID is required for flow agents" });
        }

        // Voice validation depends on telephony provider for flow agents
        if (isCustomVoiceEngine) {
          logger.info(`📞 [Flow Agent Create] Creating Custom Voice Engine flow agent with voice: ${openaiVoice || 'aura-asteria-en'}`);
        } else if (isOpenAIProvider) {
          // OpenAI-based flow agents use OpenAI voices - openaiVoice has a default in schema ('alloy')
          logger.info(`📞 [Flow Agent Create] Creating ${telephonyProvider} flow agent with OpenAI voice: ${openaiVoice || 'alloy'}`);
        } else {
          // ElevenLabs/Twilio flow agents require elevenLabsVoiceId
          if (!elevenLabsVoiceId) {
            return res.status(400).json({ error: "Voice ID is required for flow agents" });
          }
        }

        const [flow] = await db
          .select()
          .from(flows)
          .where(eq(flows.id, flowId));

        if (!flow) {
          return res.status(404).json({ error: "Selected flow not found" });
        }

        // For OpenAI-based flow agents (Plivo or Twilio+OpenAI) or Custom Voice Engine, skip ElevenLabs agent creation
        // These flow agents will use OpenAI Realtime API or custom websocket server directly during calls
        if (isOpenAIProvider || isCustomVoiceEngine) {
          logger.info(`📞 [Flow Agent Create] Skipping ElevenLabs agent creation for ${telephonyProvider} flow agent`);
          // elevenLabsAgentId remains null for OpenAI-based and Custom Voice Engine flow agents
        } else {
          // ElevenLabs/Twilio flow agents - delegate to FlowAgentService for proper two-phase creation
          // This handles play audio nodes, appointment nodes, form nodes, and webhook tools correctly
          try {
            const result = await FlowAgentService.createInElevenLabs({
              userId: req.userId!,
              name,
              flowId,
              elevenLabsVoiceId: elevenLabsVoiceId!,
              systemPrompt: systemPrompt || undefined,
              firstMessage: firstMessage || undefined,
              language: language || 'en',
              llmModel: effectiveLlmModelId || undefined,
              temperature: temperature ?? 0.3,
              maxDurationSeconds: maxDurationSeconds || 600,
              voiceStability: voiceStability ?? 0.65,
              voiceSimilarityBoost: voiceSimilarityBoost ?? 0.85,
              voiceSpeed: voiceSpeed ?? 0.92,
              turnTimeout: turnTimeout ?? 1.5,
              detectLanguageEnabled: detectLanguageEnabled || false,
              expressiveMode: expressiveMode || false,
              knowledgeBaseIds: knowledgeBaseIds || undefined,
            });

            elevenLabsAgentId = result.elevenLabsAgentId;
            usedCredentialId = result.credentialId;
            logger.info(`✅ [Flow Agent Create] ElevenLabs agent created via FlowAgentService: ${elevenLabsAgentId}`);
          } catch (error: any) {
            logger.error("Error creating ElevenLabs Flow agent:", error);
            const statusCode = error.status || 500;
            return res.status(statusCode).json({
              error: "Failed to create ElevenLabs Flow agent",
              code: error.code || 'INTERNAL_ERROR'
            });
          }
        } // End of else block for non-OpenAI providers
      }

      const { flowId, maxDurationSeconds } = req.body;

      const agent = await storage.createAgent({
        userId: req.userId!,
        type,
        name,
        voiceTone: voiceTone || null,
        personality: personality || null,
        systemPrompt,
        config: config || null,
        elevenLabsAgentId,
        elevenLabsCredentialId: usedCredentialId,
        elevenLabsVoiceId: (type === 'incoming' || type === 'flow') ? elevenLabsVoiceId : null,
        firstMessage: (type === 'incoming' || type === 'flow') ? (firstMessage || null) : null,
        language: (type === 'incoming' || type === 'flow') ? (language || null) : null,
        llmModel: (type === 'incoming' || type === 'flow') ? effectiveLlmModelId : null,
        temperature: (type === 'incoming' || type === 'flow') ? (temperature ?? null) : null,
        knowledgeBaseIds: (type === 'incoming' || type === 'flow') ? (knowledgeBaseIds || null) : null,
        transferEnabled: type === 'incoming' ? (transferEnabled || false) : false,
        transferPhoneNumber: type === 'incoming' ? (transferPhoneNumber || null) : null,
        detectLanguageEnabled: (type === 'incoming' || type === 'flow') ? (detectLanguageEnabled || false) : false,
        endConversationEnabled: type === 'incoming' ? (endConversationEnabled || false) : false,
        appointmentBookingEnabled: type === 'incoming' ? (appointmentBookingEnabled || false) : false,
        messagingEmailEnabled: (type === 'incoming' || type === 'flow') ? (messagingEmailEnabled || false) : false,
        messagingWhatsappEnabled: (type === 'incoming' || type === 'flow') ? (messagingWhatsappEnabled || false) : false,
        messagingEmailTemplate: (type === 'incoming' || type === 'flow') ? (messagingEmailTemplate || null) : null,
        messagingWhatsappTemplate: (type === 'incoming' || type === 'flow') ? (messagingWhatsappTemplate || null) : null,
        messagingWhatsappVariables: (type === 'incoming' || type === 'flow') ? (messagingWhatsappVariables || null) : null,
        expressiveMode: (type === 'incoming' || type === 'flow') ? (expressiveMode || false) : false,
        flowId: type === 'flow' ? flowId : null,
        maxDurationSeconds: type === 'flow' ? (maxDurationSeconds || 600) : null,
        voiceStability: (type === 'incoming' || type === 'flow') ? (voiceStability ?? 0.65) : null,
        voiceSimilarityBoost: (type === 'incoming' || type === 'flow') ? (voiceSimilarityBoost ?? 0.85) : null,
        voiceSpeed: (type === 'incoming' || type === 'flow') ? (voiceSpeed ?? 0.92) : null,
        turnTimeout: (type === 'incoming' || type === 'flow') ? (turnTimeout ?? 1.5) : null,
        // Telephony provider: preserve SIP providers, OpenAI providers, Custom Voice Engine, otherwise default to twilio
        telephonyProvider: (isSipProvider || isOpenAIProvider || isCustomVoiceEngine) ? telephonyProvider : 'twilio',
        openaiVoice: isCustomVoiceEngine ? (openaiVoice || 'aura-asteria-en') : (isOpenAIProvider ? (openaiVoice || 'alloy') : null),
      });

      if (usedCredentialId) {
        try {
          await ElevenLabsPoolService.updateAssignmentCount(usedCredentialId, true);
          logger.info(`📊 [Agent Create] Incremented agent count for credential ${usedCredentialId}`);
        } catch (countError) {
          logger.warn("Failed to update credential agent count:", countError);
        }
      }

      if (type === 'flow' && flowId) {
        try {
          await db
            .update(flows)
            .set({ agentId: agent.id })
            .where(eq(flows.id, flowId));
          logger.info(`✅ [Flow Agent Create] Flow ${flowId} now references agent ${agent.id}`);

          await ElevenLabsPoolService.syncExistingAgents();
        } catch (poolError) {
          logger.warn("Failed to update flow or sync agent to pool:", poolError);
        }
      }

      if (type === 'incoming') {
        try {
          await ElevenLabsPoolService.syncExistingAgents();
        } catch (poolError) {
          logger.warn("Failed to sync incoming agent to pool:", poolError);
        }
      }

      let updatedAgent = agent;

      // If appointment booking is enabled for incoming agents, update ElevenLabs with the tool
      // The webhook URL uses the ElevenLabs agent ID which is available at this point
      if (type === 'incoming' && appointmentBookingEnabled && elevenLabsAgentId && usedCredentialId) {
        try {
          logger.info(`📅 [Agent Create] Adding appointment booking tool for ElevenLabs agent ${elevenLabsAgentId}`);
          const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
          if (credential) {
            const appointmentElevenLabsService = new ElevenLabsService(credential.apiKey);
            await appointmentElevenLabsService.updateAgent(elevenLabsAgentId, {
              appointmentBookingEnabled: true,
              transferEnabled: transferEnabled || false,
              transferPhoneNumber: transferPhoneNumber || undefined,
              detectLanguageEnabled: detectLanguageEnabled || false,
              endConversationEnabled: endConversationEnabled || false,
              databaseAgentId: agent.id,
              skipWorkflowRebuild: true,
            });
            logger.info(`✅ [Agent Create] Appointment booking tool added (with system tools preserved)`);
          }
        } catch (appointmentError) {
          logger.warn("Failed to add appointment booking tool (non-fatal):", appointmentError);
        }
      }

      if (type === 'incoming' && (messagingEmailEnabled || messagingWhatsappEnabled) && elevenLabsAgentId && usedCredentialId) {
        try {
          logger.info(`📨 [Agent Create] Adding messaging tools for ElevenLabs agent ${elevenLabsAgentId}`);

          let whatsappTemplateNames: string[] = [];
          if (messagingWhatsappEnabled) {
            whatsappTemplateNames = await fetchWhatsappTemplateNames(req.userId!);
          }

          const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
          if (credential) {
            const messagingElevenLabsService = new ElevenLabsService(credential.apiKey);
            await messagingElevenLabsService.updateAgent(elevenLabsAgentId, {
              messagingEmailEnabled: messagingEmailEnabled || false,
              messagingWhatsappEnabled: messagingWhatsappEnabled || false,
              messagingWhatsappTemplates: whatsappTemplateNames,
              messagingEmailSelectedTemplate: messagingEmailTemplate || undefined,
              messagingWhatsappSelectedTemplate: messagingWhatsappTemplate || undefined,
              messagingWhatsappVariables: messagingWhatsappVariables || undefined,
              transferEnabled: transferEnabled || false,
              transferPhoneNumber: transferPhoneNumber || undefined,
              detectLanguageEnabled: detectLanguageEnabled || false,
              endConversationEnabled: endConversationEnabled || false,
              appointmentBookingEnabled: appointmentBookingEnabled || false,
              databaseAgentId: agent.id,
              skipWorkflowRebuild: true,
            });
            logger.info(`✅ [Agent Create] Messaging tools added`);
          }
        } catch (messagingError) {
          logger.warn("Failed to add messaging tools (non-fatal):", messagingError);
        }
      }

      if (elevenLabsAgentId && isRAGEnabled() && knowledgeBaseIds && knowledgeBaseIds.length > 0) {
        try {
          logger.info(`📚 [Agent Create] Setting up RAG workspace tool for agent ${agent.id}`);

          const systemTools: any[] = [];

          if (type === 'incoming') {
            if (transferEnabled && transferPhoneNumber) {
              let agentTransferType: "conference" | "sip_refer" = "conference";
              let sipTrunkAddress: string | null = null;
              try {
                if (await isAgentOnSipPhoneNumber(agent.id)) {
                  agentTransferType = "sip_refer";
                  sipTrunkAddress = await getSipTrunkOutboundAddress(agent.id);
                  logger.info(`   📞 [Agent Create] SIP agent detected - using sip_refer transfer type (trunk: ${sipTrunkAddress})`);
                }
              } catch (sipErr: any) {
                logger.warn('SIP trunk check failed during agent create; using conference transfer', { agentId: agent.id, error: sipErr?.message }, 'AgentRoutes');
              }

              let transferDestination: any;
              if (agentTransferType === "sip_refer" && sipTrunkAddress) {
                const phoneNum = transferPhoneNumber.startsWith('+') ? transferPhoneNumber : `+${transferPhoneNumber}`;
                const sipUri = `sip:${phoneNum}@${sipTrunkAddress}`;
                transferDestination = { type: "sip_uri", sip_uri: sipUri };
                logger.info(`   📞 [Agent Create] SIP REFER transfer configured`);
              } else {
                transferDestination = { type: "phone", phone_number: transferPhoneNumber };
              }

              systemTools.push({
                type: "system",
                name: "transfer_to_number",
                description: "Transfer the caller to a human agent when they request it or when you cannot handle their request.",
                params: {
                  system_tool_type: "transfer_to_number",
                  transfers: [
                    {
                      transfer_destination: transferDestination,
                      condition: "When the user asks to speak with a human or when the AI cannot handle the request.",
                      transfer_type: agentTransferType
                    }
                  ]
                }
              });
            }
            if (detectLanguageEnabled) {
              systemTools.push({
                type: "system",
                name: "language_detection",
                description: "Automatically detect and switch to the user's preferred language"
              });
            }
            if (endConversationEnabled) {
              systemTools.push({
                type: "system",
                name: "end_call",
                description: "End the call when the user is finished or says goodbye"
              });
            }
          }

          if (type === 'flow') {
            if (detectLanguageEnabled) {
              systemTools.push({
                type: "system",
                name: "language_detection",
                description: "Automatically detect and switch to the user's preferred language"
              });
            }
          }

          await setupRAGToolForAgent(
            elevenLabsAgentId,
            agent.id,
            knowledgeBaseIds && knowledgeBaseIds.length > 0,
            systemTools,
            type === 'incoming' ? (appointmentBookingEnabled || false) : false
          );
          logger.info(`✅ [Agent Create] RAG tool setup complete`);

          updatedAgent = await storage.getAgent(agent.id) || agent;
        } catch (ragError) {
          logger.warn("Failed to setup RAG tool (non-fatal):", ragError);
        }
      }

      if (elevenLabsVoiceId) {
        setImmediate(async () => {
          try {
            const { VoiceSyncService } = await import("../../services/voice-sync");

            if (elevenLabsVoiceId.startsWith('21m00') || elevenLabsVoiceId.length < 20) {
              logger.info(`🔊 Voice ${elevenLabsVoiceId} is a default voice, skipping sync`);
              return;
            }

            const agentCredential = usedCredentialId
              ? await ElevenLabsPoolService.getCredentialForAgent(agent.id)
              : null;
            const syncService = agentCredential
              ? new ElevenLabsService(agentCredential.apiKey)
              : elevenLabsService;

            const sharedVoices = await syncService.listSharedVoices({ search: '' });
            const matchingVoice = sharedVoices.voices.find(v => v.voice_id === elevenLabsVoiceId);

            if (matchingVoice?.public_owner_id) {
              logger.info(`🔊 Starting async voice sync for ${elevenLabsVoiceId} (${matchingVoice.name})`);
              const result = await VoiceSyncService.syncVoiceToAllCredentials(
                elevenLabsVoiceId,
                matchingVoice.public_owner_id,
                matchingVoice.name
              );
              logger.warn(`🔊 Voice sync complete: ${result.synced} synced, ${result.failed} failed`);
            } else {
              logger.warn(`🔊 Voice ${elevenLabsVoiceId} not found in shared library, skipping pool sync`);
            }
          } catch (syncError) {
            logger.warn(`⚠️ Async voice sync failed (non-fatal):`, syncError instanceof Error ? syncError.message : syncError);
          }
        });
      }

      res.json(updatedAgent);
    } catch (error: any) {
      logger.error("Create agent error:", error);
      res.status(500).json({ error: "Failed to create agent" });
    }
  });
}
