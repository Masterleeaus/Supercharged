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
import { agents, incomingConnections, sipPhoneNumbers, plivoPhoneNumbers } from "@shared/schema";
import { getPluginStatus } from "../plugins/loader";
import { logger } from '../utils/logger';
import { canAccessCampaign } from "./campaign-routes-shared";

export function createCampaignCoreRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, storage, authenticateHybrid, escapeCSV } = ctx;
  // Get all campaigns
  router.get("/api/campaigns", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const allCampaigns = await storage.getUserCampaigns(req.userId!);
      const deletedCampaigns = await storage.getUserDeletedCampaigns(req.userId!);
      
      const activeCount = allCampaigns.length;
      const deletedCount = deletedCampaigns.length;

      const requestsPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
      
      if (requestsPagination) {
        const page = parseInt(req.query.page as string, 10) || 1;
        const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
        const offset = (page - 1) * pageSize;

        const totalItems = allCampaigns.length;
        const totalPages = Math.ceil(totalItems / pageSize);

        const paginatedCampaigns = allCampaigns.slice(offset, offset + pageSize);

        res.json({
          data: paginatedCampaigns,
          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages
          }
        });
      } else {
        res.json(allCampaigns);
      }
    } catch (error: any) {
      logger.error("Get campaigns error:", error);
      res.status(500).json({ error: "Failed to get campaigns" });
    }
  });

  // Get deleted campaigns
  router.get("/api/campaigns/deleted", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const deletedCampaigns = await storage.getUserDeletedCampaigns(req.userId!);
      res.json(deletedCampaigns);
    } catch (error: any) {
      logger.error("Get deleted campaigns error:", error);
      res.status(500).json({ error: "Failed to get deleted campaigns" });
    }
  });

  // Restore a deleted campaign
  router.patch("/api/campaigns/:id/restore", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaignIncludingDeleted(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      if (!campaign.deletedAt) {
        return res.status(400).json({ error: "Campaign is not deleted" });
      }
      
      await storage.restoreCampaign(req.params.id);
      
      const restoredCampaign = await storage.getCampaign(req.params.id);
      res.json(restoredCampaign);
    } catch (error: any) {
      logger.error("Restore campaign error:", error);
      res.status(500).json({ error: "Failed to restore campaign" });
    }
  });

  // Create campaign
  router.post("/api/campaigns", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { name, type, goal, script, flowId, agentId, voiceId, phoneNumberId, sipPhoneNumberId, plivoPhoneNumberId, scheduledFor,
        retryEnabled, retryMaxAttempts, retryIntervalMinutes, retryOnNoAnswer, retryOnBusy, retryOnFailed,
        scheduleEnabled, scheduleTimeStart, scheduleTimeEnd, scheduleDays, daysOfWeek, scheduleTimezone } = req.body;

      if (!name || !type) {
        return res.status(400).json({ error: "Name and type are required" });
      }

      if (!agentId) {
        return res.status(400).json({ error: "Please select an agent for this campaign" });
      }

      if (flowId && script) {
        return res.status(400).json({ error: "Cannot use both visual flow and custom script. Please choose one." });
      }

      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      const existingCampaigns = await storage.getUserCampaigns(req.userId!);
      // Skip limit check if explicitly unlimited (-1 or 999)
      if (plan.maxCampaigns !== -1 && plan.maxCampaigns !== 999 && existingCampaigns.length >= plan.maxCampaigns) {
        return res.status(403).json({ 
          error: `Campaign limit reached. Your ${plan.displayName} allows maximum ${plan.maxCampaigns} campaign(s).`,
          upgradeRequired: true
        });
      }

      const agent = await storage.getAgent(agentId);
      if (!agent || agent.userId !== req.userId) {
        return res.status(403).json({ error: "Invalid agent selection" });
      }

      if (phoneNumberId) {
        const phoneNumber = await storage.getPhoneNumber(phoneNumberId);
        if (!phoneNumber) {
          return res.status(403).json({ error: "Invalid phone number selection" });
        }
        
        const isOwned = phoneNumber.userId === req.userId;
        const isSystemPool = phoneNumber.userId === null && phoneNumber.isSystemPool === true;
        
        if (isSystemPool && user.planType === 'pro') {
          return res.status(403).json({ 
            error: "Pro users cannot use system numbers",
            message: "As a Pro plan user, please purchase your own phone number for campaigns. System pool numbers are only available for Free plan users."
          });
        }
        
        if (!isOwned && !isSystemPool) {
          return res.status(403).json({ error: "Invalid phone number selection" });
        }

        const incomingConnectionCheck = await db
          .select({ id: incomingConnections.id, agentId: incomingConnections.agentId })
          .from(incomingConnections)
          .where(eq(incomingConnections.phoneNumberId, phoneNumberId))
          .limit(1);
        
        if (incomingConnectionCheck.length > 0) {
          const [connectedAgent] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, incomingConnectionCheck[0].agentId))
            .limit(1);
          
          return res.status(409).json({ 
            error: "Phone number conflict",
            message: `This phone number is attached to an incoming connection for "${connectedAgent?.name || 'an agent'}". A phone number cannot be used for both outbound campaigns and incoming calls simultaneously. Please either buy a new number for campaigns, or detach this number from the incoming connection first.`,
            conflictType: 'incoming_connection',
            connectedAgentName: connectedAgent?.name
          });
        }
      }

      // Validate SIP phone number if provided (only when SIP plugin is enabled)
      if (sipPhoneNumberId) {
        if (agent.telephonyProvider === 'custom-voice-engine') {
          const [userSipPhoneNumber] = (await db.execute(sql`
            SELECT * FROM user_sip_phone_numbers WHERE id = ${sipPhoneNumberId} LIMIT 1
          `)).rows as any[];

          if (!userSipPhoneNumber) {
            // Check standard sip_phone_numbers
            const [sipPhoneNumber] = await db
              .select()
              .from(sipPhoneNumbers)
              .where(eq(sipPhoneNumbers.id, sipPhoneNumberId))
              .limit(1);

            if (!sipPhoneNumber) {
              return res.status(404).json({ error: "Custom/standard SIP phone number not found" });
            }

            // Validate ownership
            if (sipPhoneNumber.userId !== req.userId) {
              return res.status(403).json({ error: "You don't have access to this SIP phone number" });
            }
          } else {
            // Validate ownership
            if (userSipPhoneNumber.user_id !== req.userId) {
              return res.status(403).json({ error: "You don't have access to this custom SIP phone number" });
            }
          }
        } else {
          const plugins = await getPluginStatus();
          const sipPlugin = plugins.find(p => p.name === 'sip-engine');
          if (!sipPlugin?.enabled) {
            return res.status(400).json({ error: "SIP Engine plugin is not enabled" });
          }

          const [sipPhoneNumber] = await db
            .select()
            .from(sipPhoneNumbers)
            .where(eq(sipPhoneNumbers.id, sipPhoneNumberId))
            .limit(1);

          if (!sipPhoneNumber) {
            return res.status(404).json({ error: "SIP phone number not found" });
          }

          // Validate ownership
          if (sipPhoneNumber.userId !== req.userId) {
            return res.status(403).json({ error: "You don't have access to this SIP phone number" });
          }

          // Validate engine compatibility with agent (Custom Voice Engine supports all)
          if (agent.telephonyProvider && sipPhoneNumber.engine !== agent.telephonyProvider) {
            return res.status(400).json({ 
              error: "Engine mismatch",
              message: `The selected SIP phone number uses ${sipPhoneNumber.engine} engine but the agent uses ${agent.telephonyProvider}. Please select a compatible phone number.`
            });
          }
        }
      }

      // Validate Plivo phone number if provided
      if (plivoPhoneNumberId) {
        const [plivoPhoneNumber] = await db
          .select()
          .from(plivoPhoneNumbers)
          .where(eq(plivoPhoneNumbers.id, plivoPhoneNumberId))
          .limit(1);

        if (!plivoPhoneNumber) {
          return res.status(404).json({ error: "Plivo phone number not found" });
        }

        // Validate ownership
        if (plivoPhoneNumber.userId !== req.userId) {
          return res.status(403).json({ error: "You don't have access to this Plivo phone number" });
        }

        // Validate agent is using Plivo telephony (or Custom Voice Engine which supports all)
        if (agent.telephonyProvider !== 'plivo' && agent.telephonyProvider !== 'plivo_openai' && agent.telephonyProvider !== 'custom-voice-engine') {
          return res.status(400).json({ 
            error: "Engine mismatch",
            message: `Cannot use a Plivo phone number with a ${agent.telephonyProvider || 'Twilio'} agent. Please select a Plivo agent for this campaign.`
          });
        }
      }

      const campaign = await storage.createCampaign({
        userId: req.userId!,
        agentId,
        voiceId: voiceId || null,
        phoneNumberId: phoneNumberId || null,
        sipPhoneNumberId: sipPhoneNumberId || null,
        plivoPhoneNumberId: plivoPhoneNumberId || null,
        flowId: flowId || null,
        name,
        type,
        goal: goal || null,
        script: script || null,
        status: "pending",
        totalContacts: 0,
        scheduledFor: scheduledFor || null,
        startedAt: null,
        completedAt: null,
        retryEnabled: retryEnabled ?? false,
        retryMaxAttempts: retryMaxAttempts ?? 3,
        retryIntervalMinutes: retryIntervalMinutes ?? 60,
        retryOnNoAnswer: retryOnNoAnswer ?? true,
        retryOnBusy: retryOnBusy ?? false,
        retryOnFailed: retryOnFailed ?? false,
        scheduleEnabled: scheduleEnabled ?? false,
        scheduleTimeStart: scheduleTimeStart || null,
        scheduleTimeEnd: scheduleTimeEnd || null,
        scheduleDays: scheduleDays || daysOfWeek || [],
        scheduleTimezone: scheduleTimezone || "America/New_York",
      });

      res.json(campaign);
    } catch (error: any) {
      logger.error("Create campaign error:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  // Get single campaign
  router.get("/api/campaigns/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!canAccessCampaign(campaign, req)) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      res.json(campaign);
    } catch (error: any) {
      logger.error("Get campaign error:", error);
      res.status(500).json({ error: "Failed to get campaign" });
    }
  });

  // Export campaign data
  router.get("/api/campaigns/:id/export", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || !canAccessCampaign(campaign, req)) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const callsList = await storage.getCampaignCalls(campaign.id);
      
      const contactIds = callsList.map(c => c.contactId).filter(Boolean) as string[];
      const uniqueContactIds = Array.from(new Set(contactIds));
      const contactsArray = await Promise.all(
        uniqueContactIds.map(id => storage.getContact(id))
      );
      
      const contactMap = new Map(
        contactsArray.filter(Boolean).map(c => [c!.id, c])
      );
      
      const headers = [
        "Contact Name",
        "Phone Number",
        "Email",
        "Call Status",
        "Lead Classification",
        "Duration (seconds)",
        "Call Started",
        "Call Ended",
        "Transcript",
        "AI Summary",
        "Error Message"
      ];

      const csvRows = [headers.join(",")];

      for (const call of callsList) {
        const contact = call.contactId ? contactMap.get(call.contactId) : undefined;
        const fullName = contact ? `${contact.firstName} ${contact.lastName || ""}`.trim() : "";
        const phone = contact?.phone || "";
        const email = contact?.email || "";
        
        const row = [
          escapeCSV(fullName),
          escapeCSV(phone),
          escapeCSV(email),
          escapeCSV(call.status || ""),
          escapeCSV(call.classification || ""),
          call.duration || 0,
          escapeCSV(call.startedAt ? new Date(call.startedAt).toISOString() : ""),
          escapeCSV(call.endedAt ? new Date(call.endedAt).toISOString() : ""),
          escapeCSV(call.transcript || ""),
          escapeCSV(call.aiSummary || ""),
          ""
        ];
        
        csvRows.push(row.join(","));
      }

      const csv = csvRows.join("\n");
      const filename = `campaign-${campaign.name.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.csv`;
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      logger.error("Export campaign error:", error);
      res.status(500).json({ error: "Failed to export campaign" });
    }
  });

  // Update campaign
  router.patch("/api/campaigns/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const { agentId, voiceId, phoneNumberId, sipPhoneNumberId, name, type, goal, script } = req.body;

      if (agentId) {
        const agent = await storage.getAgent(agentId);
        if (!agent || agent.userId !== req.userId) {
          return res.status(403).json({ error: "Invalid agent selection" });
        }
      }

      if (phoneNumberId) {
        const phoneNumber = await storage.getPhoneNumber(phoneNumberId);
        if (!phoneNumber || phoneNumber.userId !== req.userId) {
          return res.status(403).json({ error: "Invalid phone number selection" });
        }
      }

      // Validate SIP phone number if provided (only when SIP plugin is enabled)
      if (sipPhoneNumberId) {
        const targetAgentId = agentId || campaign.agentId;
        let isCustomVoiceEngine = false;
        if (targetAgentId) {
          const agent = await storage.getAgent(targetAgentId);
          if (agent?.telephonyProvider === 'custom-voice-engine') {
            isCustomVoiceEngine = true;
          }
        }

        let sipPhone: any = null;

        if (isCustomVoiceEngine) {
          const [userSipPhoneNumber] = (await db.execute(sql`
            SELECT * FROM user_sip_phone_numbers WHERE id = ${sipPhoneNumberId} AND user_id = ${req.userId!} LIMIT 1
          `)).rows as any[];

          if (!userSipPhoneNumber) {
            const [foundSipPhone] = await db
              .select()
              .from(sipPhoneNumbers)
              .where(and(
                eq(sipPhoneNumbers.id, sipPhoneNumberId),
                eq(sipPhoneNumbers.userId, req.userId!)
              ))
              .limit(1);

            if (!foundSipPhone) {
              return res.status(403).json({ error: "Invalid SIP phone number selection" });
            }
            sipPhone = foundSipPhone;
          }
        } else {
          const plugins = await getPluginStatus();
          const sipPlugin = plugins.find(p => p.name === 'sip-engine');
          if (!sipPlugin?.enabled) {
            return res.status(400).json({ error: "SIP Engine plugin is not enabled" });
          }
          
          const [foundSipPhone] = await db
            .select()
            .from(sipPhoneNumbers)
            .where(and(
              eq(sipPhoneNumbers.id, sipPhoneNumberId),
              eq(sipPhoneNumbers.userId, req.userId!)
            ))
            .limit(1);
          
          if (!foundSipPhone) {
            return res.status(403).json({ error: "Invalid SIP phone number selection" });
          }
          sipPhone = foundSipPhone;
        }

        // Validate engine compatibility with agent (if agentId is being updated or already set)
        if (targetAgentId) {
          const agent = await storage.getAgent(targetAgentId);
          if (agent?.telephonyProvider && agent?.telephonyProvider !== 'custom-voice-engine' && sipPhone && sipPhone.engine !== agent.telephonyProvider) {
            return res.status(400).json({ 
              error: "Engine mismatch",
              message: `The selected SIP phone number uses ${sipPhone.engine} engine but the agent uses ${agent.telephonyProvider}. Please select a compatible phone number.`
            });
          }
        }
      }

      const updateData = { ...req.body };
      if (updateData.daysOfWeek !== undefined && updateData.scheduleDays === undefined) {
        updateData.scheduleDays = updateData.daysOfWeek;
      }
      delete updateData.daysOfWeek;

      await storage.updateCampaign(req.params.id, updateData);
      const updated = await storage.getCampaign(req.params.id);
      res.json(updated);
    } catch (error: any) {
      logger.error("Update campaign error:", error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  // Delete campaign
  router.delete("/api/campaigns/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      await storage.deleteCampaign(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete campaign error:", error);
      res.status(500).json({ error: "Failed to delete campaign" });
    }
  });

  // Get campaign contacts

  return router;
}
