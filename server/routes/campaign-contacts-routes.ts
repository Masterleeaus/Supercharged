'use strict';
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

import { Router, Response } from "express";
import multer from "multer";
import { RouteContext, AuthRequest } from "./common";
import { ElevenLabsPoolService } from "../services/elevenlabs-pool";
import { BatchCallingService } from "../services/batch-calling";
import { PlanLimitExceededError } from "../services/contact-upload-service";
import { logger } from '../utils/logger';
import { canAccessCampaign } from "./campaign-routes-shared";

/** Large CSV campaigns (100k rows); separate from global 20MB upload limit. */
const CAMPAIGN_CSV_MAX_BYTES = 80 * 1024 * 1024;
const CAMPAIGN_CSV_MIME = new Set([
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const campaignCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CAMPAIGN_CSV_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (CAMPAIGN_CSV_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed for contact upload`));
    }
  },
});

export function createCampaignContactRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { storage, authenticateToken, authenticateHybrid, upload, campaignExecutor, contactUploadService } = ctx;
  router.get("/api/campaigns/:campaignId/contacts", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!canAccessCampaign(campaign, req)) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const contactsList = await storage.getCampaignContacts(req.params.campaignId);
      res.json(contactsList);
    } catch (error: any) {
      logger.error("Get contacts error:", error);
      res.status(500).json({ error: "Failed to get contacts" });
    }
  });

  // Upload contacts to campaign
  router.post("/api/campaigns/:campaignId/contacts/upload", authenticateToken, campaignCsvUpload.single("file"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      const fileContent = await contactUploadService.readFileContent(req.file);
      const parsedContacts = contactUploadService.parseContactsFromCSV(fileContent, req.params.campaignId);

      contactUploadService.validateContactsAgainstPlanLimit(
        parsedContacts.length,
        campaign.totalContacts,
        plan.maxContactsPerCampaign,
        plan.displayName
      );

      const uploadResult = await contactUploadService.createContactsForCampaign(
        req.params.campaignId,
        parsedContacts,
        campaign.totalContacts
      );

      const payload: Record<string, unknown> = {
        count: uploadResult.inserted,
        inserted: uploadResult.inserted,
        failed: uploadResult.failed,
        skippedInvalid: uploadResult.skippedInvalid,
        resultsTruncated: uploadResult.resultsTruncated,
      };
      if (!uploadResult.resultsTruncated && uploadResult.contacts.length > 0) {
        payload.contacts = uploadResult.contacts;
      }

      res.json(payload);
    } catch (error: any) {
      if (error instanceof PlanLimitExceededError) {
        return res.status(403).json({
          error: error.message,
          upgradeRequired: error.upgradeRequired,
          currentContacts: error.currentContacts,
          maxContacts: error.maxContacts
        });
      }
      logger.error("Upload contacts error:", error);
      res.status(500).json({ error: "Failed to upload contacts" });
    }
  });

  // Get campaign calls
  router.get("/api/campaigns/:campaignId/calls", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!canAccessCampaign(campaign, req)) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const callsList = await storage.getCampaignCalls(req.params.campaignId);
      res.json(callsList);
    } catch (error: any) {
      logger.error("Get campaign calls error:", error);
      res.status(500).json({ error: "Failed to get campaign calls" });
    }
  });

  // Get campaign batch job (campaignId param version)
  router.get("/api/campaigns/:campaignId/batch", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!canAccessCampaign(campaign, req)) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // Use campaignExecutor.getBatchJobStatus which handles all engines correctly and synthesizes status when needed:
      const batchJob = await campaignExecutor.getBatchJobStatus(req.params.campaignId);
      logger.info(`[Campaign Batch Debug] ID: ${req.params.campaignId}, BatchJob: ${batchJob ? 'present' : 'null'}`);
      if (!batchJob) {
        return res.status(404).json({ error: "Batch job status not available" });
      }

      const stats = BatchCallingService.getBatchStats(batchJob);
      res.json({ batchJob, stats });
    } catch (error: any) {
      logger.error("Get batch job error:", error);
      res.status(500).json({ error: "Failed to get batch job status", details: error?.message || String(error) });
    }
  });

  // Cancel campaign batch job
  router.post("/api/campaigns/:campaignId/batch/cancel", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "No batch job to cancel" });
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign has no agent assigned" });
      }

      const agent = await storage.getAgent(campaign.agentId);
      if (!agent) {
        return res.status(400).json({ error: "Agent not found" });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No credential found for agent" });
      }

      const batchService = new BatchCallingService(credential.apiKey);
      const result = await batchService.cancelBatch(campaign.batchJobId);

      await storage.updateCampaign(campaign.id, {
        status: 'cancelled',
        batchJobStatus: 'cancelled',
      });

      res.json({ success: true, result });
    } catch (error: any) {
      logger.error("Cancel batch job error:", error);
      res.status(500).json({ error: "Failed to cancel batch job" });
    }
  });

  // Retry campaign batch job
  router.post("/api/campaigns/:campaignId/batch/retry", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "No batch job to retry" });
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign has no agent assigned" });
      }

      const agent = await storage.getAgent(campaign.agentId);
      if (!agent) {
        return res.status(400).json({ error: "Agent not found" });
      }

      const { isNonElevenLabsBatchJob } = await import('../services/campaign-executor');
      if (isNonElevenLabsBatchJob(campaign.batchJobId) || agent.telephonyProvider === 'openai-sip') {
        await storage.updateCampaign(campaign.id, {
          status: 'running',
          batchJobStatus: 'in_progress',
        });
        return res.json({ success: true, result: { status: 'in_progress' } });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No credential found for agent" });
      }

      const batchService = new BatchCallingService(credential.apiKey);
      const result = await batchService.retryBatch(campaign.batchJobId);

      await storage.updateCampaign(campaign.id, {
        status: 'in-progress',
        batchJobStatus: 'in_progress',
      });

      res.json({ success: true, result });
    } catch (error: any) {
      logger.error("Retry batch job error:", error);
      res.status(500).json({ error: "Failed to retry batch job" });
    }
  });

  // Validate campaign before execution

  return router;
}
