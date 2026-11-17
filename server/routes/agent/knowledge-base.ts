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

/** Agent routes: knowledge base routes. Split from server/routes/agent-routes.ts (issue #17). Paths and handlers are unchanged. */
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

export function registerKnowledgeBaseRoutes(router: Router, ctx: RouteContext): void {
  const { storage, authenticateHybrid, elevenLabsService, upload } = ctx;
  // ========================================
  // Knowledge Base Routes
  // ========================================

  router.get("/api/knowledge-base", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const items = await storage.getUserKnowledgeBase(req.userId!);
      res.json(items);
    } catch (error: any) {
      logger.error("Get knowledge base error:", error);
      res.status(500).json({ error: "Failed to get knowledge base" });
    }
  });

  router.post("/api/knowledge-base", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { type, title, content, url, metadata } = req.body;

      if (!type || !title) {
        return res.status(400).json({ error: "Type and title are required" });
      }

      const currentCount = await storage.getUserKnowledgeBaseCount(req.userId!);
      const limits = await storage.getUserEffectiveLimits(req.userId!);
      const maxKnowledgeBases = typeof limits.maxKnowledgeBases === 'number' ? limits.maxKnowledgeBases : 5;

      // Skip limit check if explicitly unlimited (999 or -1)
      if (maxKnowledgeBases !== 999 && maxKnowledgeBases !== -1 && currentCount >= maxKnowledgeBases) {
        return res.status(403).json({
          error: `Knowledge base limit reached (${maxKnowledgeBases}). Upgrade your plan or contact support to increase your limit.`
        });
      }

      const storageSize = content ? content.length : 0;

      const item = await storage.createKnowledgeBaseItem({
        userId: req.userId!,
        type,
        title,
        content: content || null,
        url: url || null,
        fileUrl: null,
        metadata: metadata || null,
        storageSize,
      });

      res.json(item);
    } catch (error: any) {
      logger.error("Create knowledge base item error:", error);
      res.status(500).json({ error: "Failed to create knowledge base item" });
    }
  });

  router.post("/api/knowledge-base/upload", authenticateHybrid, upload.single('file'), async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const currentCount = await storage.getUserKnowledgeBaseCount(req.userId!);
      const limits = await storage.getUserEffectiveLimits(req.userId!);
      const maxKnowledgeBases = typeof limits.maxKnowledgeBases === 'number' ? limits.maxKnowledgeBases : 5;

      // Skip limit check if explicitly unlimited (999 or -1)
      if (maxKnowledgeBases !== 999 && maxKnowledgeBases !== -1 && currentCount >= maxKnowledgeBases) {
        return res.status(403).json({
          error: `Knowledge base limit reached (${maxKnowledgeBases}). Upgrade your plan or contact support to increase your limit.`
        });
      }

      const { name } = req.body;
      const filename = req.file.originalname;

      if (req.file.size > 20 * 1024 * 1024) {
        return res.status(400).json({ error: "File size exceeds 20MB limit" });
      }

      const elevenLabsResult = await elevenLabsService.uploadKnowledgeBaseFile(
        req.file.buffer,
        filename,
        name || filename
      );

      const item = await storage.createKnowledgeBaseItem({
        userId: req.userId!,
        type: 'file',
        title: name || filename,
        content: null,
        url: null,
        fileUrl: filename,
        elevenLabsDocId: elevenLabsResult.id,
        metadata: { filename, mimeType: req.file.mimetype },
        storageSize: req.file.size,
      });

      res.json(item);
    } catch (error: any) {
      logger.error("Upload knowledge base file error:", error);
      res.status(500).json({ error: "Failed to upload file" });
    }
  });

  router.post("/api/knowledge-base/url", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { url, name } = req.body;

      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      const currentCount = await storage.getUserKnowledgeBaseCount(req.userId!);
      const limits = await storage.getUserEffectiveLimits(req.userId!);
      const maxKnowledgeBases = typeof limits.maxKnowledgeBases === 'number' ? limits.maxKnowledgeBases : 5;

      // Skip limit check if explicitly unlimited (999 or -1)
      if (maxKnowledgeBases !== 999 && maxKnowledgeBases !== -1 && currentCount >= maxKnowledgeBases) {
        return res.status(403).json({
          error: `Knowledge base limit reached (${maxKnowledgeBases}). Upgrade your plan or contact support to increase your limit.`
        });
      }

      const elevenLabsResult = await elevenLabsService.addKnowledgeBaseFromUrl(url, name);

      const item = await storage.createKnowledgeBaseItem({
        userId: req.userId!,
        type: 'url',
        title: name || url,
        content: null,
        url: url,
        fileUrl: null,
        elevenLabsDocId: elevenLabsResult.id,
        metadata: { url },
        storageSize: 0,
      });

      res.json(item);
    } catch (error: any) {
      logger.error("Add knowledge base URL error:", error);
      res.status(500).json({ error: "Failed to add URL" });
    }
  });

  router.post("/api/knowledge-base/text", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { text, name } = req.body;

      if (!text || !name) {
        return res.status(400).json({ error: "Text and name are required" });
      }

      const currentCount = await storage.getUserKnowledgeBaseCount(req.userId!);
      const limits = await storage.getUserEffectiveLimits(req.userId!);
      const maxKnowledgeBases = typeof limits.maxKnowledgeBases === 'number' ? limits.maxKnowledgeBases : 5;

      // Skip limit check if explicitly unlimited (999 or -1)
      if (maxKnowledgeBases !== 999 && maxKnowledgeBases !== -1 && currentCount >= maxKnowledgeBases) {
        return res.status(403).json({
          error: `Knowledge base limit reached (${maxKnowledgeBases}). Upgrade your plan or contact support to increase your limit.`
        });
      }

      if (text.length > 300000) {
        return res.status(400).json({ error: "Text exceeds 300,000 character limit" });
      }

      const elevenLabsResult = await elevenLabsService.addKnowledgeBaseFromText(text, name);

      const item = await storage.createKnowledgeBaseItem({
        userId: req.userId!,
        type: 'text',
        title: name,
        content: text,
        url: null,
        fileUrl: null,
        elevenLabsDocId: elevenLabsResult.id,
        metadata: null,
        storageSize: text.length,
      });

      res.json(item);
    } catch (error: any) {
      logger.error("Add knowledge base text error:", error);
      res.status(500).json({ error: "Failed to add text" });
    }
  });

  router.delete("/api/knowledge-base/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const item = await storage.getKnowledgeBaseItem(req.params.id);
      if (!item || item.userId !== req.userId) {
        return res.status(404).json({ error: "Knowledge base item not found" });
      }

      if (item.elevenLabsDocId) {
        try {
          await elevenLabsService.deleteKnowledgeBase(item.elevenLabsDocId);
        } catch (elevenLabsError: any) {
          logger.error("Failed to delete from ElevenLabs:", elevenLabsError.message);
        }
      }

      await storage.deleteKnowledgeBaseItem(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete knowledge base item error:", error);
      res.status(500).json({ error: "Failed to delete knowledge base item" });
    }
  });
}
