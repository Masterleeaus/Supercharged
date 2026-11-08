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
import type { Express, Request, RequestHandler, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer } from 'ws';
import { storage } from "./storage";
import { db } from "./db";
import { phoneNumbers, agents, calls, campaigns, incomingConnections, users, knowledgeBase } from "@shared/schema";
import { eq, desc, and, isNull, sql, or } from "drizzle-orm";
import { authenticateToken, requireRole, type AuthRequest } from "./middleware/auth";
import { validateTwilioWebhook } from "./middleware/webhookValidation";
import { elevenLabsService, ElevenLabsService } from "./services/elevenlabs";
import { ElevenLabsPoolService } from "./services/elevenlabs-pool";

const elevenLabsPoolService = new ElevenLabsPoolService();
import { campaignExecutor } from "./services/campaign-executor";
import { BatchCallingService } from "./services/batch-calling";
import { handleTwilioVoiceWebhook, handleIncomingCallWebhook, handleTwilioStatusWebhook, handleTwilioRecordingWebhook, handleTwilioStreamWebSocket, handleFlowVoiceAnswer, handleFlowNode, handleFlowGather, handleFlowContinue, handleFlowStatus, handleElevenLabsWebhook, handleRAGToolWebhook, handleAppointmentToolWebhook, handleFormSubmissionWebhook, handlePlayAudioToolWebhook } from "./routes/webhook-routes";
// Flow Agent WebSocket handler removed - all agents now execute through ElevenLabs
import { getDomain } from "./utils/domain";
import { adminRouter } from "./routes/admin-routes";
import { maintenanceMiddleware } from "./services/system-update-service";
import adminTeamAccessRoutes from "./routes/admin-team-access.routes";
import { createRouteContext } from "./routes/common";
// Payment Engine v1.0.0 - All payment gateway routers
import { stripeRouter, razorpayRouter, paypalRouter, paystackRouter, mercadopagoRouter, yookassaRouter } from "./engines/payment";
// Plivo + OpenAI Realtime Engine
import { setupPlivoStream } from "./engines/plivo";
// Plivo-ElevenLabs SIP Trunk Engine (ISOLATED from Twilio+ElevenLabs)
import { initPlivoElevenLabsStream } from "./engines/plivo-elevenlabs";
// Twilio + OpenAI Realtime Engine (ISOLATED from Twilio+ElevenLabs and Plivo+OpenAI)
import { setupTwilioOpenAIStreamHandler } from "./engines/twilio-openai";
import { checkAdmin, checkAdminOrTeamMember, requireAdminPermission, AdminRequest } from "./middleware/admin-auth";
import { hybridGateUnlessExempt } from "./middleware/hybrid-gate-exemptions";
import flowAutomationRouter from "./routes/flow-automation-routes";
import { flows, insertPromptTemplateSchema, promptTemplates } from "@shared/schema";

// Table insert shape for createPromptTemplate; the drizzle-zod insert type resolves to {}.
type PromptTemplateInsertRow = typeof promptTemplates.$inferInsert & { companyId?: string };
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
import crmRoutes from "./routes/crm-routes";
import { widgetRoutes, publicWidgetRoutes } from "./modules/widget";
import multer from "multer";
// Team Management Middleware - allows team members to access user data with their parent's userId
// Uses adapter for optional plugin loading
import { getTeamContextMiddleware, isTeamManagementInstalled, initializeAdapter as initTeamAdapter } from "./plugins/team-management-adapter";
import { validateAppointmentWebhookToken } from "./services/appointment-elevenlabs-tool";
import { CampaignScheduler } from "./services/campaign-scheduler";
import { generateRefundNoteForRefund, refundNoteService } from "./services/refund-note-service";
import { safeErrorMessage } from "./utils/safe-error";
import { registerChatbotModule } from "./modules/chatbot/index.ts";
import { mountChatbotModule, WIRING_FLAGS } from "./modules/chatbot/wiring/mount.ts";
import { resolveAgentStaffIdentity } from "./modules/chatbot/agent-routes/staff-identity.ts";
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
import { registerPublicAuthRoutes } from "./routes/core/public-auth-routes";
import { registerPlatformRoutes } from "./routes/core/platform-routes";
import { registerVoiceEngineRoutes } from "./routes/core/voice-engine-routes";
import { registerPluginEngineRoutes } from "./routes/core/plugin-engine-routes";
import { registerPluginManagementRoutes } from "./routes/core/plugin-management-routes";
import { registerAdminUserRoutes } from "./routes/core/admin-user-routes";
import { registerContactsToolsRoutes } from "./routes/core/contacts-tools-routes";
import { registerElevenLabsAgentRoutes } from "./routes/core/elevenlabs-agent-routes";

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
    // Agent surface: identity comes from req.user, which authenticateHybrid sets from a verified token. Company and role
    // come from that user only, never from headers or body. A user with no company gets 403, no identity gets 401.
    agentAuthenticate: resolveAgentStaffIdentity,
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
