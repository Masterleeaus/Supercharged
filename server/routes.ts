'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import type { Express, RequestHandler, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { phoneNumbers, agents, calls, campaigns, incomingConnections, users, knowledgeBase } from "@shared/schema";
import { eq, desc, and, isNull, sql, or } from "drizzle-orm";
import { authenticateToken, requireRole, type AuthRequest } from "./middleware/auth";
import { ElevenLabsPoolService } from "./services/elevenlabs-pool";

const elevenLabsPoolService = new ElevenLabsPoolService();
import { campaignExecutor } from "./services/campaign-executor";
import { BatchCallingService } from "./services/batch-calling";
import { maintenanceMiddleware } from "./services/system-update-service";
import { createRouteContext } from "./routes/common";
// Plivo + OpenAI Realtime Engine
import { setupPlivoStream } from "./engines/plivo";
// Plivo-ElevenLabs SIP Trunk Engine (ISOLATED from Twilio+ElevenLabs)
import { initPlivoElevenLabsStream } from "./engines/plivo-elevenlabs";
// Twilio + OpenAI Realtime Engine (ISOLATED from Twilio+ElevenLabs and Plivo+OpenAI)
import { setupTwilioOpenAIStreamHandler } from "./engines/twilio-openai";
import { checkAdmin, checkAdminOrTeamMember, requireAdminPermission, AdminRequest } from "./middleware/admin-auth";
import { flows, insertPromptTemplateSchema, promptTemplates } from "@shared/schema";

// Table insert shape for createPromptTemplate; the drizzle-zod insert type resolves to {}.
type PromptTemplateInsertRow = typeof promptTemplates.$inferInsert & { companyId?: string };
import multer from "multer";
// Team Management Middleware - allows team members to access user data with their parent's userId
// Uses adapter for optional plugin loading
import { getTeamContextMiddleware, isTeamManagementInstalled, initializeAdapter as initTeamAdapter } from "./plugins/team-management-adapter";
import { CampaignScheduler } from "./services/campaign-scheduler";
import { workforceHealthHandler } from "./workforce/runtime/health.ts";
import { agentRunsFromRecords, createWorkforceAdminRouter, workforceControls } from "./workforce/runtime/workforce-admin-routes.ts";
import { createPgRoster } from "./workforce/pg-roster.ts";
import { createTaskBoardRouter } from "./workforce/runtime/task-board-routes.ts";
import { createPgRunStore, type SqlExecutor } from "./workforce/runtime/pg-store.ts";
import { createCompanyControlsRouter } from "./workforce/runtime/company-controls-routes.ts";
import { loadCatalogueAtStartup, getActiveCatalogue } from "./workforce/catalogue/startup.ts";
import { createRoster, listAgents as listRosterAgents } from "./workforce/roster.ts";
import { createWorkforceRosterRouter } from "./routes/workforce-roster-routes.ts";
import { createDeadLetterRouter } from "./routes/dead-letter-routes.ts";
import { createCampaignRouterForProduction, createDrizzleCampaignStore, type ApprovalPort, type SendTransport } from "./modules/campaigns/index.ts";
import { createCompanySettingsStore } from "./modules/settings/company-settings.ts";
import { createSuppressionList } from "./modules/comms/suppression.ts";
import { createCommsAuditSink } from "./modules/comms/audit-sink.ts";
import { logAuditEvent } from "./services/audit-log";
const commsAudit = createCommsAuditSink({ write: logAuditEvent as unknown as Parameters<typeof createCommsAuditSink>[0]["write"] });
import { deskModeMiddleware } from "./modules/desk-modes/index.ts";
import { featureEnabled } from "./lib/feature-flags";
import { requireCompanyScope } from "./middleware/company-scope";
import { createCockpitRouter, DEFAULT_MODE_CONFIG } from "./routes/cockpit-routes";
import { registerPublicAuthRoutes } from "./routes/core/public-auth-routes";
import { registerPlatformRoutes } from "./routes/core/platform-routes";
import { registerVoiceEngineRoutes } from "./routes/core/voice-engine-routes";
import { registerPluginEngineRoutes } from "./routes/core/plugin-engine-routes";
import { registerPluginManagementRoutes } from "./routes/core/plugin-management-routes";
import { registerAdminUserRoutes } from "./routes/core/admin-user-routes";
import { registerContactsToolsRoutes } from "./routes/core/contacts-tools-routes";
import { registerElevenLabsAgentRoutes } from "./routes/core/elevenlabs-agent-routes";
import { registerElevenLabsVoiceRoutes } from "./routes/core/elevenlabs-voice-routes";
import { registerProviderWebhookRoutes } from "./routes/core/provider-webhook-routes";
import { registerPaymentRoutes } from "./routes/core/payment-routes";
import { registerAdminRouterRoutes } from "./routes/core/admin-router-routes";
import { registerUserServiceRoutes } from "./routes/core/user-service-routes";
import { registerChatbotWiringRoutes } from "./routes/core/chatbot-wiring-routes";
import { registerCrmPublicRoutes } from "./routes/core/crm-public-routes";
import { registerStreamWidgetRoutes } from "./routes/core/stream-widget-routes";
import { registerIntegrationRoutes } from "./routes/core/integration-routes";
import { registerTwilioStreamUpgrade } from "./routes/core/twilio-stream-upgrade";

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4',
  'text/plain', 'application/json',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  }
});

// Helper function to escape CSV fields
function escapeCSV(value: string | number): string {
  if (typeof value === 'number') return value.toString();
  if (!value) return "";

  // Escape quotes by doubling them and wrap in quotes if contains comma, quote, or newline
  const stringValue = value.toString();
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  (global as any).__httpServer = httpServer;

  // Create shared route context for dependency injection
  const routeContext = createRouteContext();

  // Block non-admin user traffic with a 503 while a system update is in
  // progress. Admin / auth / static asset requests still pass through so the
  // admin can monitor and finish the flow.
  app.use(maintenanceMiddleware);

  // Routes: public and auth, see server/routes/core/public-auth-routes.ts
  registerPublicAuthRoutes(app, { routeContext });

  // Apply team context middleware globally for all user-facing /api routes
  // This allows team members to access data using their parent user's userId
  // The middleware only activates when Team Management plugin is installed and
  // a Bearer token is present from team member auth
  if (isTeamManagementInstalled()) {
    await initTeamAdapter();
    app.use('/api', getTeamContextMiddleware());
    console.log('✅ Team Management plugin detected - team context middleware enabled');
  }

  // Routes: agent, campaign, phone, analytics and related, see server/routes/core/platform-routes.ts
  registerPlatformRoutes(app, { routeContext });

  // Auth middleware as Express handlers. authenticateToken reads AuthRequest (userId, userRole),
  // which is a Request with optional extra fields, so it is assignable to RequestHandler directly.
  const requireAuth: RequestHandler = authenticateToken;
  const requireAdmin: RequestHandler = checkAdmin;

  // Routes: Plivo, Twilio-OpenAI and KYC engine, see server/routes/core/voice-engine-routes.ts
  registerVoiceEngineRoutes(app, { requireAuth, requireAdmin });

  // Routes: SIP engine and REST API plugins, see server/routes/core/plugin-engine-routes.ts
  await registerPluginEngineRoutes(app);

  // Routes: plugin installer, management and loader, see server/routes/core/plugin-management-routes.ts
  await registerPluginManagementRoutes(app, { httpServer });

  // Routes: LLM model list and admin user credits and limits, see server/routes/core/admin-user-routes.ts
  registerAdminUserRoutes(app);

  // Routes: contacts and tools, see server/routes/core/contacts-tools-routes.ts
  registerContactsToolsRoutes(app);

  // Routes: ElevenLabs agents, see server/routes/core/elevenlabs-agent-routes.ts
  registerElevenLabsAgentRoutes(app);

  // Routes: ElevenLabs voices and pricing, see server/routes/core/elevenlabs-voice-routes.ts
  registerElevenLabsVoiceRoutes(app);

  // Routes: Twilio and ElevenLabs provider webhooks, see server/routes/core/provider-webhook-routes.ts
  registerProviderWebhookRoutes(app);

  // Routes: payment gateways, see server/routes/core/payment-routes.ts
  registerPaymentRoutes(app);

  // Routes: admin routers, transactions and refunds, see server/routes/core/admin-router-routes.ts
  registerAdminRouterRoutes(app);

  // Routes: audio, invoice, flow automation and incoming connection, see server/routes/core/user-service-routes.ts
  registerUserServiceRoutes(app, { routeContext });

  // Routes: chatbot wiring, see server/routes/core/chatbot-wiring-routes.ts
  registerChatbotWiringRoutes(app, { routeContext });

  // Routes: CRM, public platform languages and public widget, see server/routes/core/crm-public-routes.ts
  registerCrmPublicRoutes(app, { routeContext });

  // Routes: stream upgrade fallbacks and authenticated widget, see server/routes/core/stream-widget-routes.ts
  registerStreamWidgetRoutes(app, { httpServer, routeContext });

  // Routes: RAG knowledge, Google Sheets and Google Calendar, see server/routes/core/integration-routes.ts
  await registerIntegrationRoutes(app, { routeContext });

  // Routes: Twilio stream WebSocket upgrade, see server/routes/core/twilio-stream-upgrade.ts
  registerTwilioStreamUpgrade(app, { httpServer });

  // ============================================
  // USER LIMITS API
  // ============================================

  // Get all user limits and current usage
  app.get("/api/user/limits", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const limits = await storage.getUserEffectiveLimits(req.userId!);

      // Get current counts
      const webhookCount = await storage.getUserWebhookCount(req.userId!);
      const kbCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeBase)
        .where(eq(knowledgeBase.userId, req.userId!));
      const flowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(eq(flows.userId, req.userId!));
      const phoneCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, req.userId!));

      res.json({
        webhooks: {
          current: webhookCount,
          max: limits.maxWebhooks,
          remaining: Math.max(0, limits.maxWebhooks - webhookCount),
          source: limits.sources.maxWebhooks
        },
        knowledgeBases: {
          current: Number(kbCount[0]?.count || 0),
          max: limits.maxKnowledgeBases,
          remaining: Math.max(0, limits.maxKnowledgeBases - Number(kbCount[0]?.count || 0)),
          source: limits.sources.maxKnowledgeBases
        },
        flows: {
          current: Number(flowCount[0]?.count || 0),
          max: limits.maxFlows,
          remaining: Math.max(0, limits.maxFlows - Number(flowCount[0]?.count || 0)),
          source: limits.sources.maxFlows
        },
        phoneNumbers: {
          current: Number(phoneCount[0]?.count || 0),
          max: limits.maxPhoneNumbers,
          remaining: Math.max(0, limits.maxPhoneNumbers - Number(phoneCount[0]?.count || 0)),
          source: limits.sources.maxPhoneNumbers
        }
      });
    } catch (error: any) {
      console.error("Get user limits error:", error);
      res.status(500).json({ error: "Failed to get user limits" });
    }
  });

  // Notifications
  app.get("/api/notifications", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const notifications = await storage.getUserNotifications(req.userId!, limit);
      res.json(notifications);
    } catch (error: any) {
      console.error("Get notifications error:", error);
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  app.get("/api/notifications/unread-count", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const count = await storage.getUnreadNotificationCount(req.userId!);
      res.json({ count });
    } catch (error: any) {
      console.error("Get unread count error:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  app.patch("/api/notifications/:id/read", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification || notification.userId !== req.userId) {
        return res.status(404).json({ error: "Notification not found" });
      }

      await storage.markNotificationAsRead(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Mark notification as read error:", error);
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  app.post("/api/notifications/read-all", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      await storage.markAllNotificationsAsRead(req.userId!);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Mark all notifications as read error:", error);
      res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
  });

  app.delete("/api/notifications/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification || notification.userId !== req.userId) {
        return res.status(404).json({ error: "Notification not found" });
      }

      await storage.deleteNotification(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete notification error:", error);
      res.status(500).json({ error: "Failed to delete notification" });
    }
  });

  app.get("/api/notifications/banner", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notifications = await storage.getBannerNotifications(req.userId!);
      res.json(notifications);
    } catch (error: any) {
      console.error("Get banner notifications error:", error);
      res.status(500).json({ error: "Failed to get banner notifications" });
    }
  });

  app.patch("/api/notifications/:id/dismiss", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification || notification.userId !== req.userId) {
        return res.status(404).json({ error: "Notification not found" });
      }

      await storage.dismissNotification(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Dismiss notification error:", error);
      res.status(500).json({ error: "Failed to dismiss notification" });
    }
  });

  app.post("/api/admin/notifications/broadcast", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.userId!);
      if (user?.role !== 'admin') {
        return res.status(403).json({ error: "Only admins can send broadcast notifications" });
      }

      const {
        title,
        message,
        link,
        type = 'system',
        icon,
        displayType = 'bell',
        priority = 0,
        dismissible = true,
        expiresAt
      } = req.body;

      if (!title || !message) {
        return res.status(400).json({ error: "Title and message are required" });
      }

      if (displayType && !['bell', 'banner', 'both'].includes(displayType)) {
        return res.status(400).json({ error: "displayType must be 'bell', 'banner', or 'both'" });
      }

      if (priority !== undefined && (typeof priority !== 'number' || priority < 0)) {
        return res.status(400).json({ error: "priority must be a non-negative number" });
      }

      if (dismissible !== undefined && typeof dismissible !== 'boolean') {
        return res.status(400).json({ error: "dismissible must be a boolean" });
      }

      let parsedExpiresAt: Date | null = null;
      if (expiresAt) {
        parsedExpiresAt = new Date(expiresAt);
        if (isNaN(parsedExpiresAt.getTime())) {
          return res.status(400).json({ error: "expiresAt must be a valid date" });
        }
      }

      const users = await storage.getAllUsers();
      const notifications = await Promise.all(
        users.map(u => storage.createNotification({
          userId: u.id,
          type,
          title,
          message,
          link: link || null,
          icon: icon || null,
          displayType,
          priority,
          dismissible,
          expiresAt: parsedExpiresAt,
        }))
      );

      res.json({
        success: true,
        recipientCount: notifications.length,
        message: `Broadcast sent to ${notifications.length} users`
      });
    } catch (error: any) {
      console.error("Broadcast notification error:", error);
      res.status(500).json({ error: "Failed to send broadcast notification" });
    }
  });

  // ============================================
  // PROMPT TEMPLATES ROUTES
  // ============================================

  // Get all prompt templates available to user (own + system + public)
  app.get("/api/prompt-templates", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const category = req.query.category as string | undefined;

      // Get user's own templates
      const userTemplates = await storage.getUserPromptTemplates(req.userId!);

      // Get system templates
      const systemTemplates = await storage.getSystemPromptTemplates();

      // Get public templates (from other users)
      const publicTemplates = await storage.getPublicPromptTemplates();

      // Combine and deduplicate (user's own templates take priority, avoid system template duplicates)
      const userTemplateIds = new Set(userTemplates.map(t => t.id));
      const systemTemplateIds = new Set(systemTemplates.map(t => t.id));
      const filteredPublic = publicTemplates.filter(t =>
        !userTemplateIds.has(t.id) &&
        !systemTemplateIds.has(t.id) &&
        t.userId !== req.userId
      );

      let allTemplates = [...userTemplates, ...systemTemplates, ...filteredPublic];

      // Filter by category if specified
      if (category && category !== 'all') {
        allTemplates = allTemplates.filter(t => t.category === category);
      }

      res.json(allTemplates);
    } catch (error: any) {
      console.error("Get prompt templates error:", error);
      res.status(500).json({ error: "Failed to get prompt templates" });
    }
  });

  // Get single prompt template
  app.get("/api/prompt-templates/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Allow access if: own template, system template, or public template
      const isOwn = template.userId === req.userId;
      const isSystem = template.isSystemTemplate;
      const isPublic = template.isPublic;

      if (!isOwn && !isSystem && !isPublic) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(template);
    } catch (error: any) {
      console.error("Get prompt template error:", error);
      res.status(500).json({ error: "Failed to get prompt template" });
    }
  });

  // Create prompt template
  app.post("/api/prompt-templates", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Validate with Zod schema
      const validationResult = insertPromptTemplateSchema.safeParse({
        ...req.body,
        userId: req.userId,
        isSystemTemplate: false,
      });

      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(', ');
        return res.status(400).json({ error: `Validation failed: ${errors}` });
      }

      const {
        name,
        description,
        category,
        systemPrompt,
        firstMessage,
        variables,
        suggestedVoiceTone,
        suggestedPersonality,
        isPublic
      } = validationResult.data;

      // Extract variables from template using {{variable}} pattern
      const extractedVars = (systemPrompt.match(/\{\{(\w+)\}\}/g) || [])
        .map((v: string) => v.replace(/\{\{|\}\}/g, ''));
      const firstMsgVars = (firstMessage?.match(/\{\{(\w+)\}\}/g) || [])
        .map((v: string) => v.replace(/\{\{|\}\}/g, ''));

      const allVariables = Array.from(new Set([...extractedVars, ...firstMsgVars, ...(variables || [])]));

      const template = await storage.createPromptTemplate({
        userId: req.userId!,
        name,
        description: description || null,
        category: category || 'general',
        systemPrompt,
        firstMessage: firstMessage || null,
        variables: allVariables.length > 0 ? allVariables : null,
        suggestedVoiceTone: suggestedVoiceTone || null,
        suggestedPersonality: suggestedPersonality || null,
        isSystemTemplate: false,
        isPublic: isPublic || false,
      } as PromptTemplateInsertRow);

      res.json(template);
    } catch (error: any) {
      console.error("Create prompt template error:", error);
      res.status(500).json({ error: "Failed to create prompt template" });
    }
  });

  // Update prompt template
  app.patch("/api/prompt-templates/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Only owner can update (not system templates)
      if (template.userId !== req.userId || template.isSystemTemplate) {
        return res.status(403).json({ error: "Cannot modify this template" });
      }

      const {
        name,
        description,
        category,
        systemPrompt,
        firstMessage,
        variables,
        suggestedVoiceTone,
        suggestedPersonality,
        isPublic
      } = req.body;

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (category !== undefined) updates.category = category;
      if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
      if (firstMessage !== undefined) updates.firstMessage = firstMessage;
      if (suggestedVoiceTone !== undefined) updates.suggestedVoiceTone = suggestedVoiceTone;
      if (suggestedPersonality !== undefined) updates.suggestedPersonality = suggestedPersonality;
      if (isPublic !== undefined) updates.isPublic = isPublic;

      // Re-extract variables whenever systemPrompt or firstMessage changes
      if (systemPrompt !== undefined || firstMessage !== undefined) {
        const finalSystemPrompt = systemPrompt ?? template.systemPrompt;
        const finalFirstMessage = firstMessage ?? template.firstMessage;

        const extractedVars = (finalSystemPrompt.match(/\{\{(\w+)\}\}/g) || [])
          .map((v: string) => v.replace(/\{\{|\}\}/g, ''));
        const firstMsgVars = (finalFirstMessage?.match(/\{\{(\w+)\}\}/g) || [])
          .map((v: string) => v.replace(/\{\{|\}\}/g, ''));
        updates.variables = Array.from(new Set([...extractedVars, ...firstMsgVars]));
      }

      await storage.updatePromptTemplate(req.params.id, updates);

      const updated = await storage.getPromptTemplate(req.params.id);
      res.json(updated);
    } catch (error: any) {
      console.error("Update prompt template error:", error);
      res.status(500).json({ error: "Failed to update prompt template" });
    }
  });

  // Delete prompt template
  app.delete("/api/prompt-templates/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Only owner can delete (not system templates)
      if (template.userId !== req.userId || template.isSystemTemplate) {
        return res.status(403).json({ error: "Cannot delete this template" });
      }

      await storage.deletePromptTemplate(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete prompt template error:", error);
      res.status(500).json({ error: "Failed to delete prompt template" });
    }
  });

  // Use template (increments usage count and returns interpolated content)
  app.post("/api/prompt-templates/:id/use", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Allow access if: own template, system template, or public template
      const isOwn = template.userId === req.userId;
      const isSystem = template.isSystemTemplate;
      const isPublic = template.isPublic;

      if (!isOwn && !isSystem && !isPublic) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { variableValues } = req.body;

      // Interpolate variables
      let systemPrompt = template.systemPrompt;
      let firstMessage = template.firstMessage;

      if (variableValues && typeof variableValues === 'object') {
        for (const [key, value] of Object.entries(variableValues)) {
          const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
          systemPrompt = systemPrompt.replace(regex, String(value));
          if (firstMessage) {
            firstMessage = firstMessage.replace(regex, String(value));
          }
        }
      }

      // Increment usage count
      await storage.incrementPromptTemplateUsage(req.params.id);

      res.json({
        systemPrompt,
        firstMessage,
        suggestedVoiceTone: template.suggestedVoiceTone,
        suggestedPersonality: template.suggestedPersonality,
        usedVariables: variableValues || {},
        missingVariables: (template.variables || []).filter(v =>
          !variableValues || !(v in variableValues)
        )
      });
    } catch (error: any) {
      console.error("Use prompt template error:", error);
      res.status(500).json({ error: "Failed to use prompt template" });
    }
  });

  // Admin: Create/manage system templates
  app.post("/api/admin/prompt-templates/system", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const {
        name,
        description,
        category,
        systemPrompt,
        firstMessage,
        variables,
        suggestedVoiceTone,
        suggestedPersonality
      } = req.body;

      if (!name || !systemPrompt) {
        return res.status(400).json({ error: "Name and system prompt are required" });
      }

      const template = await storage.createPromptTemplate({
        userId: null, // System templates have no owner
        name,
        description: description || null,
        category: category || 'general',
        systemPrompt,
        firstMessage: firstMessage || null,
        variables: variables || null,
        suggestedVoiceTone: suggestedVoiceTone || null,
        suggestedPersonality: suggestedPersonality || null,
        isSystemTemplate: true,
        isPublic: true, // System templates are always public
      } as PromptTemplateInsertRow);

      res.json(template);
    } catch (error: any) {
      console.error("Create system prompt template error:", error);
      res.status(500).json({ error: "Failed to create system prompt template" });
    }
  });

  // Admin Email Templates Routes (supports both platform admins and admin team members)
  app.get("/api/admin/email-templates", checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', 'read'), async (req: AdminRequest, res: Response) => {
    try {
      const templates = await storage.getEmailTemplates();
      res.json(templates);
    } catch (error: any) {
      console.error("Get email templates error:", error);
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
      console.error("Get email template error:", error);
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
      console.error("Update email template error:", error);
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
      console.error("Create email template error:", error);
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
      console.error("Get batch jobs error:", error);
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
      console.error("Get batch job detail error:", error);
      res.status(500).json({ error: "Failed to fetch batch job details" });
    }
  });

  await loadCatalogueAtStartup();
  await (await import("./workforce/runtime/startup.ts")).startWorkforceRuntime();
  app.get("/api/workforce/health", authenticateToken, requireRole("admin"), workforceHealthHandler);
  // Agent writes (create, configure, pause, resume, retire) use the Postgres roster, so they survive a restart and match
  // what the server stores. The retire guard reads running work through the run store. With no active catalogue the
  // roster is unset and those routes return 503 (fail closed).
  const adminDbPool = (await import("./db")).pool as unknown as SqlExecutor;
  const adminCatalogue = getActiveCatalogue();
  const adminRoster = adminCatalogue ? createPgRoster({ db: adminDbPool, catalogue: adminCatalogue }) : undefined;
  const adminRunStore = createPgRunStore(adminDbPool);
  app.use(createWorkforceAdminRouter({
    controls: workforceControls,
    roster: adminRoster,
    getRuns: async (companyId: string) => agentRunsFromRecords(await adminRunStore.listRuns(companyId)),
    isRosterAgent: async (companyId: string, agentId: string) => (await adminRoster?.getAgent(companyId, agentId)) !== undefined,
  }, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireAdmin: requireRole("admin") as unknown as import('express').RequestHandler, requireManager: requireRole("admin", "manager") as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope() }));
  app.use((await import("./workforce/runtime/shadow-routes.ts")).createShadowRouterForProduction((await import("./db")).pool as unknown as import("./workforce/runtime/shadow-routes.ts").ShadowPool, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireApprover: requireRole("admin", "manager") as unknown as import('express').RequestHandler }));
  app.use(createTaskBoardRouter({ store: createPgRunStore((await import("./db")).pool as unknown as SqlExecutor) }, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireAdminOrManager: requireRole("admin", "manager") as unknown as import('express').RequestHandler }));
  app.use(createCompanyControlsRouter({}, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireAdmin: requireRole("admin") as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope() }));
  app.use(createCockpitRouter({}, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireApprover: requireRole("admin", "manager") as unknown as import('express').RequestHandler }));

  // Webhook dead-letter listing: admin or manager only, company from the verified session.
  app.use(createDeadLetterRouter({}, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireApprover: requireRole("admin", "manager") as unknown as import('express').RequestHandler }));

  // Workforce roster read. In-memory roster built from the active catalogue. It holds no agents until one is
  // created in this process, and nothing creates them yet. Switch to createPgRoster once DRAFT_workforce_agents is promoted.
  const workforceCatalogue = getActiveCatalogue();
  const workforceRoster = workforceCatalogue ? createRoster(workforceCatalogue) : null;
  app.use(createWorkforceRosterRouter(
    { listAgents: workforceRoster ? (companyId: string) => listRosterAgents(workforceRoster, companyId) : undefined },
    { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireApprover: requireRole("admin", "manager") as unknown as import('express').RequestHandler },
  ));

  // Comms campaigns, comms host only (requireModule('campaigns') inside the router). Mounted under /api/comms so it
  // does not share the legacy /api/campaigns paths. The store is a placeholder until DRAFT_campaigns is promoted, and
  // approvals and transport refuse every call, so nothing can be approved or sent. Settings and suppression are in memory.
  const commsNotConfigured = async (): Promise<never> => {
    throw new Error("comms: not configured for production");
  };
  const campaignApprovals: ApprovalPort = { gateAction: commsNotConfigured, getApproval: commsNotConfigured, markExecuted: commsNotConfigured };
  const campaignTransport: SendTransport = { send: commsNotConfigured };
  const setCommsActor: import('express').RequestHandler = (req, res, next) => {
    const userId = (req as AuthRequest).userId;
    if (typeof userId === "string" && userId !== "") res.locals.actor = { kind: "human", id: userId };
    next();
  };
  // Durable, company-scoped comms event sink for send audit. The company comes from the verified session (res.locals,
  // set by requireCompanyScope). If it is missing or not a UUID, no sink is set and the send paths record nothing.
  const setCommsEventSink: import('express').RequestHandler = (_req, res, next) => {
    const companyId = (res.locals as { companyId?: unknown }).companyId;
    if (typeof companyId === "string") {
      try {
        res.locals.commsEventSink = commsAudit.forCompanyDurable(companyId);
      } catch {
        delete res.locals.commsEventSink;
      }
    }
    next();
  };
  // Flag COMMS_CAMPAIGNS_ENABLED: new, unfinished module, so it defaults OFF. Set it to 1 to mount.
  const commsCampaignsEnabled = featureEnabled("COMMS_CAMPAIGNS_ENABLED", false);
  console.log(`[flags] COMMS_CAMPAIGNS_ENABLED=${commsCampaignsEnabled ? "on" : "off"} (default off)`);
  if (commsCampaignsEnabled) app.use(
    "/api/comms",
    authenticateToken as unknown as import('express').RequestHandler,
    requireCompanyScope(),
    setCommsActor,
    setCommsEventSink,
    deskModeMiddleware(DEFAULT_MODE_CONFIG) as unknown as import('express').RequestHandler,
    createCampaignRouterForProduction({
      store: createDrizzleCampaignStore(),
      approvals: campaignApprovals,
      transport: campaignTransport,
      companySettings: createCompanySettingsStore(),
      suppression: createSuppressionList({ audit: commsAudit.audit, clock: () => new Date().toISOString() }),
      requireRole: requireRole("admin", "manager") as unknown as import('express').RequestHandler,
    }),
  );

  // Admin Campaign View Routes (allows admins to view any user's campaign)
  app.get("/api/admin/campaigns/:id", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // Include owner info for admin context
      const [owner] = await db.select({
        id: users.id,
        name: users.name,
        email: users.email
      }).from(users).where(eq(users.id, campaign.userId)).limit(1);

      res.json({ ...campaign, owner: owner || null });
    } catch (error: any) {
      console.error("Admin get campaign error:", error);
      res.status(500).json({ error: "Failed to get campaign" });
    }
  });

  app.get("/api/admin/campaigns/:id/contacts", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const contactList = await storage.getCampaignContacts(campaign.id);

      res.json(contactList);
    } catch (error: any) {
      console.error("Admin get campaign contacts error:", error);
      res.status(500).json({ error: "Failed to get campaign contacts" });
    }
  });

  app.get("/api/admin/campaigns/:id/calls", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const callList = await storage.getCampaignCalls(campaign.id);
      res.json(callList);
    } catch (error: any) {
      console.error("Admin get campaign calls error:", error);
      res.status(500).json({ error: "Failed to get campaign calls" });
    }
  });

  app.get("/api/admin/campaigns/:id/batch", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const batchJob = await campaignExecutor.getBatchJobStatus(campaign.id);
      if (!batchJob) {
        return res.json({ batchJob: null, stats: null });
      }

      const stats = BatchCallingService.getBatchStats(batchJob);
      res.json({ batchJob, stats });
    } catch (error: any) {
      console.error("Admin get campaign batch error:", error);
      res.json({ batchJob: null, stats: null });
    }
  });

  // Admin endpoint to migrate userId for orphaned calls
  // This populates userId for existing calls based on campaign/connection ownership
  // Uses batched processing to handle any number of orphaned calls
  app.post("/api/admin/migrate-call-user-ids", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      console.log(`📊 [Admin] Starting call userId migration`);

      let totalProcessed = 0;
      let migrated = 0;
      let failed = 0;
      const errors: string[] = [];
      const unresolvedCallIds: string[] = [];
      const BATCH_SIZE = 500;

      // Process in batches until no orphaned calls remain
      while (true) {
        // Find next batch of orphaned calls, ordered by id for consistent processing
        // Exclude calls already marked as orphaned in metadata to prevent infinite loop
        // Handle null metadata by treating it as not orphaned (needs processing)
        const orphanedCalls = await db
          .select({
            id: calls.id,
            campaignId: calls.campaignId,
            incomingConnectionId: calls.incomingConnectionId,
            callDirection: calls.callDirection,
          })
          .from(calls)
          .where(and(
            isNull(calls.userId),
            sql`NOT COALESCE((COALESCE(metadata, '{}')::jsonb->>'orphaned')::boolean, false)`
          ))
          .orderBy(calls.id)
          .limit(BATCH_SIZE);

        if (orphanedCalls.length === 0) {
          console.log(`   No more orphaned calls to process`);
          break;
        }

        console.log(`   Processing batch of ${orphanedCalls.length} orphaned calls`);
        totalProcessed += orphanedCalls.length;

        for (const call of orphanedCalls) {
          let resolvedUserId: string | null = null;

          try {
            // Try to resolve userId from campaign
            if (call.campaignId) {
              const [campaign] = await db
                .select({ userId: campaigns.userId })
                .from(campaigns)
                .where(eq(campaigns.id, call.campaignId))
                .limit(1);

              if (campaign?.userId) {
                resolvedUserId = campaign.userId;
              }
            }

            // Try to resolve from incoming connection
            if (!resolvedUserId && call.incomingConnectionId) {
              const [connection] = await db
                .select({ userId: incomingConnections.userId })
                .from(incomingConnections)
                .where(eq(incomingConnections.id, call.incomingConnectionId))
                .limit(1);

              if (connection?.userId) {
                resolvedUserId = connection.userId;
              }
            }

            if (resolvedUserId) {
              await db
                .update(calls)
                .set({ userId: resolvedUserId })
                .where(eq(calls.id, call.id));
              migrated++;
            } else {
              // Mark call with a special "ORPHANED" flag in metadata to prevent reprocessing
              // Set userId to empty string to mark as processed but unresolved
              // These calls have no resolvable owner and need manual review
              const currentMetadata = call.campaignId || call.incomingConnectionId
                ? { orphaned: true, reason: 'Owner reference exists but owner not found' }
                : { orphaned: true, reason: 'No campaign or connection reference' };

              await db
                .update(calls)
                .set({
                  metadata: sql`COALESCE(metadata, '{}')::jsonb || ${JSON.stringify(currentMetadata)}::jsonb`
                })
                .where(eq(calls.id, call.id));

              failed++;
              if (unresolvedCallIds.length < 500) {
                unresolvedCallIds.push(call.id);
              }
              if (errors.length < 100) {
                errors.push(`Call ${call.id}: No ownership source found (campaign: ${call.campaignId}, connection: ${call.incomingConnectionId})`);
              }
            }
          } catch (err: any) {
            failed++;
            if (errors.length < 100) {
              errors.push(`Call ${call.id}: ${err.message}`);
            }
          }
        }

        // Safety check - if we've processed many calls without finding resolvable owners
        // and the same orphaned calls keep appearing, prevent infinite loop
        if (totalProcessed > 10000 && migrated === 0) {
          console.warn(`   Breaking - processed ${totalProcessed} calls but none could be migrated`);
          break;
        }
      }

      console.log(`✅ [Admin] Migration complete: ${migrated} migrated, ${failed} unresolvable, ${totalProcessed} total processed`);

      res.json({
        success: true,
        totalProcessed,
        migrated,
        unresolvable: failed,
        unresolvedCallIds: unresolvedCallIds.slice(0, 100), // Return first 100 unresolved IDs for manual review
        errors: errors.slice(0, 50), // Return first 50 errors
        message: failed > 0
          ? `${migrated} calls migrated, ${failed} calls have no resolvable owner (missing campaign/connection reference)`
          : `Successfully migrated all ${migrated} calls`
      });
    } catch (error: any) {
      console.error("Migration error:", error);
      res.status(500).json({ error: "Failed to migrate call user IDs" });
    }
  });

  // Start the campaign scheduler for automatic pause/resume based on time windows
  CampaignScheduler.startBackgroundScheduler();

  // Setup Plivo WebSocket stream on httpServer for OpenAI Realtime audio streaming
  setupPlivoStream(httpServer);

  // Setup Plivo-ElevenLabs WebSocket stream (ISOLATED from Plivo+OpenAI)
  initPlivoElevenLabsStream(httpServer);

  // Setup Twilio-OpenAI WebSocket stream for Media Streams audio bridging
  setupTwilioOpenAIStreamHandler(httpServer);

  return httpServer;
}
