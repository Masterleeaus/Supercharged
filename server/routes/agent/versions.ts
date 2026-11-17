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

/** Agent routes: agent version history routes. Split from server/routes/agent-routes.ts (issue #17). Paths and handlers are unchanged. */
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

export function registerAgentVersionRoutes(router: Router, ctx: RouteContext): void {
  const { storage, authenticateHybrid } = ctx;
  // ========================================
  // Agent Version History Routes
  // ========================================

  router.get("/api/agents/:agentId/versions", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (agent.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const versions = await storage.getAgentVersions(req.params.agentId);
      res.json(versions);
    } catch (error: any) {
      logger.error("Get agent versions error:", error);
      res.status(500).json({ error: "Failed to get agent versions" });
    }
  });

  router.get("/api/agents/:agentId/versions/:versionNumber", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (agent.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const versionNumber = parseInt(req.params.versionNumber, 10);
      if (isNaN(versionNumber)) {
        return res.status(400).json({ error: "Invalid version number" });
      }

      const version = await storage.getAgentVersionByNumber(req.params.agentId, versionNumber);
      if (!version) {
        return res.status(404).json({ error: "Version not found" });
      }

      res.json(version);
    } catch (error: any) {
      logger.error("Get agent version error:", error);
      res.status(500).json({ error: "Failed to get agent version" });
    }
  });

  router.post("/api/agents/:agentId/versions/:versionNumber/rollback", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (agent.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const versionNumber = parseInt(req.params.versionNumber, 10);
      if (isNaN(versionNumber)) {
        return res.status(400).json({ error: "Invalid version number" });
      }

      const targetVersion = await storage.getAgentVersionByNumber(req.params.agentId, versionNumber);
      if (!targetVersion) {
        return res.status(404).json({ error: "Version not found" });
      }

      const latestVersion = await storage.getLatestAgentVersion(req.params.agentId);
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

      await storage.createAgentVersion({
        agentId: req.params.agentId,
        versionNumber: nextVersionNumber,
        snapshot: currentSnapshot,
        changesSummary: `Snapshot before rollback to version ${versionNumber}`,
        changedFields: [],
        editedBy: req.userId!,
        note: req.body.note || null,
      });

      const targetSnapshot = targetVersion.snapshot as typeof currentSnapshot;
      await storage.updateAgent(req.params.agentId, {
        name: targetSnapshot.name,
        voiceTone: targetSnapshot.voiceTone,
        personality: targetSnapshot.personality,
        systemPrompt: targetSnapshot.systemPrompt,
        language: targetSnapshot.language,
        firstMessage: targetSnapshot.firstMessage,
        llmModel: targetSnapshot.llmModel,
        temperature: targetSnapshot.temperature,
        elevenLabsVoiceId: targetSnapshot.elevenLabsVoiceId,
        voiceStability: targetSnapshot.voiceStability,
        voiceSimilarityBoost: targetSnapshot.voiceSimilarityBoost,
        voiceSpeed: targetSnapshot.voiceSpeed,
        transferPhoneNumber: targetSnapshot.transferPhoneNumber,
        transferEnabled: targetSnapshot.transferEnabled,
        detectLanguageEnabled: targetSnapshot.detectLanguageEnabled,
        endConversationEnabled: targetSnapshot.endConversationEnabled,
        knowledgeBaseIds: targetSnapshot.knowledgeBaseIds,
        maxDurationSeconds: targetSnapshot.maxDurationSeconds,
        config: targetSnapshot.config,
        updatedAt: new Date(),
      });

      if (agent.elevenLabsAgentId) {
        try {
          const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
          if (credential) {
            const rollbackElevenLabsService = new ElevenLabsService(credential.apiKey);
            await rollbackElevenLabsService.updateAgent(agent.elevenLabsAgentId, {
              name: targetSnapshot.name,
              first_message: targetSnapshot.firstMessage || undefined,
              prompt: targetSnapshot.systemPrompt || undefined,
              voice_id: targetSnapshot.elevenLabsVoiceId || undefined,
              language: targetSnapshot.language || 'en',
              model: targetSnapshot.llmModel || undefined,
              temperature: targetSnapshot.temperature || undefined,
            });
          }
        } catch (syncError) {
          logger.warn("Failed to sync rollback with ElevenLabs:", syncError);
        }
      }

      const updatedAgent = await storage.getAgent(req.params.agentId);

      res.json({
        success: true,
        message: `Rolled back to version ${versionNumber}`,
        agent: updatedAgent,
        previousVersionNumber: nextVersionNumber,
      });
    } catch (error: any) {
      logger.error("Rollback agent version error:", error);
      res.status(500).json({ error: "Failed to rollback agent version" });
    }
  });

  // ========================================
}
