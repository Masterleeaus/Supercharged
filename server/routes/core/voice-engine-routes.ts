import type { Express, RequestHandler } from "express";
import { getDomain } from "../../utils/domain";
import { createPlivoApiRoutes, setupPlivoWebhooks } from "../../engines/plivo";
import { initPlivoElevenLabsEngine } from "../../engines/plivo-elevenlabs";
import { twilioOpenaiWebhookRoutes, twilioOpenaiIncomingConnectionsRoutes } from "../../engines/twilio-openai";
import { registerKycRoutes } from "../../engines/kyc";
import { logger } from "../../utils/logger";

export function registerVoiceEngineRoutes(app: Express, deps: { requireAuth: RequestHandler; requireAdmin: RequestHandler }): void {
  const { requireAuth, requireAdmin } = deps;

  // Register Plivo + OpenAI Realtime Engine routes
  // Apply authenticateToken middleware only to user-facing Plivo API routes (not webhooks/stream)
  // Webhooks need to remain unauthenticated for Plivo callbacks
  app.use('/api/plivo/openai', requireAuth);
  app.use('/api/plivo/phone-numbers', requireAuth);
  // Note: /api/plivo/admin routes use requireAdminAuth + requireAdminPermission middleware at route level
  // to support both platform admins (JWT) and admin team members (session tokens)
  app.use('/api/plivo/incoming-connections', requireAuth);
  const plivoApiRoutes = createPlivoApiRoutes();
  app.use(plivoApiRoutes);

  // Setup Plivo webhooks for voice calls
  const plivoBaseUrl = getDomain();
  setupPlivoWebhooks(app, plivoBaseUrl);
  // Plivo WebSocket stream is set up on httpServer below (after other upgrade handlers)

  // Start the stuck calls cleanup scheduler for Plivo engine
  import("../../engines/plivo/services/plivo-call.service").then(({ PlivoCallService }) => {
    PlivoCallService.startStuckCallsScheduler();
  }).catch((error) => {
    logger.error('❌ Failed to start Plivo stuck calls scheduler:', error.message);
  });

  logger.info('✅ Plivo + OpenAI Realtime Engine initialized');

  // Initialize Plivo-ElevenLabs SIP Trunk Engine (ISOLATED from Twilio+ElevenLabs)
  // This provides Plivo SIP trunk to ElevenLabs connection for Indian phone numbers
  initPlivoElevenLabsEngine(app);
  logger.info('✅ Plivo-ElevenLabs SIP Trunk Engine initialized');

  // Initialize Twilio + OpenAI Realtime Engine (ISOLATED from Twilio+ElevenLabs and Plivo+OpenAI)
  // This provides Twilio telephony with OpenAI Realtime API for international calling
  app.use('/api/twilio-openai', twilioOpenaiWebhookRoutes);
  app.use('/api/twilio-openai/incoming-connections', requireAuth, twilioOpenaiIncomingConnectionsRoutes);
  logger.info('✅ Twilio + OpenAI Realtime Engine initialized');

  // Register KYC Engine routes
  registerKycRoutes(app, requireAuth, requireAdmin);
}
