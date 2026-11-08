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
import { calls, campaigns, incomingConnections, users } from "@shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
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
import { checkAdmin } from "./middleware/admin-auth";

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
import { registerUserLimitsRoutes } from "./routes/core/user-limits-routes";
import { registerNotificationAdminRoutes } from "./routes/core/notification-admin-routes";
import { registerPromptTemplateRoutes } from "./routes/core/prompt-template-routes";
import { registerAdminCommsRoutes } from "./routes/core/admin-comms-routes";

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

  // Routes: user limits, see server/routes/core/user-limits-routes.ts
  registerUserLimitsRoutes(app);

  // Routes: notifications and admin broadcast, see server/routes/core/notification-admin-routes.ts
  registerNotificationAdminRoutes(app);

  // Routes: prompt templates, see server/routes/core/prompt-template-routes.ts
  registerPromptTemplateRoutes(app);

  // Routes: admin email templates and batch jobs, see server/routes/core/admin-comms-routes.ts
  registerAdminCommsRoutes(app);

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
