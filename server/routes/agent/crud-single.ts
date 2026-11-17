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

/** Agent routes: single agent get, update and delete routes. Split from server/routes/agent-routes.ts (issue #17). Paths and handlers are unchanged. */
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

export function registerAgentSingleRoutes(router: Router, ctx: RouteContext): void {
  const { db, storage, authenticateHybrid, elevenLabsService } = ctx;
  router.get("/api/agents/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      res.json(agent);
    } catch (error: any) {
      logger.error("Get agent error:", error);
      res.status(500).json({ error: "Failed to get agent" });
    }
  });

  router.patch("/api/agents/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (req.body.type && req.body.type !== agent.type) {
        return res.status(400).json({ error: "Cannot change agent type after creation" });
      }

      if (agent.type === 'incoming' && req.body.transferEnabled === true && !req.body.transferPhoneNumber?.trim()) {
        return res.status(400).json({ error: "Transfer phone number is required when call transfer is enabled" });
      }

      // Sanitize sipPhoneNumberId: convert empty string to null to avoid foreign key constraint violation
      if ('sipPhoneNumberId' in req.body && req.body.sipPhoneNumberId === '') {
        req.body.sipPhoneNumberId = null;
      }

      try {
        logger.info(`📝 [Version History] Agent update for ${agent.id} (${agent.type})`);
        logger.info(`   Request body keys: ${Object.keys(req.body).join(', ')}`);

        const latestVersion = await storage.getLatestAgentVersion(agent.id);
        const nextVersionNumber = (latestVersion?.versionNumber || 0) + 1;

        const currentSnapshot = {
          name: agent.name,
          type: agent.type,
          voiceTone: agent.voiceTone,
          personality: agent.personality,
          systemPrompt: agent.systemPrompt,
          language: agent.language,
          firstMessage: agent.firstMessage,
          llmModel: agent.llmModel,
          temperature: agent.temperature,
          elevenLabsVoiceId: agent.elevenLabsVoiceId,
          voiceStability: agent.voiceStability,
          voiceSimilarityBoost: agent.voiceSimilarityBoost,
          voiceSpeed: agent.voiceSpeed,
          transferPhoneNumber: agent.transferPhoneNumber,
          transferEnabled: agent.transferEnabled,
          detectLanguageEnabled: agent.detectLanguageEnabled,
          endConversationEnabled: agent.endConversationEnabled,
          knowledgeBaseIds: agent.knowledgeBaseIds,
          maxDurationSeconds: agent.maxDurationSeconds,
          config: agent.config as Record<string, unknown> | null,
        };

        const changedFields: string[] = [];
        const changeDescriptions: string[] = [];

        const fieldsToCheck = [
          'name', 'voiceTone', 'personality', 'systemPrompt', 'language',
          'firstMessage', 'llmModel', 'temperature', 'elevenLabsVoiceId',
          'voiceStability', 'voiceSimilarityBoost', 'voiceSpeed', 'turnTimeout',
          'transferPhoneNumber', 'transferEnabled', 'detectLanguageEnabled',
          'endConversationEnabled', 'knowledgeBaseIds', 'maxDurationSeconds',
          'flowId', 'config'
        ];

        for (const field of fieldsToCheck) {
          const reqValue = req.body[field];
          const agentValue = (agent as any)[field];

          if (reqValue !== undefined) {
            let hasChanged = false;

            if (field === 'config' || field === 'knowledgeBaseIds') {
              hasChanged = JSON.stringify(reqValue) !== JSON.stringify(agentValue);
            } else {
              hasChanged = reqValue !== agentValue;
            }

            if (hasChanged) {
              changedFields.push(field);
              if (field === 'systemPrompt' || field === 'firstMessage') {
                changeDescriptions.push(`Updated ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
              } else if (field === 'config') {
                changeDescriptions.push('Updated agent configuration');
              } else if (field === 'flowId') {
                changeDescriptions.push('Changed conversation flow');
              } else {
                changeDescriptions.push(`Changed ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
              }
            }
          }
        }

        if (changedFields.length > 0) {
          logger.info(`   ✅ Creating version ${nextVersionNumber}: ${changedFields.join(', ')}`);
          await storage.createAgentVersion({
            agentId: agent.id,
            versionNumber: nextVersionNumber,
            snapshot: currentSnapshot,
            changesSummary: changeDescriptions.join(', ') || 'Configuration updated',
            changedFields,
            editedBy: req.userId!,
            note: null,
          });
        } else {
          logger.info(`   ⏭️ No changes detected, skipping version creation`);
        }
      } catch (versionError) {
        logger.warn("Failed to create agent version:", versionError);
      }

      const {
        name,
        systemPrompt,
        elevenLabsVoiceId,
        language,
        llmModel,
        knowledgeBaseIds,
        transferEnabled,
        transferPhoneNumber,
        detectLanguageEnabled,
        endConversationEnabled,
        appointmentBookingEnabled,
        messagingEmailEnabled,
        messagingWhatsappEnabled,
        messagingEmailTemplate,
        messagingWhatsappTemplate,
        messagingWhatsappVariables,
        expressiveMode,
        flowId: newFlowId,
        maxDurationSeconds: newMaxDuration,
        voiceStability,
        voiceSimilarityBoost,
        voiceSpeed,
        turnTimeout
      } = req.body;

      if (llmModel && llmModel !== agent.llmModel) {
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

      if (agent.type === 'flow') {
        if (agent.elevenLabsAgentId) {
          try {
            await FlowAgentService.updateInElevenLabs(
              agent.id,
              agent.elevenLabsAgentId,
              agent,
              {
                name,
                flowId: newFlowId,
                elevenLabsVoiceId,
                systemPrompt,
                firstMessage: req.body.firstMessage,
                language,
                llmModel,
                temperature: req.body.temperature,
                maxDurationSeconds: newMaxDuration,
                detectLanguageEnabled,
                knowledgeBaseIds,
                voiceStability,
                voiceSimilarityBoost,
                voiceSpeed,
                turnTimeout,
                expressiveMode,
                messagingEmailEnabled: req.body.messagingEmailEnabled,
                messagingWhatsappEnabled: req.body.messagingWhatsappEnabled,
                messagingEmailTemplate: req.body.messagingEmailTemplate,
                messagingWhatsappTemplate: req.body.messagingWhatsappTemplate,
                messagingWhatsappVariables: req.body.messagingWhatsappVariables,
              }
            );
          } catch (syncError: any) {
            logger.error(`❌ Flow agent ElevenLabs sync failed:`);
            logger.error(`   Agent ID: ${agent.id}`);
            logger.error(`   ElevenLabs Agent ID: ${agent.elevenLabsAgentId}`);
            logger.error(`   Flow ID: ${newFlowId || agent.flowId || 'none'}`);
            logger.error(`   Error: ${syncError.message}`);
            if (syncError.details) {
              logger.error(`   Details:`, JSON.stringify(syncError.details, null, 2));
            }
            if (syncError.stack) {
              logger.error(`   Stack:`, syncError.stack.split('\n').slice(0, 5).join('\n'));
            }
            return res.status(500).json({
              error: "Failed to sync changes to ElevenLabs",
              details: syncError.message
            });
          }
        }

        let resolvedLlmModel: string | null = agent.llmModel;
        if (llmModel) {
          const modelRecord = await db
            .select({ modelId: llmModels.modelId })
            .from(llmModels)
            .where(eq(llmModels.name, llmModel))
            .limit(1);
          resolvedLlmModel = modelRecord.length > 0 ? modelRecord[0].modelId : llmModel;

          // Sanitize the model ID for ElevenLabs compatibility
          resolvedLlmModel = sanitizeLlmModel(resolvedLlmModel || undefined);
        }

        const flowAgentUpdateBody = {
          ...req.body,
          llmModel: resolvedLlmModel || agent.llmModel,
          temperature: req.body.temperature !== undefined ? req.body.temperature : agent.temperature,
          knowledgeBaseIds: knowledgeBaseIds !== undefined ? knowledgeBaseIds : agent.knowledgeBaseIds,
        };
        await storage.updateAgent(req.params.id, flowAgentUpdateBody);
        const updatedAgent = await storage.getAgent(req.params.id);
        return res.json(updatedAgent);
      }

      if (agent.type === 'incoming') {
        await storage.updateAgent(req.params.id, req.body);

        const updatedAgent = await storage.getAgent(req.params.id);
        if (!updatedAgent) {
          return res.status(500).json({ error: "Failed to retrieve updated agent" });
        }

        if (updatedAgent.elevenLabsAgentId) {
          try {
            let whatsappTemplateNames: string[] = [];
            const effectiveWhatsappEnabled = messagingWhatsappEnabled !== undefined
              ? messagingWhatsappEnabled
              : agent.messagingWhatsappEnabled;
            if (effectiveWhatsappEnabled) {
              whatsappTemplateNames = await fetchWhatsappTemplateNames(req.userId!);
            }

            await IncomingAgentService.updateInElevenLabs(
              agent.id,
              updatedAgent.elevenLabsAgentId,
              agent,
              {
                name,
                systemPrompt,
                elevenLabsVoiceId,
                firstMessage: req.body.firstMessage,
                language,
                llmModel,
                temperature: req.body.temperature,
                knowledgeBaseIds,
                transferEnabled,
                transferPhoneNumber,
                detectLanguageEnabled,
                endConversationEnabled,
                appointmentBookingEnabled,
                messagingEmailEnabled,
                messagingWhatsappEnabled,
                messagingWhatsappTemplates: whatsappTemplateNames,
                messagingEmailSelectedTemplate: messagingEmailTemplate || updatedAgent.messagingEmailTemplate || undefined,
                messagingWhatsappSelectedTemplate: messagingWhatsappTemplate || updatedAgent.messagingWhatsappTemplate || undefined,
                messagingWhatsappVariables: messagingWhatsappVariables || updatedAgent.messagingWhatsappVariables || undefined,
                expressiveMode,
                voiceStability,
                voiceSimilarityBoost,
                voiceSpeed,
                turnTimeout,
                databaseAgentId: agent.id,
              }
            );
          } catch (error: any) {
            logger.error("Failed to sync Incoming agent to ElevenLabs:", error);
          }
        }

        return res.json(updatedAgent);
      }

      await storage.updateAgent(req.params.id, req.body);
      const updatedAgent = await storage.getAgent(req.params.id);
      if (!updatedAgent) {
        return res.status(500).json({ error: "Failed to retrieve updated agent" });
      }

      res.json(updatedAgent);
    } catch (error: any) {
      logger.error("Update agent error:", error);
      res.status(500).json({ error: "Failed to update agent" });
    }
  });

  router.delete("/api/agents/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (agent.elevenLabsAgentId) {
        try {
          const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
          if (credential) {
            const agentElevenLabsService = new ElevenLabsService(credential.apiKey);
            await agentElevenLabsService.deleteAgent(agent.elevenLabsAgentId);
            logger.info(`✅ Deleted agent ${agent.name} from ElevenLabs (${agent.elevenLabsAgentId})`);
          } else {
            await elevenLabsService.deleteAgent(agent.elevenLabsAgentId);
            logger.info(`✅ Deleted agent ${agent.name} from ElevenLabs using default credential`);
          }
        } catch (elevenLabsError: any) {
          logger.error(`⚠️ Failed to delete from ElevenLabs (will still delete from database):`, elevenLabsError.message);
        }
      }

      if (agent.elevenLabsCredentialId) {
        try {
          await ElevenLabsPoolService.updateAssignmentCount(agent.elevenLabsCredentialId, false);
          logger.info(`📊 [Agent Delete] Decremented agent count for credential ${agent.elevenLabsCredentialId}`);
        } catch (countError) {
          logger.warn("Failed to update credential agent count:", countError);
        }
      }

      await storage.deleteAgent(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete agent error:", error);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });
}
