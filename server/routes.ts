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
import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer } from 'ws';
import { storage } from "./storage";
import { db } from "./db";
import { phoneNumbers, agents, calls, creditTransactions, paymentTransactions, phoneNumberRentals, campaigns, contacts, incomingConnections, llmModels, twilioCountries, users, knowledgeBase, userSubscriptions } from "@shared/schema";
import { eq, desc, and, isNull, sql, or } from "drizzle-orm";
import { authenticateToken, authenticateAnyToken, requireRole, generateTokenAsync, checkActiveMembership, checkUserActive, type AuthRequest } from "./middleware/auth";
import { authRateLimiter, strictRateLimiter, paymentRateLimiter } from "./middleware/rateLimiter";
import { validateTwilioWebhook } from "./middleware/webhookValidation";
import { elevenLabsService, ElevenLabsService, isAgentOnSipPhoneNumber, getSipTrunkOutboundAddress } from "./services/elevenlabs";
import { sanitizeLlmModel } from "./utils/llm-sanitize";
import { ElevenLabsPoolService } from "./services/elevenlabs-pool";
import { twilioService } from "./services/twilio";

const elevenLabsPoolService = new ElevenLabsPoolService();
import { getTwilioClient } from "./services/twilio-connector";
import { campaignExecutor } from "./services/campaign-executor";
import { BatchCallingService } from "./services/batch-calling";
import {
  handleTwilioVoiceWebhook,
  handleIncomingCallWebhook,
  handleTwilioStatusWebhook,
  handleTwilioRecordingWebhook,
  handleTwilioStreamWebSocket,
  handleFlowVoiceAnswer,
  handleFlowNode,
  handleFlowGather,
  handleFlowContinue,
  handleFlowStatus,
  handleElevenLabsWebhook,
  fetchElevenLabsConversation,
  handleRAGToolWebhook,
  handleAppointmentToolWebhook,
  handleFormSubmissionWebhook,
  handlePlayAudioToolWebhook,
} from "./routes/webhook-routes";
// Flow Agent WebSocket handler removed - all agents now execute through ElevenLabs
import { getDomain } from "./utils/domain";
import { adminRouter } from "./routes/admin-routes";
import { maintenanceMiddleware } from "./services/system-update-service";
import adminTeamAccessRoutes from "./routes/admin-team-access.routes";
import { createPublicRoutes } from "./routes/public-routes";
import { createAuthRoutes } from "./routes/auth-routes";
import { createAgentRoutes } from "./routes/agent-routes";
import { createCampaignRoutes } from "./routes/campaign-routes";
import { createPhoneRoutes } from "./routes/phone-routes";
import { createUserAddressRoutes } from "./routes/user-address-routes";
import { createAnalyticsRoutes } from "./routes/analytics-routes";
import { createRouteContext } from "./routes/common";
// Payment Engine v1.0.0 - All payment gateway routers
import {
  stripeRouter,
  razorpayRouter,
  paypalRouter,
  paystackRouter,
  mercadopagoRouter,
  yookassaRouter,
  PAYMENT_ENGINE_VERSION,
} from "./engines/payment";
// Plivo + OpenAI Realtime Engine
import { createPlivoApiRoutes, setupPlivoWebhooks, setupPlivoStream } from "./engines/plivo";
// Plivo-ElevenLabs SIP Trunk Engine (ISOLATED from Twilio+ElevenLabs)
import { initPlivoElevenLabsEngine, initPlivoElevenLabsStream } from "./engines/plivo-elevenlabs";
// Twilio + OpenAI Realtime Engine (ISOLATED from Twilio+ElevenLabs and Plivo+OpenAI)
import { twilioOpenaiWebhookRoutes, setupTwilioOpenAIStreamHandler, twilioOpenaiIncomingConnectionsRoutes } from "./engines/twilio-openai";
// KYC Engine
import { registerKycRoutes } from "./engines/kyc";
import { checkAdmin, checkAdminOrTeamMember, requireAdminPermission, AdminRequest } from "./middleware/admin-auth";
import { hybridGateUnlessExempt } from "./middleware/hybrid-gate-exemptions";
import flowAutomationRouter from "./routes/flow-automation-routes";
import { flows, FlowNode, FlowEdge, insertPromptTemplateSchema, promptTemplates } from "@shared/schema";

// Table insert shape for createPromptTemplate; the drizzle-zod insert type resolves to {}.
type PromptTemplateInsertRow = typeof promptTemplates.$inferInsert & { companyId?: string };
import { ElevenLabsFlowCompiler } from "./services/elevenlabs-flow-compiler";
import incomingConnectionsRouter from "./routes/incoming-connections-routes";
import llmModelsRouter from "./routes/llm-models-routes";
import { googleSheetsRouter } from "./services/google-sheets/google-sheets.routes";
import platformLanguagesRouter, { platformLanguagesPublicRouter } from "./routes/platform-languages-routes";
import transactionsRouter from "./routes/transactions-routes";
import refundRouter from "./routes/refund-routes";
import invoiceRouter from "./routes/invoice-routes";
import emailSettingsRouter from "./routes/email-settings-routes";
import audioRoutes from "./routes/audio-routes";
import { createRAGKnowledgeRoutes } from "./routes/rag-knowledge-routes";
import { createNotificationRoutes } from "./routes/notification-routes";
import { createTitanFieldBridgeRouter } from "./integrations/titan-field/route";
import { createTitanLocalLinkRouter } from "./integrations/titan-field/local-link-route";
import { createUserWebhookRoutes } from "./routes/user-webhook-routes";
import { createTemplateRoutes } from "./routes/template-routes";
import { createUserSipGatewaysRoutes } from "./routes/user-sip-gateways.routes";
import { createSubscriptionRoutes } from "./routes/subscription-routes";
import crmRoutes from "./routes/crm-routes";
import { widgetRoutes, publicWidgetRoutes } from "./modules/widget";
// REST API Plugin - loaded dynamically so server starts without it
import bcrypt from "bcrypt";
import multer from "multer";
import Papa from "papaparse";
// Team Management Middleware - allows team members to access user data with their parent's userId
// Uses adapter for optional plugin loading
import { getTeamContextMiddleware, isTeamManagementInstalled, initializeAdapter as initTeamAdapter } from "./plugins/team-management-adapter";
import crypto from "crypto";
import { validateAppointmentWebhookToken } from "./services/appointment-elevenlabs-tool";
import { NotificationService } from "./services/notification-service";
import { IncomingAgentService } from "./services/incoming-agent";
import { FlowAgentService } from "./services/flow-agent";
import { setupRAGToolForAgent, isRAGEnabled } from "./services/rag-elevenlabs-tool";
import PDFDocument from "pdfkit";
import { webhookDeliveryService } from "./services/webhook-delivery";
import { webhookTestService } from "./services/webhook-test-service";
import { contactUploadService, PlanLimitExceededError } from "./services/contact-upload-service";
import { recordingService } from "./services/recording-service";
import { CampaignScheduler } from "./services/campaign-scheduler";
import { emailService } from "./services/email-service";
import { generateRefundNoteForRefund, refundNoteService } from "./services/refund-note-service";
import { safeErrorMessage } from "./utils/safe-error";
import { markPluginAsRegistered } from "./plugins/loader";
import { registerChatbotModule } from "./modules/chatbot/index.ts";
import { mountChatbotModule, WIRING_FLAGS } from "./modules/chatbot/wiring/mount.ts";
import { CONTRACT_FLAGS, readFlag } from "./modules/chatbot/contracts/flags.ts";
import { createSecretBox } from "./modules/chatbot/secrets/secret-box.ts";
import { startChatbotWorkersFromEnv } from "./modules/chatbot/workers/boot.ts";
import { captureChatbotWebhookRawBody } from "./middleware/raw-body.ts";
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
import { registerApprovalModule } from "./modules/approvals/index.ts";
import { requireCompanyScope } from "./middleware/company-scope";
import { createCockpitRouter, DEFAULT_MODE_CONFIG } from "./routes/cockpit-routes";
import { createProviderWebhookRateLimit, readTwilioAccountSid, TWILIO_ACCOUNT_SID_PATTERN } from "./middleware/provider-webhook-rate-limit";

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

  // Register public routes (installer, health, branding, SEO, contact, etc.)
  const publicRoutes = createPublicRoutes(routeContext);
  app.use(publicRoutes);

  // Register authentication routes (login, register, OTP, password, etc.)
  const authRoutes = createAuthRoutes(routeContext);
  app.use(authRoutes);

  // Apply team context middleware globally for all user-facing /api routes
  // This allows team members to access data using their parent user's userId
  // The middleware only activates when Team Management plugin is installed and
  // a Bearer token is present from team member auth
  if (isTeamManagementInstalled()) {
    await initTeamAdapter();
    app.use('/api', getTeamContextMiddleware());
    console.log('✅ Team Management plugin detected - team context middleware enabled');
  }

  // Register agent routes (agents CRUD, knowledge base, versions, voices)
  const agentRoutes = createAgentRoutes(routeContext);
  app.use(agentRoutes);

  // Register campaign routes (campaigns CRUD, contacts, execution)
  const campaignRoutes = createCampaignRoutes(routeContext);
  app.use(campaignRoutes);

  // Register phone number routes (phone numbers CRUD, Twilio integration)
  const phoneRoutes = createPhoneRoutes(routeContext);
  app.use(phoneRoutes);

  // Register user address routes (for phone number regulatory compliance)
  const userAddressRoutes = createUserAddressRoutes(routeContext);
  app.use(userAddressRoutes);

  // Register analytics routes (dashboard, analytics, calls)
  const analyticsRoutes = createAnalyticsRoutes(routeContext);
  app.use(analyticsRoutes);

  // Register notification routes
  const notificationRoutes = createNotificationRoutes(routeContext);
  app.use(notificationRoutes);

  // TITAN: signed simulation-only Field communication intent bridge.
  // Deliberately unconfigured: the separate database integration owner must
  // supply company mapping, consent verification and an atomic event ledger.
  // No provider sending is performed; route returns 503 unless enabled.
  app.use(createTitanFieldBridgeRouter());
  // Read-only signed same-host Field/Desk capability handshake.
  app.use(createTitanLocalLinkRouter());

  // Register user webhook routes (subscription management)
  const userWebhookRoutes = createUserWebhookRoutes(routeContext, { requireCompanyScope: requireCompanyScope() as unknown as import('express').RequestHandler });
  app.use(userWebhookRoutes);

  // Register user SIP gateway routes (per-user SIP management from /app/phone-numbers)
  const userSipGatewaysRoutes = createUserSipGatewaysRoutes();
  app.use(userSipGatewaysRoutes);

  // Register template routes (prompt templates)
  const templateRoutes = createTemplateRoutes(routeContext);
  app.use(templateRoutes);

  // Register subscription routes (plans, credits, billing)
  const subscriptionRoutes = createSubscriptionRoutes(routeContext);
  app.use(subscriptionRoutes);

  // Register Plivo + OpenAI Realtime Engine routes
  // Apply authenticateToken middleware only to user-facing Plivo API routes (not webhooks/stream)
  // Webhooks need to remain unauthenticated for Plivo callbacks
  // TODO: Express middleware type compatibility - authenticateToken uses AuthRequest (extends Request)
  // but app.use() expects RequestHandler<Request>. Fixing requires refactoring all middleware to use
  // generics or a wrapper function. Using 'as unknown as RequestHandler' for explicit type unsafety.
  app.use('/api/plivo/openai', authenticateToken as unknown as import('express').RequestHandler);
  app.use('/api/plivo/phone-numbers', authenticateToken as unknown as import('express').RequestHandler);
  // Note: /api/plivo/admin routes use requireAdminAuth + requireAdminPermission middleware at route level
  // to support both platform admins (JWT) and admin team members (session tokens)
  app.use('/api/plivo/incoming-connections', authenticateToken as unknown as import('express').RequestHandler);
  const plivoApiRoutes = createPlivoApiRoutes();
  app.use(plivoApiRoutes);

  // Setup Plivo webhooks for voice calls
  const plivoBaseUrl = getDomain();
  setupPlivoWebhooks(app, plivoBaseUrl);
  // Plivo WebSocket stream is set up on httpServer below (after other upgrade handlers)

  // Start the stuck calls cleanup scheduler for Plivo engine
  import("./engines/plivo/services/plivo-call.service").then(({ PlivoCallService }) => {
    PlivoCallService.startStuckCallsScheduler();
  }).catch((error) => {
    console.error('❌ Failed to start Plivo stuck calls scheduler:', error.message);
  });

  console.log('✅ Plivo + OpenAI Realtime Engine initialized');

  // Initialize Plivo-ElevenLabs SIP Trunk Engine (ISOLATED from Twilio+ElevenLabs)
  // This provides Plivo SIP trunk to ElevenLabs connection for Indian phone numbers
  initPlivoElevenLabsEngine(app);
  console.log('✅ Plivo-ElevenLabs SIP Trunk Engine initialized');

  // Initialize Twilio + OpenAI Realtime Engine (ISOLATED from Twilio+ElevenLabs and Plivo+OpenAI)
  // This provides Twilio telephony with OpenAI Realtime API for international calling
  app.use('/api/twilio-openai', twilioOpenaiWebhookRoutes);
  // TODO: Express middleware type compatibility - see note above about authenticateToken
  app.use('/api/twilio-openai/incoming-connections', authenticateToken as unknown as import('express').RequestHandler, twilioOpenaiIncomingConnectionsRoutes);
  console.log('✅ Twilio + OpenAI Realtime Engine initialized');

  // Register KYC Engine routes
  // TODO: Express middleware type compatibility - KYC engine accepts generic middleware types
  // but authenticateToken/checkAdmin use extended Request types. Fixing requires updating the
  // KYC engine interface to accept properly typed middleware.
  registerKycRoutes(
    app,
    authenticateToken as unknown as import('express').RequestHandler,
    checkAdmin as unknown as import('express').RequestHandler
  );

  // Register SIP Engine Plugin dynamically with service injection (only if plugin directory exists)
  try {
    const { importPlugin } = await import('./utils/plugin-import');
    const sipEnginePlugin = await importPlugin('plugins/sip-engine/index.ts');
    const { canAssignSipAgent } = await import("./services/sip-credit-guard");
    const { deductSipCallCredits, checkUserCreditBalance } = await import("./services/credit-service");

    sipEnginePlugin.registerSipEngineRoutes(app, {
      sessionAuthMiddleware: authenticateToken as unknown as import('express').RequestHandler,
      adminAuthMiddleware: checkAdminOrTeamMember as unknown as import('express').RequestHandler,
      sipServices: {
        canAssignSipAgent,
        deductSipCallCredits,
        checkUserCreditBalance,
        ElevenLabsService,
        getCredentialForAgent: ElevenLabsPoolService.getCredentialForAgent.bind(ElevenLabsPoolService),
      },
    });
    markPluginAsRegistered('sip-engine');
    console.log('✅ SIP Engine Plugin initialized with service injection');
  } catch (err: any) {
    console.log('[SIP Engine Plugin] Not installed - skipping direct registration');
  }

  // Register REST API Plugin dynamically (only if plugin directory exists)
  try {
    const { importPlugin: importRestPlugin } = await import('./utils/plugin-import');
    const restApiPlugin = await importRestPlugin('plugins/rest-api/index.ts');

    const { OutboundCallService } = await import("./services/outbound-call-service");
    let PlivoCallServiceRef: any = null;
    let TwilioOpenAICallServiceRef: any = null;
    try {
      const plivoMod = await import("./engines/plivo/services/plivo-call.service");
      PlivoCallServiceRef = plivoMod.PlivoCallService;
    } catch { }
    try {
      const twilioMod = await import("./engines/twilio-openai/services/twilio-openai-call.service");
      TwilioOpenAICallServiceRef = twilioMod.TwilioOpenAICallService;
    } catch { }

    await restApiPlugin.registerRestApiRoutes(app, {
      sessionAuthMiddleware: authenticateToken as unknown as import('express').RequestHandler,
      adminAuthMiddleware: checkAdminOrTeamMember as unknown as import('express').RequestHandler,
      callServices: {
        OutboundCallService,
        getCredentialForAgent: ElevenLabsPoolService.getCredentialForAgent.bind(ElevenLabsPoolService),
        PlivoCallService: PlivoCallServiceRef,
        TwilioOpenAICallService: TwilioOpenAICallServiceRef,
        campaignExecutor,
      },
    });
    markPluginAsRegistered('rest-api');
    console.log('✅ REST API Plugin initialized');
  } catch (err: any) {
    console.log('[REST API Plugin] Not installed - skipping direct registration');
  }

  // Register Plugin Installer Routes FIRST (before general plugin routes to avoid /:name param conflict)
  const pluginInstallerRoutes = await import('./routes/plugin-installer');
  app.use('/api/admin/plugins/installer', checkAdminOrTeamMember, pluginInstallerRoutes.default);

  // Register Plugin Management Routes (Admin or team member with permissions)
  // Allows viewing and managing installed plugins
  const pluginRoutes = await import('./routes/plugin-routes');
  app.use('/api/admin/plugins', checkAdminOrTeamMember, requireAdminPermission('settings', 'plugins', 'read'), pluginRoutes.default);
  // Public plugin bundle endpoint (no auth required - bundles are just JS code)
  app.use('/api/plugins', pluginRoutes.publicPluginRouter);
  // User-accessible plugin capabilities endpoint (requires auth for user-specific data)
  // Uses authenticateAnyToken to accept both user JWTs and admin team session tokens
  app.use('/api/plugins', authenticateAnyToken, pluginRoutes.userPluginRouter);

  console.log('✅ Plugin Management routes initialized');

  // Auto-load any additional plugins from /plugins directory
  // This allows installing new plugins by just copying the folder and restarting
  try {
    const { loadPlugins } = await import('./plugins/loader');
    const { workforceLoaderOptions } = await import('./integrations/workforce-runtime/titan-ports');
    const loadedPlugins = await loadPlugins(app, {
      sessionAuthMiddleware: authenticateToken as unknown as import('express').RequestHandler,
      adminAuthMiddleware: checkAdminOrTeamMember as unknown as import('express').RequestHandler,
      // Workforce previews require a named permission. Team membership alone is not enough (D2).
      workforceAdminMiddleware: [
        checkAdminOrTeamMember as unknown as import('express').RequestHandler,
        requireAdminPermission('workforce', 'previews', 'create') as unknown as import('express').RequestHandler,
      ],
      httpServer,
      ...workforceLoaderOptions(),
    });
    if (loadedPlugins.filter(p => p.registered).length > 0) {
      console.log(`✅ Auto-loaded ${loadedPlugins.filter(p => p.registered).length} plugin(s) from /plugins directory`);
    }
  } catch (error) {
    console.warn('[Plugin Loader] Failed to auto-load plugins:', error);
  }

  // LLM Models - Get available models for current user (filtered by plan tier)
  app.get("/api/llm-models/available", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const { llmModels } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      // Get user to check their plan tier
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Fetch all active models
      const allModels = await db
        .select()
        .from(llmModels)
        .where(eq(llmModels.isActive, true))
        .orderBy(llmModels.sortOrder, llmModels.name);

      // Admins and Pro users can see all models
      if (user.role === 'admin' || user.planType === 'pro') {
        return res.json(allModels);
      }

      // Free users can only see free tier models
      const freeModels = allModels.filter(model => model.tier === 'free');
      res.json(freeModels);
    } catch (error: any) {
      console.error("Get available LLM models error:", error);
      res.status(500).json({ error: "Failed to get available LLM models" });
    }
  });

  app.post("/api/admin/users/:id/credits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const { amount, description } = req.body;

      if (typeof amount !== "number") {
        return res.status(400).json({ error: "Amount is required and must be a number" });
      }

      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const newCredits = user.credits + amount;
      await storage.updateUserCredits(user.id, newCredits);

      await storage.createCreditTransaction({
        userId: user.id,
        type: amount > 0 ? "credit" : "debit",
        amount,
        description: description || (amount > 0 ? "Credit added by admin" : "Credit deducted by admin"),
        reference: null,
        stripePaymentId: null,
      });

      res.json({ success: true, newCredits });
    } catch (error: any) {
      console.error("Update user credits error:", error);
      res.status(500).json({ error: "Failed to update user credits" });
    }
  });

  // Admin: Get user's effective limits and overrides
  app.get("/api/admin/users/:id/limits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const limits = await storage.getUserEffectiveLimits(req.params.id);

      // Get subscription overrides if any
      const subscription = await storage.getUserSubscription(req.params.id);

      // Get current usage counts
      const webhookCount = await storage.getUserWebhookCount(req.params.id);
      const kbCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeBase)
        .where(eq(knowledgeBase.userId, req.params.id));
      const flowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(eq(flows.userId, req.params.id));
      const phoneCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, req.params.id));

      res.json({
        userId: req.params.id,
        effectiveLimits: limits,
        overrides: subscription ? {
          overrideMaxWebhooks: subscription.overrideMaxWebhooks,
          overrideMaxKnowledgeBases: subscription.overrideMaxKnowledgeBases,
          overrideMaxFlows: subscription.overrideMaxFlows,
          overrideMaxPhoneNumbers: subscription.overrideMaxPhoneNumbers
        } : null,
        currentUsage: {
          webhooks: webhookCount,
          knowledgeBases: Number(kbCount[0]?.count || 0),
          flows: Number(flowCount[0]?.count || 0),
          phoneNumbers: Number(phoneCount[0]?.count || 0)
        }
      });
    } catch (error: any) {
      console.error("Get user limits error:", error);
      res.status(500).json({ error: "Failed to get user limits" });
    }
  });

  // Admin: Update user's limit overrides
  app.patch("/api/admin/users/:id/limits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const body = req.body;

      // Coerce and validate limit values: accept null, undefined (no change), or valid integers
      // Empty strings and "null" strings are coerced to null for convenience
      const coerceAndValidate = (value: any, name: string): number | null | undefined => {
        // undefined means don't change existing value
        if (value === undefined) return undefined;
        // null, empty string, or "null" string means inherit from plan
        if (value === null || value === '' || value === 'null') return null;
        // Coerce string numbers to integers
        const numValue = typeof value === 'string' ? parseInt(value, 10) : value;
        if (typeof numValue !== 'number' || isNaN(numValue) || numValue < 0 || !Number.isInteger(numValue)) {
          throw new Error(`${name} must be null (inherit from plan) or a non-negative integer (use 999 for unlimited)`);
        }
        return numValue;
      };

      const overrideMaxWebhooks = coerceAndValidate(body.overrideMaxWebhooks, 'overrideMaxWebhooks');
      const overrideMaxKnowledgeBases = coerceAndValidate(body.overrideMaxKnowledgeBases, 'overrideMaxKnowledgeBases');
      const overrideMaxFlows = coerceAndValidate(body.overrideMaxFlows, 'overrideMaxFlows');
      const overrideMaxPhoneNumbers = coerceAndValidate(body.overrideMaxPhoneNumbers, 'overrideMaxPhoneNumbers');

      // Get or create subscription
      let subscription = await storage.getUserSubscription(req.params.id);

      if (!subscription) {
        // Create a free subscription with overrides
        subscription = await storage.createUserSubscription({
          userId: req.params.id,
          planId: 'free',
          status: 'active',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
          overrideMaxWebhooks: overrideMaxWebhooks ?? null,
          overrideMaxKnowledgeBases: overrideMaxKnowledgeBases ?? null,
          overrideMaxFlows: overrideMaxFlows ?? null,
          overrideMaxPhoneNumbers: overrideMaxPhoneNumbers ?? null
        });
      } else {
        // Update existing subscription with new overrides
        await db.update(userSubscriptions)
          .set({
            overrideMaxWebhooks: overrideMaxWebhooks !== undefined ? overrideMaxWebhooks : subscription.overrideMaxWebhooks,
            overrideMaxKnowledgeBases: overrideMaxKnowledgeBases !== undefined ? overrideMaxKnowledgeBases : subscription.overrideMaxKnowledgeBases,
            overrideMaxFlows: overrideMaxFlows !== undefined ? overrideMaxFlows : subscription.overrideMaxFlows,
            overrideMaxPhoneNumbers: overrideMaxPhoneNumbers !== undefined ? overrideMaxPhoneNumbers : subscription.overrideMaxPhoneNumbers
          })
          .where(eq(userSubscriptions.id, subscription.id));
      }

      // Return updated limits
      const newLimits = await storage.getUserEffectiveLimits(req.params.id);
      res.json({ success: true, effectiveLimits: newLimits });
    } catch (error: any) {
      console.error("Update user limits error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to update user limits") });
    }
  });

  // Admin: Reset user's limit overrides to plan defaults
  app.delete("/api/admin/users/:id/limits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const subscription = await storage.getUserSubscription(req.params.id);

      if (subscription) {
        // Reset all overrides to null (inherit from plan)
        await db.update(userSubscriptions)
          .set({
            overrideMaxWebhooks: null,
            overrideMaxKnowledgeBases: null,
            overrideMaxFlows: null,
            overrideMaxPhoneNumbers: null
          })
          .where(eq(userSubscriptions.id, subscription.id));
      }

      // Return updated limits
      const newLimits = await storage.getUserEffectiveLimits(req.params.id);
      res.json({ success: true, effectiveLimits: newLimits, message: "User limits reset to plan defaults" });
    } catch (error: any) {
      console.error("Reset user limits error:", error);
      res.status(500).json({ error: "Failed to reset user limits" });
    }
  });

  // Contacts routes
  app.get("/api/contacts", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const allContacts = await storage.getUserContacts(req.userId!);

      // Check if pagination is requested
      const requestsPagination = req.query.page !== undefined || req.query.pageSize !== undefined;

      if (requestsPagination) {
        const page = parseInt(req.query.page as string, 10) || 1;
        const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
        const offset = (page - 1) * pageSize;

        const totalItems = allContacts.length;
        const totalPages = Math.ceil(totalItems / pageSize);

        const paginatedContacts = allContacts.slice(offset, offset + pageSize);

        res.json({
          data: paginatedContacts,
          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages
          }
        });
      } else {
        // Return plain array for backward compatibility
        res.json(allContacts);
      }
    } catch (error: any) {
      console.error("Get all contacts error:", error);
      res.status(500).json({ error: "Failed to get contacts" });
    }
  });

  app.get("/api/contacts/deduplicated", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const contacts = await storage.getUserContactsDeduplicated(req.userId!);
      res.json(contacts);
    } catch (error: any) {
      console.error("Get deduplicated contacts error:", error);
      res.status(500).json({ error: "Failed to get deduplicated contacts" });
    }
  });

  app.delete("/api/contacts/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const contact = await storage.getContact(req.params.id);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }

      // Verify the contact's campaign belongs to the user
      const campaign = await storage.getCampaign(contact.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Not authorized to delete this contact" });
      }

      await storage.deleteContact(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete contact error:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  // Tools routes
  app.get("/api/tools", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const tools = await storage.getUserTools(req.userId!);
      res.json(tools);
    } catch (error: any) {
      console.error("Get tools error:", error);
      res.status(500).json({ error: "Failed to get tools" });
    }
  });

  // ElevenLabs Agents routes
  app.get("/api/elevenlabs/agents", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agents = await storage.getUserAgents(req.userId!);
      res.json(agents);
    } catch (error: any) {
      console.error("Get agents error:", error);
      res.status(500).json({ error: "Failed to get agents" });
    }
  });

  app.post("/api/elevenlabs/agents", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const {
        type = 'natural',
        name,
        voiceTone,
        personality,
        systemPrompt,
        elevenLabsVoiceId,
        language,
        model,
        firstMessage,
        temperature,
        transferRules,
        knowledgeBaseIds,
        flowId,
        maxDurationSeconds,
        voiceStability,
        voiceSimilarityBoost,
        voiceSpeed,
        detectLanguageEnabled,
      } = req.body;

      // Base validation - name and voice required for both types
      // Note: Both agent types need elevenLabsVoiceId:
      //   - Natural agents: voice for ElevenLabs Conversational AI
      //   - Flow agents: voice for ElevenLabs TTS (text-to-speech)
      if (!name || !elevenLabsVoiceId) {
        return res.status(400).json({ error: "Agent name and voice are required" });
      }

      // Type-specific validation
      if (type === 'natural' && !systemPrompt) {
        return res.status(400).json({ error: "Natural agents require a system prompt" });
      }

      if (type === 'flow' && !flowId) {
        return res.status(400).json({ error: "Flow agents require a flow to be selected" });
      }

      // Check user's plan limits
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      // Count existing agents
      const existingAgents = await storage.getUserAgents(req.userId!);
      // Skip limit check if explicitly unlimited (-1 or 999)
      if (plan.maxAgents !== -1 && plan.maxAgents !== 999 && existingAgents.length >= plan.maxAgents) {
        return res.status(403).json({
          error: `Agent limit reached. Your ${plan.displayName} plan allows maximum ${plan.maxAgents} agent(s). Please upgrade to create more agents.`,
          upgradeRequired: true
        });
      }

      // Build tools configuration if transfer rules are provided
      const tools = transferRules && transferRules.length > 0 ? [{
        type: "transfer_to_number" as const,
        description: "Transfer user to human support when needed",
        transfer_rules: transferRules,
      }] : undefined;

      // Create ElevenLabs agent based on type
      let elevenLabsAgentId: string | null = null;
      let agentLink: string | null = null;
      let usedCredentialId: string | null = null;

      if (type === 'natural') {
        // Use user credential affinity - ensures all user's resources stay on same ElevenLabs account
        const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);
        if (!credential) {
          return res.status(500).json({ error: "No available ElevenLabs API keys" });
        }
        usedCredentialId = credential.id;
        const credentialService = new ElevenLabsService(credential.apiKey);

        // Natural Agent: Create ElevenLabs Conversational AI agent
        // Get KB objects from our knowledge base IDs
        let knowledgeBases: Array<{ type: string; title: string; elevenLabsDocId: string }> | undefined;
        if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
          const kbItems = await Promise.all(
            knowledgeBaseIds.map((id: string) => storage.getKnowledgeBaseItem(id))
          );
          // Verify ownership and filter valid items
          knowledgeBases = kbItems
            .filter(item => item && item.userId === req.userId && item.elevenLabsDocId)
            .map(item => ({
              type: item!.type,
              title: item!.title,
              elevenLabsDocId: item!.elevenLabsDocId!
            }));

          console.log(`📚 Filtered ${knowledgeBases.length} valid knowledge base items from ${knowledgeBaseIds.length} selected`);
        }

        // Create agent in ElevenLabs
        const elevenLabsAgent = await credentialService.createAgent({
          name,
          prompt: systemPrompt!,
          voice_id: elevenLabsVoiceId,
          language: language || "en",
          model: model || "gpt-4o-mini",
          first_message: firstMessage || "Hello! How can I help you today?",
          temperature: temperature !== undefined ? temperature : 0.5,
          voice_tone: voiceTone,
          personality: personality,
          tools: tools,
          knowledge_bases: knowledgeBases,
        });

        elevenLabsAgentId = elevenLabsAgent.agent_id;
        agentLink = `https://elevenlabs.io/app/conversational-ai/call/${elevenLabsAgent.agent_id}`;
      } else if (type === 'flow') {
        // Use user credential affinity - ensures all user's resources stay on same ElevenLabs account
        const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);
        if (!credential) {
          return res.status(500).json({ error: "No available ElevenLabs API keys" });
        }
        usedCredentialId = credential.id;
        const credentialService = new ElevenLabsService(credential.apiKey);

        // Flow Agent: Compile flow and create ElevenLabs agent with workflow
        console.log(`🔄 Creating Flow Agent with flowId: ${flowId}`);

        // Fetch the flow from database
        const [flow] = await db
          .select()
          .from(flows)
          .where(and(eq(flows.id, flowId), eq(flows.userId, req.userId!)));

        if (!flow) {
          return res.status(404).json({ error: "Flow not found or access denied" });
        }

        console.log(`📋 Found flow: ${flow.name} with ${(flow.nodes as FlowNode[]).length} nodes`);

        // Compile the flow to ElevenLabs workflow format
        const compiler = new ElevenLabsFlowCompiler(
          flow.nodes as FlowNode[],
          flow.edges as FlowEdge[]
        );
        const compileResult = compiler.compile();
        const compiledWorkflow = compileResult.workflow;
        const flowFirstMessage = compileResult.firstMessage;

        // Validate the compiled workflow
        const validation = compiler.validate();
        if (!validation.valid) {
          console.warn(`⚠️ Flow validation warnings:`, validation.errors);
        }

        console.log(`✅ Compiled workflow: ${Object.keys(compiledWorkflow.nodes).length} nodes, ${Object.keys(compiledWorkflow.edges).length} edges`);
        if (flowFirstMessage) {
          console.log(`📝 First message from flow: "${flowFirstMessage.substring(0, 50)}..."`);
        }

        // For Flow agents: Flow's extracted first message takes PRIORITY over request's firstMessage
        // This ensures the agent says the scripted message from the flow, not a form default
        const effectiveFirstMessage = flowFirstMessage || firstMessage;

        // Smart TTS model selection: English uses eleven_turbo_v2, non-English uses admin setting or eleven_multilingual_v2
        // Note: ElevenLabs requires "turbo or flash v2" for conversational agents - v2_5 models are NOT supported
        const isEnglishAgent2 = (language || 'en') === 'en';
        let adminTtsModel: string;
        if (isEnglishAgent2) {
          adminTtsModel = 'eleven_turbo_v2';
        } else {
          const ttsModelSetting = await storage.getGlobalSetting('default_tts_model');
          adminTtsModel = (ttsModelSetting?.value as string) || 'eleven_multilingual_v2';
        }

        // Fetch KB objects with full details (ElevenLabs requires type, id, and name)
        const flowKnowledgeBases: Array<{ type: string; name: string; id: string }> = [];
        if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length > 0) {
          console.log(`📚 [Flow] Preparing ${knowledgeBaseIds.length} knowledge base(s)`);

          for (const kbId of knowledgeBaseIds) {
            try {
              const kbItem = await storage.getKnowledgeBaseItem(kbId);

              if (!kbItem) {
                console.warn(`⚠️  Knowledge base item ${kbId} not found, skipping`);
                continue;
              }

              if (!kbItem.elevenLabsDocId) {
                console.warn(`⚠️  Knowledge base item ${kbId} has no ElevenLabs doc ID, skipping`);
                continue;
              }

              console.log(`   Adding KB "${kbItem.title}" (${kbItem.elevenLabsDocId})`);
              flowKnowledgeBases.push({
                type: kbItem.type === 'text' ? 'text' : 'file',
                name: kbItem.title,
                id: kbItem.elevenLabsDocId
              });
            } catch (error: any) {
              console.error(`   ❌ Failed to fetch KB ${kbId}:`, error.message);
            }
          }
        }

        // Create Flow Agent in ElevenLabs with compiled workflow
        const elevenLabsAgent = await credentialService.createFlowAgent({
          name,
          voice_id: elevenLabsVoiceId,
          language: language || "en",
          maxDurationSeconds: maxDurationSeconds ?? 600,
          voiceStability: voiceStability ?? 0.5,
          voiceSimilarityBoost: voiceSimilarityBoost ?? 0.75,
          voiceSpeed: voiceSpeed ?? 1.0,
          detectLanguageEnabled: detectLanguageEnabled || false,
          systemPrompt: systemPrompt || undefined,
          firstMessage: effectiveFirstMessage || undefined, // Use extracted first message from flow
          knowledgeBases: flowKnowledgeBases.length > 0 ? flowKnowledgeBases : undefined,
          ttsModel: adminTtsModel,
          workflow: compiledWorkflow,
        });

        elevenLabsAgentId = elevenLabsAgent.agent_id;
        agentLink = `https://elevenlabs.io/app/conversational-ai/call/${elevenLabsAgent.agent_id}`;

        console.log(`✅ Flow Agent created in ElevenLabs: ${elevenLabsAgentId}`);
      }

      // Store in database - save all fields for both agent types
      const agent = await storage.createAgent({
        type: type as 'natural' | 'flow',
        userId: req.userId!,
        name,
        voiceTone: voiceTone || (type === 'natural' ? "professional" : null),
        personality: personality || (type === 'natural' ? "helpful" : null),
        systemPrompt: systemPrompt || null,
        language: language || "en",
        firstMessage: firstMessage || (type === 'natural' ? "Hello! How can I help you today?" : null),
        llmModel: model || (type === 'natural' ? "gpt-4o-mini" : null),
        temperature: temperature !== undefined ? temperature : (type === 'natural' ? 0.5 : null),
        elevenLabsVoiceId: elevenLabsVoiceId,
        elevenLabsAgentId: elevenLabsAgentId,
        agentLink: agentLink,
        // Multi-key pool affinity - store which credential created this agent
        elevenLabsCredentialId: usedCredentialId,
        // Knowledge base - enabled for both natural and flow agents
        knowledgeBaseIds: knowledgeBaseIds || null,
        // Flow Agent fields
        flowId: flowId || null,
        maxDurationSeconds: maxDurationSeconds ?? (type === 'flow' ? 600 : null),
        voiceStability: voiceStability ?? (type === 'flow' ? 0.5 : null),
        voiceSimilarityBoost: voiceSimilarityBoost ?? (type === 'flow' ? 0.75 : null),
        voiceSpeed: voiceSpeed ?? (type === 'flow' ? 1.0 : null),
        // System Tools - enabled for flow agents
        detectLanguageEnabled: type === 'flow' ? (detectLanguageEnabled || false) : false,
        config: {
          elevenLabsVoiceId,
          model: model || "gpt-4o-mini",
          firstMessage,
          temperature,
          transferRules: type === 'natural' ? transferRules : null,
          knowledgeBaseIds: knowledgeBaseIds || [],
        },
      });

      res.json(agent);
    } catch (error: any) {
      console.error("Create agent error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to create agent") });
    }
  });

  app.patch("/api/elevenlabs/agents/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const {
        type,
        name,
        voiceTone,
        personality,
        systemPrompt,
        elevenLabsVoiceId,
        language,
        model,
        firstMessage,
        temperature,
        transferRules,
        knowledgeBaseIds,
        flowId,
        maxDurationSeconds,
        voiceStability,
        voiceSimilarityBoost,
        voiceSpeed,
        detectLanguageEnabled,
      } = req.body;

      // Build tools configuration if transfer rules are provided
      const tools = transferRules && transferRules.length > 0 ? [{
        type: "transfer_to_number" as const,
        description: "Transfer user to human support when needed",
        transfer_rules: transferRules,
      }] : undefined;

      // Get ElevenLabs doc IDs from our knowledge base IDs
      let elevenLabsKbIds: string[] | undefined;
      if (knowledgeBaseIds !== undefined) {
        if (knowledgeBaseIds.length > 0) {
          const kbItems = await Promise.all(
            knowledgeBaseIds.map((id: string) => storage.getKnowledgeBaseItem(id))
          );
          // Verify ownership and filter valid items
          elevenLabsKbIds = kbItems
            .filter(item => item && item.userId === req.userId && item.elevenLabsDocId)
            .map(item => item!.elevenLabsDocId!);

          console.log(`📚 Filtered ${elevenLabsKbIds.length} valid knowledge base items from ${knowledgeBaseIds.length} selected`);
        } else {
          elevenLabsKbIds = [];
        }
      }

      // Update in database first - this ensures user changes are saved even if ElevenLabs is down
      const existingConfig = (agent.config ?? {}) as import('@shared/schema').AgentConfig;
      const updatedConfig: import('@shared/schema').AgentConfig = {
        ...existingConfig,
        ...(elevenLabsVoiceId && { elevenLabsVoiceId }),
        ...(model && { model }),
        ...(firstMessage !== undefined && { firstMessage }),
        ...(temperature !== undefined && { temperature }),
        ...(transferRules !== undefined && { transferRules }),
        ...(knowledgeBaseIds !== undefined && { knowledgeBaseIds }),
      };

      const updateData: Partial<any> = {
        ...(type && { type }),
        ...(name && { name }),
        ...(voiceTone !== undefined && { voiceTone }),
        ...(personality !== undefined && { personality }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(elevenLabsVoiceId && { elevenLabsVoiceId }),
        ...(language && { language }),
        ...(firstMessage !== undefined && { firstMessage }),
        ...(model && { llmModel: model }),
        ...(temperature !== undefined && { temperature }),
        ...(flowId !== undefined && { flowId }),
        ...(maxDurationSeconds !== undefined && { maxDurationSeconds }),
        ...(voiceStability !== undefined && { voiceStability }),
        ...(voiceSimilarityBoost !== undefined && { voiceSimilarityBoost }),
        ...(voiceSpeed !== undefined && { voiceSpeed }),
        ...(detectLanguageEnabled !== undefined && { detectLanguageEnabled }),
        config: updatedConfig,
      };

      await storage.updateAgent(req.params.id, updateData);

      // Get the agent type (either updated or existing)
      const agentType = type || agent.type || 'natural';

      // Try to sync with ElevenLabs with retry logic
      if (agentType === 'natural' && agent.elevenLabsAgentId && (name || systemPrompt || elevenLabsVoiceId || language || model || firstMessage || temperature !== undefined || voiceTone || personality || tools || elevenLabsKbIds !== undefined)) {
        // Natural Agent: Sync properties
        const effectiveLanguage4 = language || agent.language;
        const isNonEnglish4 = effectiveLanguage4 && effectiveLanguage4 !== 'en';

        // Smart TTS model selection for non-English agents
        let adminTtsModel4: string | undefined;
        if (isNonEnglish4) {
          const ttsModelSetting4 = await storage.getGlobalSetting('default_tts_model');
          adminTtsModel4 = (ttsModelSetting4?.value as string) || 'eleven_multilingual_v2';
        }

        // Resolve and sanitize LLM model ID
        let resolvedModelId = model;
        if (model) {
          const modelRecord = await db
            .select({ modelId: llmModels.modelId })
            .from(llmModels)
            .where(eq(llmModels.name, model))
            .limit(1);

          resolvedModelId = modelRecord.length > 0 ? modelRecord[0].modelId : model;
          resolvedModelId = sanitizeLlmModel(resolvedModelId);
          console.log(`📝 Natural agent ElevenLabs sync - LLM model: ${resolvedModelId}`);
        }

        // Build update payload - no double spreading
        const updatePayload: any = {
          ...(name && { name }),
          ...(systemPrompt && { prompt: systemPrompt }),
          ...(elevenLabsVoiceId && { voice_id: elevenLabsVoiceId }),
          ...(resolvedModelId && { model: resolvedModelId }),
          ...(firstMessage && { first_message: firstMessage }),
          ...(temperature !== undefined && { temperature }),
          ...(voiceTone && { voice_tone: voiceTone }),
          ...(personality && { personality }),
          ...(tools && { tools }),
          ...(elevenLabsKbIds !== undefined && { knowledge_base_ids: elevenLabsKbIds }),
        };

        // For non-English agents: ALWAYS include language and TTS model
        // For English agents changing language: include the new language
        if (isNonEnglish4) {
          updatePayload.language = effectiveLanguage4;
          updatePayload.tts_model = adminTtsModel4;
        } else if (language) {
          updatePayload.language = language;
        }

        // Retry logic: 3 attempts with exponential backoff
        let lastError: any = null;
        const maxRetries = 3;
        const delays = [0, 1000, 2000]; // 0ms, 1s, 2s

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              console.log(`🔄 Retry attempt ${attempt + 1}/${maxRetries} for ElevenLabs sync...`);
              await new Promise(resolve => setTimeout(resolve, delays[attempt]));
            }

            await elevenLabsService.updateAgent(agent.elevenLabsAgentId!, updatePayload);
            console.log("✅ ElevenLabs agent synced successfully");
            break; // Success - exit retry loop
          } catch (error: any) {
            lastError = error;
            console.warn(`⚠️ Attempt ${attempt + 1}/${maxRetries} failed:`, error.message);

            // If this was the last attempt, return with warning
            if (attempt === maxRetries - 1) {
              console.error("❌ All retry attempts failed. Changes saved locally only.");
              return res.json({
                success: true,
                warning: "Agent updated locally. ElevenLabs sync failed after 3 attempts. Please try editing again later."
              });
            }
          }
        }
      } else if (agentType === 'flow' && agent.elevenLabsAgentId && (flowId !== undefined || maxDurationSeconds !== undefined || detectLanguageEnabled !== undefined || elevenLabsVoiceId || name || language || model || temperature !== undefined)) {
        // Flow Agent: Sync workflow when flowId, maxDuration, language detection, voice, or other settings change
        console.log(`🔄 Syncing Flow Agent: ${agent.elevenLabsAgentId}`);

        // Get the flow to compile (use new flowId if provided, otherwise use existing)
        const flowToUse = flowId || agent.flowId;

        if (flowToUse) {
          try {
            // Fetch the flow from database
            const [flow] = await db
              .select()
              .from(flows)
              .where(and(eq(flows.id, flowToUse), eq(flows.userId, req.userId!)));

            if (flow) {
              // Compile the flow to ElevenLabs workflow format
              const compiler = new ElevenLabsFlowCompiler(
                flow.nodes as FlowNode[],
                flow.edges as FlowEdge[]
              );
              const compileResult = compiler.compile();
              const compiledWorkflow = compileResult.workflow;
              const flowFirstMessage = compileResult.firstMessage;

              console.log(`📋 Recompiled flow: ${flow.name} with ${Object.keys(compiledWorkflow.nodes).length} nodes`);
              if (flowFirstMessage) {
                console.log(`📝 First message from flow: "${flowFirstMessage.substring(0, 50)}..."`);
              }

              // For Flow agents, prioritize the flow's extracted first message over agent's stored value
              const effectiveFirstMessage5 = flowFirstMessage || firstMessage;

              // Determine effective language and TTS model for non-English agents
              const effectiveLanguage5 = language || agent.language;
              const isNonEnglish5 = effectiveLanguage5 && effectiveLanguage5 !== 'en';

              // Smart TTS model selection for non-English agents
              let adminTtsModel5: string | undefined;
              if (isNonEnglish5) {
                const ttsModelSetting5 = await storage.getGlobalSetting('default_tts_model');
                adminTtsModel5 = (ttsModelSetting5?.value as string) || 'eleven_multilingual_v2';
              }

              // Resolve LLM model if provided
              let effectiveLlmModel5: string | undefined;
              if (model) {
                const { llmModels } = await import("@shared/schema");
                const modelRecord = await db
                  .select({ modelId: llmModels.modelId })
                  .from(llmModels)
                  .where(eq(llmModels.name, model))
                  .limit(1);

                effectiveLlmModel5 = modelRecord.length > 0 ? modelRecord[0].modelId : model;

                // Sanitize the model ID for ElevenLabs compatibility
                effectiveLlmModel5 = sanitizeLlmModel(effectiveLlmModel5);

                console.log(`📝 Flow agent ElevenLabs sync - LLM model: ${effectiveLlmModel5}`);
              }

              const strictWorkflowPrompt5 = `You are a call agent that must strictly follow a predefined workflow.

RULES:
1. Say EXACTLY what each workflow node instructs you to say.
2. Do NOT add extra words, greetings, questions, or small talk unless specifically written.
3. After speaking a node message, STOP and wait for the user's response.
4. Move to the next workflow node only based on the workflow edge rules.
5. If the user asks a question outside the workflow, use the ask_knowledge tool to respond briefly and accurately — then return to the workflow.
6. If the user asks to speak with a human (e.g. "connect me", "transfer", "agent", "representative"), immediately trigger the transfer.
7. Do NOT improvise or generate random speech.
8. NEVER override instructions from workflow nodes.
9. IGNORE any background noise, side conversations, or ambient speech that is not directed at you. Only respond to the primary speaker who is directly addressing you on the call.
10. If you hear unrelated words or topics from the background environment, do NOT change the conversation topic or respond to them. Stay on your current workflow step.

When using a tool:
- Do not announce you are using a tool.
- Do not say "invoking tool" or similar.
- Only say a short acknowledgment if needed (e.g. "Let me check that for you.")`;

              const userCustomPrompt5 = systemPrompt || agent.systemPrompt;
              const basePrompt5 = userCustomPrompt5
                ? `${strictWorkflowPrompt5}\n\n--- ADDITIONAL AGENT INSTRUCTIONS (provided by the agent creator) ---\nThe following instructions define your persona, domain, and behavioral constraints. You MUST follow these AT ALL TIMES, even while executing the workflow:\n\n${userCustomPrompt5}\n\n--- END OF ADDITIONAL INSTRUCTIONS ---\nRemember: Follow BOTH the workflow steps AND the additional instructions above. Never deviate from your assigned domain or persona.`
                : strictWorkflowPrompt5;

              // Update the ElevenLabs agent with new workflow and TTS config
              await elevenLabsService.updateFlowAgentWorkflow(
                agent.elevenLabsAgentId,
                compiledWorkflow,
                maxDurationSeconds ?? (agent.maxDurationSeconds || 600),
                detectLanguageEnabled !== undefined ? detectLanguageEnabled : (agent.detectLanguageEnabled || false),
                isNonEnglish5 ? effectiveLanguage5 : undefined,  // Pass language for non-English
                isNonEnglish5 ? adminTtsModel5 : undefined,  // Pass TTS model for non-English
                effectiveLlmModel5,  // Pass LLM model if provided
                temperature,  // Pass temperature if provided
                effectiveFirstMessage5,  // Pass first message extracted from flow
                elevenLabsVoiceId,  // Pass voice ID if provided
                { basePrompt: basePrompt5 }
              );

              console.log("✅ Flow Agent workflow synced successfully");
            } else {
              console.warn(`⚠️ Flow not found for sync: ${flowToUse}`);
            }
          } catch (error: any) {
            console.error("❌ Flow Agent sync failed:", error.message);
            return res.json({
              success: true,
              warning: "Agent updated locally. ElevenLabs workflow sync failed. Please try editing again later."
            });
          }
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Update agent error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to update agent") });
    }
  });

  app.delete("/api/elevenlabs/agents/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Delete from ElevenLabs if exists
      if (agent.elevenLabsAgentId) {
        try {
          await elevenLabsService.deleteAgent(agent.elevenLabsAgentId);
        } catch (error) {
          console.error("Failed to delete from ElevenLabs:", error);
        }
      }

      // Decrement the assigned agents count for the credential
      if (agent.elevenLabsCredentialId) {
        try {
          await ElevenLabsPoolService.updateAssignmentCount(agent.elevenLabsCredentialId, false);
          console.log(`📊 [Agent Delete] Decremented agent count for credential ${agent.elevenLabsCredentialId}`);
        } catch (countError) {
          console.warn("Failed to update credential agent count:", countError);
        }
      }

      // Delete from database
      await storage.deleteAgent(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete agent error:", error);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  // Test endpoint to add call transfer to an agent
  // Note: Flow agents should NOT use this endpoint - they have transfer nodes in their visual flow
  app.post("/api/elevenlabs/agents/:id/configure-transfer", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent || agent.userId !== req.userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Reject Flow agents - they should use transfer nodes in the flow builder instead
      if (agent.type === 'flow') {
        return res.status(400).json({
          error: "Flow agents cannot use this endpoint. Use the Transfer node in your flow instead."
        });
      }

      const { transferNumber, condition, customerMessage, operatorMessage } = req.body;

      if (!transferNumber) {
        return res.status(400).json({ error: "Transfer number is required" });
      }

      let transferTypeForRules: "conference" | "sip_refer" = "conference";
      let sipTrunkAddress: string | null = null;
      try {
        if (await isAgentOnSipPhoneNumber(req.params.id)) {
          transferTypeForRules = "sip_refer";
          sipTrunkAddress = await getSipTrunkOutboundAddress(req.params.id);
          console.log(`   📞 [Transfer Config] SIP agent detected - using sip_refer transfer type (trunk: ${sipTrunkAddress})`);
        }
      } catch { }

      let numberType: "phone" | "sip_uri" = "phone";
      let destination = transferNumber;
      if (transferTypeForRules === "sip_refer" && sipTrunkAddress) {
        numberType = "sip_uri";
        const phoneNum = transferNumber.startsWith('+') ? transferNumber : `+${transferNumber}`;
        destination = `sip:${phoneNum}@${sipTrunkAddress}`;
        console.log(`   📞 [Transfer Config] SIP REFER: ${phoneNum} → ${destination}`);
      }

      const transferRules = [{
        transfer_type: transferTypeForRules,
        number_type: numberType,
        destination: destination,
        condition: condition || "User explicitly requests to speak to a human or customer care representative",
        customer_message: customerMessage || "Please hold while I transfer you to our support team",
        operator_message: operatorMessage || "Customer needs assistance",
      }];

      const tools = [{
        type: "transfer_to_number" as const,
        description: "Transfer user to human support when needed",
        transfer_rules: transferRules,
      }];

      // Update in ElevenLabs
      if (agent.elevenLabsAgentId) {
        await elevenLabsService.updateAgent(agent.elevenLabsAgentId, { tools });
        console.log(`✅ Call transfer configured for agent ${agent.name} (${agent.elevenLabsAgentId})`);
      }

      // Update in database
      const existingConfig = (agent.config ?? {}) as import('@shared/schema').AgentConfig;
      const updatedConfig: import('@shared/schema').AgentConfig = {
        ...existingConfig,
        transferRules,
      };

      await storage.updateAgent(req.params.id, { config: updatedConfig });

      res.json({
        success: true,
        message: `Call transfer configured successfully. The AI will now transfer calls to ${transferNumber} when appropriate.`
      });
    } catch (error: any) {
      console.error("Configure transfer error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to configure call transfer") });
    }
  });

  // ElevenLabs Voices routes
  // Uses pool credentials (user affinity) to fetch voices, not global env var
  app.get("/api/elevenlabs/voices", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Get credential from pool - use user affinity for consistency
      const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);

      if (!credential) {
        // No pool credentials available - return empty array with helpful message
        console.warn("⚠️ [Voices] No ElevenLabs credentials in pool - voices cannot be fetched");
        return res.json([]);
      }

      // Create service instance with pool credential
      const poolService = new ElevenLabsService(credential.apiKey);
      const { voices } = await poolService.listVoices();
      res.json(voices);
    } catch (error: any) {
      console.error("Get ElevenLabs voices error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to get voices") });
    }
  });

  // ElevenLabs Voice Limit - Returns voice slot usage and limits
  // Uses pool credentials to fetch subscription info
  app.get("/api/elevenlabs/voice-limit", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Get credential from pool for this user
      const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);

      if (!credential) {
        // No pool credentials - return defaults
        return res.json({
          used: 0,
          limit: 30,
          atLimit: false,
          canExtend: false,
          tier: 'not_configured',
        });
      }

      const poolService = new ElevenLabsService(credential.apiKey);
      const subscription = await poolService.getSubscription();

      // ElevenLabs API returns voice_slots_used and voice_limit (not voice_count/max_voice_count)
      const used = subscription.voice_slots_used ?? 0;
      const limit = subscription.voice_limit ?? 30;

      const response = {
        used,
        limit,
        atLimit: used >= limit,
        canExtend: subscription.can_extend_voice_limit ?? false,
        tier: subscription.tier ?? 'unknown',
      };
      res.json(response);
    } catch (error: any) {
      console.error("Get voice limit error:", error);
      // Fallback to reasonable defaults if subscription fetch fails
      res.json({
        used: 0,
        limit: 30,
        atLimit: false,
        canExtend: false,
        tier: 'unknown',
      });
    }
  });

  // ElevenLabs Shared Voices (Voice Library) - 5000+ community voices (LEGACY - use /api/voices/search instead)
  app.get("/api/elevenlabs/shared-voices", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const {
        page,
        pageSize,
        search,
        language,
        gender,
        age,
        accent,
        category,
        useCases
      } = req.query;

      const result = await elevenLabsService.listSharedVoices({
        page: page ? parseInt(page as string) : undefined,
        pageSize: pageSize ? parseInt(pageSize as string) : 100,
        search: search as string | undefined,
        language: language as string | undefined,
        gender: gender as string | undefined,
        age: age as string | undefined,
        accent: accent as string | undefined,
        category: category as string | undefined,
        useCases: useCases ? (useCases as string).split(',') : undefined,
      });

      res.json(result);
    } catch (error: any) {
      console.error("Get ElevenLabs shared voices error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to get shared voices") });
    }
  });

  // ElevenLabs LLM Pricing route
  app.get("/api/elevenlabs/llm-pricing", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Fetch LLM pricing from ElevenLabs
      const pricing = await elevenLabsService.getLLMPricing();

      // Get admin margin percentage from global settings (default to 0% if not set)
      const marginSetting = await storage.getGlobalSetting('llm_pricing_margin');
      const marginPercentage = marginSetting ? parseFloat(String(marginSetting.value)) : 0;

      // Apply margin to all prices
      const pricingWithMargin = {
        ...pricing,
        llm_prices: pricing.llm_prices.map(llm => ({
          ...llm,
          // Apply margin percentage (e.g., 10% margin = multiply by 1.10)
          cost_per_million_input_tokens: llm.cost_per_million_input_tokens * (1 + marginPercentage / 100),
          cost_per_million_output_tokens: llm.cost_per_million_output_tokens * (1 + marginPercentage / 100),
          cost_per_million_input_cache_read_tokens: llm.cost_per_million_input_cache_read_tokens
            ? llm.cost_per_million_input_cache_read_tokens * (1 + marginPercentage / 100)
            : undefined,
          cost_per_million_input_cache_write_tokens: llm.cost_per_million_input_cache_write_tokens
            ? llm.cost_per_million_input_cache_write_tokens * (1 + marginPercentage / 100)
            : undefined,
          // Add margin info for transparency
          margin_percentage: marginPercentage,
          original_cost_per_million_input_tokens: llm.cost_per_million_input_tokens,
          original_cost_per_million_output_tokens: llm.cost_per_million_output_tokens,
        })),
      };

      res.json(pricingWithMargin);
    } catch (error: any) {
      console.error("Get LLM pricing error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to get LLM pricing") });
    }
  });

  // Phone Numbers routes are now in server/routes/phone-routes.ts

  // Per-account rate limits for provider webhooks. Twilio is keyed on the verified AccountSid,
  // which is only read after validateTwilioWebhook has checked the signature. ElevenLabs is
  // keyed on IP, since its signature check runs inside the handler.
  const twilioWebhookRateLimit = createProviderWebhookRateLimit({
    provider: "twilio",
    windowMs: 60_000,
    maxRequests: 160,
    readAccountId: readTwilioAccountSid,
    accountIdPattern: TWILIO_ACCOUNT_SID_PATTERN,
  });
  const elevenLabsWebhookRateLimit = createProviderWebhookRateLimit({
    provider: "elevenlabs",
    windowMs: 60_000,
    maxRequests: 160,
  });

  // Twilio webhook endpoints (validated with Twilio signature verification, then rate limited)
  app.post("/api/webhooks/twilio/voice", validateTwilioWebhook, twilioWebhookRateLimit, handleTwilioVoiceWebhook); // Outbound campaign calls
  app.post("/api/webhooks/twilio/incoming", validateTwilioWebhook, twilioWebhookRateLimit, handleIncomingCallWebhook); // Incoming calls to purchased numbers
  app.post("/api/webhooks/twilio/status", validateTwilioWebhook, twilioWebhookRateLimit, handleTwilioStatusWebhook);
  app.post("/api/webhooks/twilio/recording", validateTwilioWebhook, twilioWebhookRateLimit, handleTwilioRecordingWebhook);

  // Flow-based execution webhooks (validated with Twilio signature verification, then rate limited)
  app.post("/api/webhooks/twilio/flow/answer", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowVoiceAnswer);
  app.post("/api/webhooks/twilio/flow/node", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowNode);
  app.post("/api/webhooks/twilio/flow/gather", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowGather);
  app.post("/api/webhooks/twilio/flow/continue", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowContinue);
  app.post("/api/webhooks/twilio/flow/status", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowStatus);

  // ElevenLabs webhook endpoints (no authentication - called by ElevenLabs)
  app.post("/api/webhooks/elevenlabs", elevenLabsWebhookRateLimit, handleElevenLabsWebhook); // Call completion notifications
  // RAG knowledge base tool - supports both URL-based token (primary) and header token (fallback)
  app.post("/api/webhooks/elevenlabs/rag-tool/:token/:agentId", handleRAGToolWebhook); // New: token in URL
  app.post("/api/webhooks/elevenlabs/rag-tool/:agentId", handleRAGToolWebhook); // Legacy: header auth
  // Appointment booking tool webhook - called by ElevenLabs when appointment node executes
  app.post("/api/webhooks/elevenlabs/appointment/:token/:agentId", handleAppointmentToolWebhook);
  // Form submission tool webhook - called by ElevenLabs when form node executes
  app.post("/api/webhooks/elevenlabs/form/:token/:formId/:agentId", handleFormSubmissionWebhook);
  // Play audio tool webhook - called by ElevenLabs when play_audio node executes
  // audioUrl is validated before the handler runs: https only, parsed with URL, host must be this app's own
  // domain (no external or private/loopback hosts). Relative paths resolve against the own domain.
  // Protected by the same URL-token mechanism as the appointment tool (validateAppointmentWebhookToken).
  app.post("/api/elevenlabs/tools/play-audio/:token/:agentId", (req: Request, res: Response, next: () => void) => {
    if (!validateAppointmentWebhookToken(req.params.token)) {
      res.status(401).json({ success: false, error: "Unauthorized: Invalid authentication token" });
      return;
    }
    const rawDomain = getDomain();
    let ownHost: string | undefined;
    try {
      ownHost = new URL(rawDomain.includes("://") ? rawDomain : `https://${rawDomain}`).host;
    } catch {
      ownHost = undefined;
    }
    if (!ownHost) {
      res.status(500).json({ error: "Audio host not configured" });
      return;
    }
    const rawAudioUrl = req.body?.audioUrl;
    if (typeof rawAudioUrl !== "string" || rawAudioUrl.length === 0 || rawAudioUrl.length > 2048) {
      res.status(400).json({ error: "Invalid audioUrl" });
      return;
    }
    let parsedAudio: URL;
    try {
      parsedAudio = new URL(rawAudioUrl, `https://${ownHost}`);
    } catch {
      res.status(400).json({ error: "Invalid audioUrl" });
      return;
    }
    const audioHost = parsedAudio.hostname.toLowerCase();
    const isPrivateHost =
      audioHost === "localhost" ||
      audioHost === "0.0.0.0" ||
      audioHost === "[::1]" ||
      audioHost.startsWith("127.") ||
      audioHost.startsWith("10.") ||
      audioHost.startsWith("192.168.") ||
      audioHost.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(audioHost);
    if (parsedAudio.protocol !== "https:" || isPrivateHost || parsedAudio.host !== ownHost) {
      res.status(400).json({ error: "audioUrl must be an https URL on this application's domain" });
      return;
    }
    next();
  }, handlePlayAudioToolWebhook);

  // Stripe routes
  app.use("/api/stripe", stripeRouter);

  // Razorpay routes (alternative payment gateway)
  app.use("/api/razorpay", razorpayRouter);

  // PayPal routes (global payment gateway)
  app.use("/api/paypal", paypalRouter);

  // Paystack routes (Africa payment gateway - NGN, GHS, ZAR, KES)
  app.use("/api/paystack", paystackRouter);

  // MercadoPago routes (Latin America payment gateway - BRL, MXN, ARS, CLP, COP)
  app.use("/api/mercadopago", mercadopagoRouter);

  // YooKassa routes
  app.use("/api/yookassa", yookassaRouter);

  // Admin routes accessible by admin team members (read-only analytics)
  // Must be before main admin router to take precedence
  app.use("/api/admin", adminTeamAccessRoutes);

  // Admin routes (super admin only)
  app.use("/api/admin", adminRouter);

  // LLM Models admin routes
  app.use("/api/admin/llm-models", llmModelsRouter);

  // Platform Languages admin routes (UI translations management)
  app.use("/api/admin/platform-languages", platformLanguagesRouter);

  // Payment Transactions admin routes
  app.use("/api/admin/transactions", transactionsRouter);

  // User-accessible transaction routes (non-admin)
  app.use("/api/transactions", transactionsRouter);

  // Admin Refunds routes
  app.use("/api/admin/refunds", refundRouter);

  // User-accessible refund note download (separate from admin routes)
  app.get("/api/refunds/:id/download", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const userId = req.userId!;

      const refund = await storage.getRefund(id);
      if (!refund) {
        return res.status(404).json({ message: "Refund not found" });
      }

      // Users can only download their own refund notes
      if (refund.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (!refund.pdfUrl) {
        try {
          const updatedRefund = await generateRefundNoteForRefund(id);
          if (!updatedRefund.pdfUrl) {
            return res.status(404).json({ message: "Refund note PDF not available" });
          }
        } catch (error) {
          return res.status(404).json({ message: "Refund note PDF not available" });
        }
      }

      const pdfBuffer = await refundNoteService.getRefundNotePDF(id);
      if (!pdfBuffer) {
        return res.status(404).json({ message: "Refund note PDF file not found" });
      }

      const latestRefund = await storage.getRefund(id);
      const fileName = latestRefund?.refundNoteNumber
        ? `${latestRefund.refundNoteNumber.replace(/\//g, '-')}.pdf`
        : `refund-note-${id}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error("Error downloading refund note:", error);
      res.status(500).json({ message: "Failed to download refund note", error: safeErrorMessage(error, "Failed to download refund note") });
    }
  });

  // Admin Email Settings routes
  app.use("/api/admin/email-settings", emailSettingsRouter);

  // Audio upload routes
  app.use("/api/audio", audioRoutes);

  // Invoice routes (download, generate)
  app.use("/api/invoices", invoiceRouter);

  // Flow Automation routes
  // Use hybrid auth to allow both users and team members
  app.use("/api/flow-automation", routeContext.authenticateHybrid as unknown as import('express').RequestHandler, flowAutomationRouter);

  // Incoming Connections routes (links agents to phone numbers)
  app.use("/api/incoming-connections", incomingConnectionsRouter);

  // Channel webhooks need the raw bytes. Only POST channel webhook paths are touched; other paths pass through.
  // Mounted before the core chatbot route so it runs ahead of the core auth on those paths.
  app.use(captureChatbotWebhookRawBody());
  // Chatbot wiring (channels, admin, commerce). Mounted BEFORE the core registerChatbotModule call below, so a matched
  // route answers before the core /api/chatbot authenticate runs (provider webhooks carry no session). Each surface
  // keeps its own authenticate and requireCompanyScope. Flags are read inside mountChatbotModule; with flags off it mounts nothing new.
  // The secret box is built only when a surface that stores secrets is on. createSecretBox throws when CHATBOT_SECRET_KEY
  // is missing, so with those flags off a deployment without the key still starts.
  // The outbound webhook dispatcher also stores secrets (signing keys), so its flag counts here too.
  const chatbotSecretsOn = [WIRING_FLAGS.BOOKINGS, WIRING_FLAGS.WIDGET, WIRING_FLAGS.CHANNELS, CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED].some((flag) =>
    readFlag(flag, process.env),
  );
  const chatbotSecretBox = chatbotSecretsOn ? createSecretBox({ env: process.env }) : undefined;
  mountChatbotModule(app, {
    db,
    env: process.env,
    authenticate: routeContext.authenticateHybrid as unknown as import('express').RequestHandler,
    requireCompanyScope: requireCompanyScope(),
    requireRole: (...roles: string[]) => requireRole(...roles) as unknown as import('express').RequestHandler,
    // agentAuthenticate is not passed: the app has no staff identity resolver for the agent surface, so agent calls answer 401.
    secretBox: chatbotSecretBox,
    // No reply runtime or receipt store is wired yet. These stubs keep startup working and refuse the work itself.
    widget: {
      messages: { send: async () => { throw new Error("chatbot widget reply runtime is not wired"); } },
      assetBaseUrl: process.env.CHATBOT_WIDGET_ASSET_BASE_URL ?? "",
    },
    channels: { onReceipt: async () => { throw new Error("chatbot channel receipt store is not wired"); } },
  });
  // Chatbot background workers. Off unless CHATBOT_WORKERS_ENABLED is exactly "true"; then only the services whose own
  // flag is on are built and passed in (see workers/boot.ts). Voice-call limits are not built: no production provider.
  startChatbotWorkersFromEnv({ db, env: process.env, secretBox: chatbotSecretBox });
  // Chatbot module (port of the Clean-Hub Chatbot extension). Authenticated, company-scoped.
  // Tables are DRAFT (migrations/DRAFT_chatbot.sql); requests fail until the draft is applied.
  // A request that matches no route mounted above falls through to this core route unchanged.
  registerChatbotModule(app, { requireCompanyScope: requireCompanyScope(), authenticate: routeContext.authenticateHybrid as unknown as import('express').RequestHandler });
  registerApprovalModule(app); // /api/approvals: authenticateToken, then requireCompanyScope()

  // CRM routes - Lead Management (isolated module)
  // Use hybrid auth to allow both users and team members
  app.use("/api/crm", routeContext.authenticateHybrid as unknown as import('express').RequestHandler, crmRoutes);

  // Public Platform Languages route - for i18n dynamic loading (no auth required)
  // Must be registered BEFORE publicWidgetRoutes to ensure specific path matches first
  app.use("/api/public/platform-languages", platformLanguagesPublicRouter);

  // Website Widget routes - Embeddable voice widgets (isolated module)
  // Public widget routes must be registered BEFORE authenticated routes to allow external website embedding
  app.use("/api/public", publicWidgetRoutes);

  // WebSocket stream handlers — handle both direct WebSocket upgrades AND reverse proxy scenarios
  // When behind a reverse proxy (nginx) that strips Upgrade/Connection headers, Express receives
  // these as plain GET requests. Without this handler they fall through to authenticateHybrid and
  // return 401, killing the WebSocket/audio stream connection.
  // Fix: restore the stripped WebSocket handshake headers and re-emit the 'upgrade' event so the
  // existing httpServer.on('upgrade') handlers can process the connection normally.
  // This must be registered BEFORE the authenticateHybrid catch-all.
  const streamPaths = [
    '/api/twilio-openai/stream',
    '/api/webhooks/twilio/stream',
    '/api/plivo/stream',
    '/api/plivo-elevenlabs/stream',
  ];
  for (const streamPath of streamPaths) {
    app.get(`${streamPath}*`, (req, res) => {
      if (req.headers.upgrade?.toLowerCase() === 'websocket') {
        return;
      }
      console.log(`🔌 [Stream Proxy Fix] Reverse proxy stripped WebSocket headers for ${req.url}, restoring and re-emitting upgrade`);
      const socket = req.socket;
      if (!socket || socket.destroyed) {
        return res.status(400).json({ error: 'WebSocket connection required — socket unavailable' });
      }
      req.headers['upgrade'] = 'websocket';
      req.headers['connection'] = 'upgrade';
      if (!req.headers['sec-websocket-version']) {
        req.headers['sec-websocket-version'] = '13';
      }
      if (!req.headers['sec-websocket-key']) {
        req.headers['sec-websocket-key'] = Buffer.from(Date.now().toString()).toString('base64').slice(0, 24);
      }
      httpServer.emit('upgrade', req, socket, Buffer.alloc(0));
    });
  }

  // E6: the RAG tool webhook authenticates itself (WEBHOOK_TOKEN), so only that exact POST path skips the gate.
  app.use("/api", hybridGateUnlessExempt(routeContext.authenticateHybrid as unknown as import('express').RequestHandler), widgetRoutes);

  // RAG Knowledge Base routes (scalable alternative to ElevenLabs 20MB KB)
  // Mounted unconditionally: no env check here. USE_RAG_KNOWLEDGE is read only by isRAGEnabled()
  // (services/rag-elevenlabs-tool.ts), which defaults to on and is off only when set to false, 0 or no.
  const ragKnowledgeRoutes = createRAGKnowledgeRoutes(routeContext.authenticateHybrid, { requireCompanyScope: requireCompanyScope() });
  app.use("/api/rag-knowledge", ragKnowledgeRoutes);

  // Google Sheets authenticated endpoints (auth, status, disconnect, sheets list)
  app.use("/api/integrations/google", authenticateToken as unknown as import('express').RequestHandler, googleSheetsRouter);

  // Google Calendar authenticated endpoints (auth, exchange, status, disconnect)
  const { googleCalendarRouter } = await import("./services/google-calendar/google-calendar.routes");
  app.use("/api/google-calendar", authenticateToken as unknown as import('express').RequestHandler, googleCalendarRouter);

  // This must be registered on the httpServer to properly handle Twilio WebSocket streams
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url?.split('?')[0] || '';

    console.log(`🔌 [Upgrade] Request for: ${request.url}`);
    console.log(`   Pathname: ${pathname}`);

    // Only handle Twilio stream WebSocket upgrades
    if (pathname === '/api/webhooks/twilio/stream') {
      console.log(`✅ [Upgrade] Handling Twilio stream WebSocket`);

      const wss = new WebSocketServer({ noServer: true });

      wss.handleUpgrade(request, socket, head, async (ws: any) => {
        console.log(`✅ [WebSocket] Upgrade successful for Twilio stream`);
        console.log(`   Waiting for Twilio 'start' event to determine routing...`);

        let handlerRouted = false;
        let startTimeout: NodeJS.Timeout | null = null;
        const bufferedMessages: Buffer[] = [];

        // Temporary message handler to wait for 'start' event
        const tempMessageHandler = async (message: Buffer) => {
          try {
            const data = JSON.parse(message.toString());

            // Buffer all messages as raw Buffers (not parsed objects)
            bufferedMessages.push(message);

            // Ignore 'connected' and other non-start events
            if (data.event !== 'start') {
              console.log(`📨 [WebSocket] Received '${data.event}' event, buffering...`);
              return;
            }

            // Got start event - clear timeout and route to handler
            if (startTimeout) {
              clearTimeout(startTimeout);
              startTimeout = null;
            }

            console.log(`📨 [WebSocket] Received Twilio 'start' event, routing to handler`);

            // Extract custom parameters sent from TwiML <Parameter> tags
            const customParams = data.start?.customParameters || {};
            const callId = customParams.callId;
            const agentId = customParams.agentId;

            console.log(`   Extracted routing params:`);
            console.log(`   - callId: ${callId}`);
            console.log(`   - agentId: ${agentId}`);

            if (!agentId || !callId) {
              console.error(`❌ [WebSocket] Missing required routing parameters (agentId or callId)`);
              ws.close(1008, 'Missing required parameters');
              return;
            }

            // Look up agent type to determine routing
            // Note: agentId could be either database UUID (Flow) or ElevenLabs ID (Natural)
            try {
              // Try looking up by database ID first (Flow agents)
              let agentRecords = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);

              // If not found, try ElevenLabs ID (Natural agents)
              if (agentRecords.length === 0) {
                agentRecords = await db.select().from(agents).where(eq(agents.elevenLabsAgentId, agentId)).limit(1);
              }

              const agent = agentRecords[0];

              if (!agent) {
                console.error(`❌ [WebSocket] Agent not found for ID: ${agentId}`);
                ws.close(1008, 'Agent not found');
                return;
              }

              // Security: Verify the call exists in our database
              // This prevents spoofed WebSocket connections with fake call IDs
              const [existingCall] = await db
                .select({ id: calls.id })
                .from(calls)
                .where(eq(calls.id, callId))
                .limit(1);

              if (!existingCall) {
                console.error(`❌ [WebSocket] Security: Call not found for ID: ${callId}`);
                ws.close(1008, 'Call not found');
                return;
              }

              console.log(`✅ [WebSocket] Found agent: ${agent.id} (type: ${agent.type})`);

              // Remove temp message handler before routing
              ws.removeListener('message', tempMessageHandler);
              handlerRouted = true;

              // Extract ALL custom parameters for handlers to use
              const flowId = customParams.flowId;
              const executionId = customParams.executionId;
              const fromPhone = customParams.fromPhone || customParams.from;
              const contactName = customParams.contactName;

              // Create mock request with full parameter set for handlers
              const mockReq: any = {
                url: request.url,
                headers: request.headers,
                query: {
                  callId,
                  agentId,
                  flowId,
                  executionId,
                  from: fromPhone,
                  contactName
                }
              };

              // Route all agents to ElevenLabs handler
              // Both Natural and Flow Agents now execute through ElevenLabs
              // Flow Agents have their workflows synced to ElevenLabs
              console.log(`🔀 [WebSocket] Routing to ElevenLabs handler (agent type: ${agent.type})`);
              if (agent.type === 'flow') {
                console.log(`   Flow context: flowId=${flowId}, executionId=${executionId}`);
              }
              handleTwilioStreamWebSocket(ws, mockReq);

              // Delay replay slightly to allow handlers to attach listeners
              // Then replay all buffered messages as raw Buffers
              setTimeout(() => {
                console.log(`📨 [WebSocket] Replaying ${bufferedMessages.length} buffered messages`);
                for (const bufferedMsg of bufferedMessages) {
                  ws.emit('message', bufferedMsg);
                }
                // Clear buffer after replay to prevent double-processing
                bufferedMessages.length = 0;
              }, 100); // 100ms delay

            } catch (error) {
              console.error('❌ [WebSocket] Error during routing:', error);
              ws.close(1011, 'Internal server error during routing');
            }
          } catch (error) {
            console.error('❌ [WebSocket] Error parsing message:', error);
            // Don't close on parse errors, just log and continue
          }
        };

        // Attach temporary message handler
        ws.on('message', tempMessageHandler);

        // Set timeout for start event
        startTimeout = setTimeout(() => {
          if (!handlerRouted) {
            console.error('❌ [WebSocket] Timeout waiting for Twilio start event');
            ws.removeListener('message', tempMessageHandler);
            ws.close(1008, 'Start event timeout');
          }
        }, 10000); // 10 second timeout

        // Clean up timeout on connection close
        ws.on('close', () => {
          if (startTimeout) {
            clearTimeout(startTimeout);
            startTimeout = null;
          }
        });
      });
    } else {
      // For all other upgrade requests (like Vite HMR), do nothing
      // Let them pass through to other handlers
      console.log(`📡 [Upgrade] Passing through: ${pathname}`);
    }
  });

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
