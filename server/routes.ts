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
import type { Express, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { authenticateToken } from "./middleware/auth";
import { ElevenLabsPoolService } from "./services/elevenlabs-pool";

const elevenLabsPoolService = new ElevenLabsPoolService();
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
import { createCommsAuditSink } from "./modules/comms/audit-sink.ts";
import { logAuditEvent } from "./services/audit-log";
const commsAudit = createCommsAuditSink({ write: logAuditEvent as unknown as Parameters<typeof createCommsAuditSink>[0]["write"] });
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
import { registerWorkforceCommsRoutes } from "./routes/core/workforce-comms-routes";
import { registerAdminCampaignRoutes } from "./routes/core/admin-campaign-routes";
import { logger } from "./utils/logger";

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
    logger.info('✅ Team Management plugin detected - team context middleware enabled');
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

  // Routes: workforce and comms campaign mounts, see server/routes/core/workforce-comms-routes.ts
  await registerWorkforceCommsRoutes(app, { commsAudit });

  // Routes: admin campaign views and call user migration, see server/routes/core/admin-campaign-routes.ts
  registerAdminCampaignRoutes(app);

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
