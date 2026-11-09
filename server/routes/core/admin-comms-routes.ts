import type { Express, Response } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { agents, campaigns } from "@shared/schema";
import { eq, desc, or } from "drizzle-orm";
import { campaignExecutor } from "../../services/campaign-executor";
import { BatchCallingService } from "../../services/batch-calling";
import { checkAdminOrTeamMember, requireAdminPermission, AdminRequest } from "../../middleware/admin-auth";
import { logger } from "../../utils/logger";

export function registerAdminCommsRoutes(app: Express): void {
  // Admin Email Templates Routes (supports both platform admins and admin team members)
  app.get("/api/admin/email-templates", checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', 'read'), async (req: AdminRequest, res: Response) => {
    try {
      const templates = await storage.getEmailTemplates();
      res.json(templates);
    } catch (error: any) {
      logger.error("Get email templates error:", error);
      res.status(500).json({ error: "Failed to get email templates" });
    }
  });

  app.get("/api/admin/email-templates/:templateType", checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', 'read'), async (req: AdminRequest, res: Response) => {
    try {
      const template = await storage.getEmailTemplate(req.params.templateType);
      if (!template) {
        return res.status(404).json({ error: "Email template not found" });
      }
      res.json(template);
    } catch (error: any) {
      logger.error("Get email template error:", error);
      res.status(500).json({ error: "Failed to get email template" });
    }
  });

  app.put("/api/admin/email-templates/:id", checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', 'update'), async (req: AdminRequest, res: Response) => {
    try {
      const { name, subject, htmlBody, textBody, variables, isActive } = req.body;
      await storage.updateEmailTemplate(req.params.id, {
        name,
        subject,
        htmlBody,
        textBody,
        variables,
        isActive,
      });
      res.json({ success: true, message: "Email template updated successfully" });
    } catch (error: any) {
      logger.error("Update email template error:", error);
      res.status(500).json({ error: "Failed to update email template" });
    }
  });

  app.post("/api/admin/email-templates", checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', 'create'), async (req: AdminRequest, res: Response) => {
    try {
      const { templateType, name, subject, htmlBody, textBody, variables, isActive } = req.body;

      if (!templateType || !name || !subject || !htmlBody || !textBody) {
        return res.status(400).json({ error: "templateType, name, subject, htmlBody, and textBody are required" });
      }

      const existingTemplate = await storage.getEmailTemplate(templateType);
      if (existingTemplate) {
        return res.status(400).json({ error: "Email template with this type already exists" });
      }

      const template = await storage.createEmailTemplate({
        templateType,
        name,
        subject,
        htmlBody,
        textBody,
        variables: variables || [],
        isActive: isActive !== undefined ? isActive : true,
      });

      res.json(template);
    } catch (error: any) {
      logger.error("Create email template error:", error);
      res.status(500).json({ error: "Failed to create email template" });
    }
  });

  // Admin Batch Jobs Routes (ElevenLabs Batch Calling) - supports both platform admins and admin team members
  app.get("/api/admin/batch-jobs", checkAdminOrTeamMember, requireAdminPermission('campaigns', 'batch_jobs', 'read'), async (req: AdminRequest, res: Response) => {
    try {
      const campaignsWithBatches = await db
        .select({
          campaign: campaigns,
          agent: agents,
        })
        .from(campaigns)
        .leftJoin(agents, eq(campaigns.agentId, agents.id))
        .orderBy(desc(campaigns.startedAt));

      const batchJobs = await Promise.all(
        campaignsWithBatches.map(async (item) => {
          try {
            const batchJob = await campaignExecutor.getBatchJobStatus(item.campaign.id);
            const stats = batchJob ? BatchCallingService.getBatchStats(batchJob) : null;

            return {
              campaignId: item.campaign.id,
              campaignName: item.campaign.name,
              batchJobId: item.campaign.batchJobId || (batchJob ? batchJob.id : `batch_${item.campaign.id}`),
              batchJobStatus: batchJob ? batchJob.status : (item.campaign.batchJobStatus || item.campaign.status || 'completed'),
              agentName: item.agent?.name || (batchJob ? batchJob.agent_name : 'Default Agent'),
              totalContacts: item.campaign.totalContacts || (batchJob ? batchJob.total_calls_scheduled : 0),
              totalCallsScheduled: batchJob ? batchJob.total_calls_scheduled : item.campaign.totalContacts,
              totalCallsDispatched: batchJob ? batchJob.total_calls_dispatched : item.campaign.completedCalls,
              createdAt: item.campaign.createdAt ? new Date(item.campaign.createdAt).toISOString() : new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
              stats: stats,
            };
          } catch (error: any) {
            return {
              campaignId: item.campaign.id,
              campaignName: item.campaign.name,
              batchJobId: item.campaign.batchJobId || `batch_${item.campaign.id}`,
              batchJobStatus: item.campaign.batchJobStatus || item.campaign.status || 'completed',
              agentName: item.agent?.name || 'Default Agent',
              totalContacts: item.campaign.totalContacts,
              totalCallsScheduled: item.campaign.totalContacts,
              totalCallsDispatched: item.campaign.completedCalls,
              createdAt: item.campaign.createdAt ? new Date(item.campaign.createdAt).toISOString() : new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
              stats: {
                total: item.campaign.totalContacts || 0,
                pending: 0,
                scheduled: 0,
                dispatched: item.campaign.completedCalls || 0,
                inProgress: 0,
                in_progress: 0,
                completed: item.campaign.completedCalls || 0,
                failed: item.campaign.failedCalls || 0,
                noResponse: 0,
                cancelled: 0,
                progress: (item.campaign.totalContacts && item.campaign.totalContacts > 0) ? Math.min(100, Math.round(((item.campaign.completedCalls || 0) / item.campaign.totalContacts) * 100)) : 100
              }
            };
          }
        })
      );

      res.json({ batchJobs });
    } catch (error: any) {
      logger.error("Get batch jobs error:", error);
      res.status(500).json({ error: "Failed to fetch batch jobs" });
    }
  });

  // Get detailed batch job info
  app.get("/api/admin/batch-jobs/:batchId", checkAdminOrTeamMember, requireAdminPermission('campaigns', 'batch_jobs', 'read'), async (req: AdminRequest, res: Response) => {
    try {
      const { batchId } = req.params;

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(or(eq(campaigns.batchJobId, batchId), eq(campaigns.id, batchId)))
        .limit(1);

      if (!campaign) {
        return res.status(404).json({ error: "Batch job not found" });
      }

      const batchJob = await campaignExecutor.getBatchJobStatus(campaign.id);
      const stats = batchJob ? BatchCallingService.getBatchStats(batchJob) : null;

      res.json({
        batchJob,
        stats,
        campaign: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
        }
      });
    } catch (error: any) {
      logger.error("Get batch job detail error:", error);
      res.status(500).json({ error: "Failed to fetch batch job details" });
    }
  });
}
