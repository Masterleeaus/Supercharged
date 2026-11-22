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
import { RouteContext, AuthRequest } from "./common";
import { eq, and, sql } from "drizzle-orm";
import { campaigns, calls, agents, phoneNumbers, incomingConnections, sipPhoneNumbers } from "@shared/schema";
import { ElevenLabsService } from "../services/elevenlabs";
import { ElevenLabsPoolService } from "../services/elevenlabs-pool";
import { getPluginStatus } from "../plugins/loader";
import { logger } from '../utils/logger';

export function createCampaignExecutionRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, storage, authenticateHybrid, campaignExecutor, webhookDeliveryService } = ctx;
  router.get("/api/campaigns/:id/validate", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      const validation = await campaignExecutor.validateCampaign(id);
      
      res.json({
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
        canStart: validation.valid,
      });
    } catch (error: any) {
      logger.error("Campaign validation error:", error);
      res.status(500).json({ error: "Failed to validate campaign" });
    }
  });

  // Execute campaign
  router.post("/api/campaigns/:id/execute", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.status !== 'pending' && campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        return res.status(400).json({ error: "Campaign is already running or completed" });
      }
      
      // Check for phone number based on agent type
      // SIP phone numbers are only valid when SIP plugin is enabled
      let hasSipPhoneNumber = false;
      if ((campaign as any).sipPhoneNumberId) {
        const plugins = await getPluginStatus();
        const sipPlugin = plugins.find(p => p.name === 'sip-engine');
        if (!sipPlugin?.enabled) {
          // SIP phone number is configured but plugin is disabled - return clear error
          return res.status(400).json({ 
            error: "SIP Engine plugin is not enabled",
            message: "This campaign uses a SIP phone number, but the SIP Engine plugin is currently disabled. Please contact your administrator to enable the plugin."
          });
        }
        // Verify the SIP phone number exists and belongs to user
        const [sipPhone] = await db
          .select()
          .from(sipPhoneNumbers)
          .where(and(
            eq(sipPhoneNumbers.id, (campaign as any).sipPhoneNumberId),
            eq(sipPhoneNumbers.userId, req.userId!)
          ))
          .limit(1);
        
        if (sipPhone) {
          hasSipPhoneNumber = true;
        } else {
          // Fallback to user_sip_phone_numbers table
          const userSipPhoneResult = await db.execute(sql`
            SELECT id FROM user_sip_phone_numbers 
            WHERE id = ${(campaign as any).sipPhoneNumberId} AND user_id = ${req.userId!} 
            LIMIT 1
          `);
          if (userSipPhoneResult.rows.length > 0) {
            hasSipPhoneNumber = true;
          }
        }
      }
      
      if (!campaign.agentId || (!campaign.phoneNumberId && !campaign.plivoPhoneNumberId && !hasSipPhoneNumber)) {
        return res.status(400).json({ error: "Campaign must have agent and phone number configured" });
      }
      
      // Only check for incoming connection conflicts for Twilio phone numbers
      if (campaign.phoneNumberId) {
        // Check that the assigned phone number is still active. Numbers can be
        // set to 'inactive' by the billing cron when the user has insufficient
        // credits to renew the monthly rental, at which point the number is
        // also released from Twilio. Surface a clear 400 immediately so the
        // background fire-and-forget never sees this case.
        const [phoneNumberRecord] = await db
          .select({ status: phoneNumbers.status })
          .from(phoneNumbers)
          .where(eq(phoneNumbers.id, campaign.phoneNumberId))
          .limit(1);

        if (phoneNumberRecord && phoneNumberRecord.status !== 'active') {
          return res.status(400).json({
            error: "Phone number is not active",
            message: "The phone number assigned to this campaign is no longer active. This usually happens when there are insufficient credits to renew the monthly rental, causing the number to be released. Please purchase a new phone number and reassign it to this campaign.",
            resolution: "purchase_phone_number"
          });
        }

        const incomingConnectionCheck = await db
          .select({ id: incomingConnections.id, agentId: incomingConnections.agentId })
          .from(incomingConnections)
          .where(eq(incomingConnections.phoneNumberId, campaign.phoneNumberId))
          .limit(1);
        
        if (incomingConnectionCheck.length > 0) {
          const [connectedAgent] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, incomingConnectionCheck[0].agentId))
            .limit(1);
          
          return res.status(409).json({
            error: "Phone number conflict",
            message: `This phone number is attached to an incoming agent "${connectedAgent?.name || 'Unknown'}". A phone number can only be used for either incoming calls OR outbound campaigns, not both.`,
            suggestion: "Please either purchase a new phone number for this campaign, or disconnect this number from the incoming agent first.",
            conflictType: "incoming_connection",
            connectedAgentName: connectedAgent?.name
          });
        }
      }
      
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      const totalContacts = campaign.totalContacts || 0;
      if (totalContacts === 0) {
        return res.status(400).json({ error: "Campaign has no contacts. Please add contacts before starting." });
      }
      
      const estimatedMinutes = totalContacts * 2;
      const estimatedCredits = estimatedMinutes;
      
      if (user.credits < estimatedCredits) {
        return res.status(402).json({ 
          error: "Insufficient credits",
          message: `You need approximately ${estimatedCredits} credits to run this campaign (${totalContacts} contacts × ~2 min/call). You currently have ${user.credits} credits. Please purchase more credits to continue.`,
          required: estimatedCredits,
          available: user.credits
        });
      }
      
      // If scheduledFor is set and is in the future, do not execute immediately.
      // Set status to 'scheduled' and let the background scheduler fire at the right time.
      if (campaign.scheduledFor && new Date(campaign.scheduledFor) > new Date()) {
        await db
          .update(campaigns)
          .set({ status: 'scheduled' })
          .where(eq(campaigns.id, id));
        return res.json({
          status: 'scheduled',
          scheduledFor: campaign.scheduledFor,
          message: `Campaign is scheduled to run at ${new Date(campaign.scheduledFor).toISOString()}. It will start automatically at the scheduled time.`,
        });
      }

      const result = await campaignExecutor.executeCampaign(id);
      
      webhookDeliveryService.triggerEvent(campaign.companyId ?? null, req.userId!, 'campaign.started', {
        campaign: { 
          id: campaign.id, 
          name: campaign.name, 
          type: campaign.type,
          totalContacts: campaign.totalContacts,
          agentId: campaign.agentId,
          phoneNumberId: campaign.phoneNumberId,
        },
        startedAt: new Date().toISOString(),
        totalCallsScheduled: result.batchJob.total_calls_scheduled,
        batchJobId: result.batchJob.id,
      }, id).catch(err => {
        logger.error('❌ [Webhook] Error triggering campaign.started event:', err);
      });
      
      res.json({ 
        message: "Campaign started with batch job", 
        campaignId: id,
        batchJobId: result.batchJob.id,
        batchJobStatus: result.batchJob.status,
        totalCallsScheduled: result.batchJob.total_calls_scheduled,
        estimatedCredits,
        availableCredits: user.credits
      });
    } catch (error: any) {
      logger.error("Campaign execution error:", error);
      res.status(500).json({ error: "Failed to execute campaign" });
    }
  });

  // Cancel campaign
  router.post("/api/campaigns/:id/cancel", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "Campaign has no active batch job to cancel" });
      }
      
      const batchJob = await campaignExecutor.cancelCampaign(id);
      
      res.json({ 
        message: "Campaign cancelled", 
        campaignId: id,
        batchJob
      });
    } catch (error: any) {
      logger.error("Campaign cancel error:", error);
      res.status(500).json({ error: "Failed to cancel campaign" });
    }
  });

  // Retry campaign
  router.post("/api/campaigns/:id/retry", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "Campaign has no batch job to retry" });
      }
      
      const batchJob = await campaignExecutor.retryCampaign(id);
      
      res.json({ 
        message: "Campaign retry started", 
        campaignId: id,
        batchJob
      });
    } catch (error: any) {
      logger.error("Campaign retry error:", error);
      res.status(500).json({ error: "Failed to retry campaign" });
    }
  });

  // Stop campaign (legacy)
  router.post("/api/campaigns/:id/stop", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.batchJobId) {
        await campaignExecutor.cancelCampaign(id);
      } else {
        await campaignExecutor.stopCampaign(id);
      }
      
      res.json({ message: "Campaign stopped", campaignId: id });
    } catch (error: any) {
      logger.error("Campaign stop error:", error);
      res.status(500).json({ error: "Failed to stop campaign" });
    }
  });

  // Pause campaign
  router.post("/api/campaigns/:id/pause", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.status !== "running" && campaign.status !== "in-progress" && campaign.status !== "in_progress") {
        return res.status(400).json({ error: "Campaign is not running" });
      }
      
      if (campaign.batchJobId) {
        const batchJob = await campaignExecutor.pauseCampaign(id, 'manual');
        res.json({ 
          message: "Campaign paused", 
          campaignId: id,
          batchJob
        });
      } else {
        await storage.updateCampaign(id, {
          status: "paused",
        });
        
        webhookDeliveryService.triggerEvent(campaign.companyId ?? null, req.userId!, 'campaign.paused', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            completedCalls: campaign.completedCalls,
            successfulCalls: campaign.successfulCalls,
            failedCalls: campaign.failedCalls,
          },
          pausedAt: new Date().toISOString(),
          reason: 'manual',
        }, id).catch(err => {
          logger.error('❌ [Webhook] Error triggering campaign.paused event:', err);
        });
        
        res.json({ message: "Campaign paused", campaignId: id });
      }
    } catch (error: any) {
      logger.error("Campaign pause error:", error);
      res.status(500).json({ error: "Failed to pause campaign" });
    }
  });

  // Resume campaign
  router.post("/api/campaigns/:id/resume", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.status !== "paused" && campaign.status !== "completed" && campaign.status !== "failed") {
        return res.status(400).json({ error: "Campaign cannot be resumed. Must be paused, completed, or failed." });
      }

      if (campaign.phoneNumberId) {
        const incomingConnectionCheck = await db
          .select({ id: incomingConnections.id, agentId: incomingConnections.agentId })
          .from(incomingConnections)
          .where(eq(incomingConnections.phoneNumberId, campaign.phoneNumberId))
          .limit(1);
        
        if (incomingConnectionCheck.length > 0) {
          const [connectedAgent] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, incomingConnectionCheck[0].agentId))
            .limit(1);
          
          return res.status(409).json({
            error: "Phone number conflict",
            message: `This phone number is attached to an incoming agent "${connectedAgent?.name || 'Unknown'}". A phone number can only be used for either incoming calls OR outbound campaigns, not both.`,
            suggestion: "Please either purchase a new phone number for this campaign, or disconnect this number from the incoming agent first.",
            conflictType: "incoming_connection",
            connectedAgentName: connectedAgent?.name
          });
        }

        // Check that the assigned phone number is still active. Numbers can be
        // set to 'inactive' by the billing cron when the user has insufficient
        // credits to renew the monthly rental, at which point the number is
        // also released from Twilio. Attempting to resume with an inactive
        // number would result in a cryptic 500 error, so surface a clear 400
        // with instructions on what the user should do instead.
        const [phoneNumberRecord] = await db
          .select({ status: phoneNumbers.status })
          .from(phoneNumbers)
          .where(eq(phoneNumbers.id, campaign.phoneNumberId))
          .limit(1);

        if (phoneNumberRecord && phoneNumberRecord.status !== 'active') {
          return res.status(400).json({
            error: "Phone number is not active",
            message: "The phone number assigned to this campaign is no longer active. This usually happens when there are insufficient credits to renew the monthly rental, causing the number to be released. Please purchase a new phone number and reassign it to this campaign.",
            resolution: "purchase_phone_number"
          });
        }
      }
      
      if (campaign.batchJobId) {
        // Campaign has existing batch job - retry it via ElevenLabs API
        const batchJob = await campaignExecutor.resumeCampaign(id, 'manual');
        res.json({ 
          message: "Campaign resumed", 
          campaignId: id,
          batchJob
        });
      } else {
        // Campaign has no batch job - create a new one for pending/failed contacts only
        logger.info(`▶️ [Campaign Resume] Campaign ${id} has no batchJobId, creating new batch for pending contacts...`);
        
        const result = await campaignExecutor.resumeWithNewBatch(id);
        
        if (!result.batchJob && result.contactsToCall === 0) {
          return res.json({ 
            message: "All contacts already called successfully, nothing to resume",
            campaignId: id
          });
        }
        
        webhookDeliveryService.triggerEvent(campaign.companyId ?? null, req.userId!, 'campaign.started', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            completedCalls: campaign.completedCalls,
            successfulCalls: campaign.successfulCalls,
            failedCalls: campaign.failedCalls,
          },
          resumedAt: new Date().toISOString(),
          isResume: true,
          contactsToCall: result.contactsToCall,
        }, id).catch(err => {
          logger.error('❌ [Webhook] Error triggering campaign.started (resumed) event:', err);
        });
        
        res.json({ 
          message: `Campaign resumed with ${result.contactsToCall} pending contacts`, 
          campaignId: id,
          batchJob: result.batchJob,
          contactsToCall: result.contactsToCall
        });
      }
    } catch (error: any) {
      if (error.message === 'Phone number is not active') {
        logger.warn("Campaign resume blocked: phone number is not active");
        return res.status(400).json({
          error: "Phone number is not active",
          message: "The phone number assigned to this campaign is no longer active. This usually happens when there are insufficient credits to renew the monthly rental, causing the number to be released. Please purchase a new phone number and reassign it to this campaign.",
          resolution: "purchase_phone_number"
        });
      }
      logger.error("Campaign resume error:", error);
      res.status(500).json({ error: "Failed to resume campaign" });
    }
  });

  // Test call for campaign
  router.post("/api/campaigns/:id/test-call", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { phoneNumber } = req.body;

      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      if (!phoneNumber.startsWith('+')) {
        return res.status(400).json({ error: "Phone number must include country code (e.g., +1234567890)" });
      }

      if (!campaign.phoneNumberId) {
        return res.status(400).json({ error: "Campaign must have a phone number configured" });
      }

      let [campaignPhone] = await db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, campaign.phoneNumberId))
        .limit(1);

      if (!campaignPhone) {
        return res.status(404).json({ error: "Campaign phone number not found" });
      }

      // SECURITY: Verify phone belongs to campaign owner
      // System pool numbers (null userId) are allowed for free-tier users
      const isSystemPoolNumber = campaignPhone.isSystemPool === true && campaignPhone.userId === null;
      if (!isSystemPoolNumber && campaignPhone.userId !== campaign.userId) {
        logger.warn(`⚠️ [Campaign Test] Phone [redacted] does not belong to campaign owner`);
        return res.status(403).json({
          error: "Phone number access denied",
          message: "This phone number is not associated with your account."
        });
      }

      // Check agent first before any ElevenLabs-specific operations
      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign must have an agent configured" });
      }

      const [agentForSync] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, campaign.agentId))
        .limit(1);

      // Skip ElevenLabs sync for non-ElevenLabs agents (Plivo, Twilio+OpenAI)
      const isElevenLabsAgent = !agentForSync?.telephonyProvider || 
        (agentForSync.telephonyProvider !== 'plivo' && agentForSync.telephonyProvider !== 'twilio_openai');

      // AUTO-FIX: If phone lacks ElevenLabs sync and agent uses ElevenLabs, try to sync
      if (!campaignPhone.elevenLabsPhoneNumberId && isElevenLabsAgent) {
        logger.warn(`📞 [Campaign Test] Phone ${campaignPhone.id} missing ElevenLabs sync - attempting auto-sync`);
        
        if (!agentForSync?.elevenLabsCredentialId) {
          return res.status(400).json({ 
            error: "Phone number not synced with ElevenLabs",
            message: "Please sync your phone numbers with ElevenLabs in the Phone Numbers section."
          });
        }
        
        try {
          const { PhoneMigrator } = await import('../engines/elevenlabs-migration/phone-migrator');
          const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
            campaignPhone.id,
            campaign.agentId
          );
          
          if (migrationResult.success && migrationResult.newElevenLabsPhoneId) {
            logger.info(`✅ [Campaign Test] Phone synced successfully via PhoneMigrator`);
            // Re-fetch updated phone record to ensure we have correct state
            const [updatedPhone] = await db
              .select()
              .from(phoneNumbers)
              .where(eq(phoneNumbers.id, campaignPhone.id))
              .limit(1);
            if (updatedPhone) {
              campaignPhone = updatedPhone;
            }
            // Validate refreshed phone has expected credential after sync
            if (!campaignPhone.elevenLabsCredentialId || !campaignPhone.elevenLabsPhoneNumberId) {
              logger.error(`❌ [Campaign Test] Phone sync returned success but DB state invalid`);
              return res.status(500).json({
                error: "Phone sync inconsistent",
                message: "Phone sync reported success but database state is invalid. Please try again."
              });
            }
          } else {
            return res.status(400).json({ 
              error: "Phone number sync failed",
              message: "Could not sync phone number with ElevenLabs. Please try syncing from the Phone Numbers page.",
              suggestion: "Visit Phone Numbers page and click 'Sync to ElevenLabs' for this number."
            });
          }
        } catch (syncError: any) {
          logger.error(`❌ [Campaign Test] Phone sync failed:`, syncError);
          return res.status(400).json({ 
            error: "Phone sync failed",
            message: syncError.message || "Failed to sync phone number with ElevenLabs. Please try again."
          });
        }
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign must have an agent configured" });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, campaign.agentId))
        .limit(1);

      if (!agent || !agent.elevenLabsAgentId) {
        return res.status(400).json({ error: "Agent not found or not synced with ElevenLabs" });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No ElevenLabs credential found for agent" });
      }

      logger.info(`📞 [Test Call] Initiating test call via ElevenLabs native API`);
      logger.info(`   Campaign: ${campaign.name} (${campaign.id})`);
      logger.info(`   From: campaign phone ${campaignPhone.id} (ElevenLabs ID: ${campaignPhone.elevenLabsPhoneNumberId})`);
      logger.info(`   Agent: ${agent.name} (ElevenLabs ID: ${agent.elevenLabsAgentId})`);
      logger.info(`   Credential: ${credential.name}`);

      // company_id from the owning campaign and the verified session; refuse if missing or conflicting
      const testCallCompanyIds = [campaign.companyId, res.locals.companyId].filter(
        (v): v is string => typeof v === 'string' && v.length > 0
      );
      if (new Set(testCallCompanyIds).size !== 1) {
        return res.status(403).json({ error: "Company scope could not be verified for this campaign" });
      }

      const [callRecord] = await db
        .insert(calls)
        .values({
          companyId: testCallCompanyIds[0],
          userId: campaign.userId,
          campaignId: campaign.id,
          contactId: null,
          phoneNumber: phoneNumber,
          fromNumber: campaignPhone.phoneNumber,
          toNumber: phoneNumber,
          status: 'initiated',
          callDirection: 'outgoing',
          startedAt: new Date(),
        })
        .returning();

      const elevenLabsSvc = new ElevenLabsService(credential.apiKey);
      
      try {
        const callResult = await elevenLabsSvc.initiateOutboundCall({
          phoneNumberId: campaignPhone.elevenLabsPhoneNumberId!,
          toNumber: phoneNumber,
          agentId: agent.elevenLabsAgentId!,
          firstMessage: agent.firstMessage || undefined,
        });

        logger.info(`✅ [Test Call] ElevenLabs call initiated`);
        logger.info(`   Conversation ID: ${callResult.conversation_id}`);
        if (callResult.call_sid) {
          logger.info(`   Call SID: ${callResult.call_sid}`);
        }

        await db
          .update(calls)
          .set({ 
            elevenLabsConversationId: callResult.conversation_id,
            twilioSid: callResult.call_sid || null,
            status: 'ringing',
            metadata: {
              initiatedVia: 'elevenlabs_native',
              agentName: agent.name,
              credentialName: credential.name,
              isTestCall: true,
            }
          })
          .where(eq(calls.id, callRecord.id));

        // Trigger call.started webhook event
        try {
          await webhookDeliveryService.triggerEvent(testCallCompanyIds[0], campaign.userId, 'call.started', {
            campaign: { id: campaign.id, name: campaign.name, type: campaign.type },
            contact: { phone: phoneNumber },
            agent: { id: agent.id, name: agent.name },
            call: {
              id: callRecord.id,
              status: 'initiated',
              phoneNumber: phoneNumber,
              startedAt: callRecord.startedAt,
              conversationId: callResult.conversation_id,
              twilioSid: callResult.call_sid,
            }
          }, campaign.id).catch(err => {
            logger.error(`Failed to trigger call.started webhook: ${err.message}`);
          });
        } catch (webhookError: any) {
          logger.error(`Failed to trigger call.started webhook: ${webhookError.message}`);
        }

        res.json({ 
          success: true, 
          message: "Test call initiated successfully via ElevenLabs",
          callId: callRecord.id,
          conversationId: callResult.conversation_id,
          twilioSid: callResult.call_sid
        });

      } catch (callError: any) {
        logger.error(`❌ [Test Call] ElevenLabs call initiation failed:`, callError);
        
        await db
          .update(calls)
          .set({ 
            status: 'failed',
            endedAt: new Date(),
            metadata: { error: `ElevenLabs error: ${callError.message}` }
          })
          .where(eq(calls.id, callRecord.id));
        
        throw new Error(`ElevenLabs call failed: ${callError.message}`);
      }

    } catch (error: any) {
      logger.error("Test call error:", error);
      res.status(500).json({ 
        error: "Failed to initiate test call"
      });
    }
  });


  return router;
}
