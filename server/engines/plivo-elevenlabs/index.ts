'use strict';
/**
 * ============================================================
 * Plivo-ElevenLabs SIP Trunk Engine - Entry Point
 * 
 * This engine provides Plivo SIP trunk to ElevenLabs connection.
 * It is COMPLETELY ISOLATED from:
 * - Twilio + ElevenLabs integration (twilio.ts, twilio-connector.ts)
 * - Plivo + OpenAI Realtime integration (server/engines/plivo/)
 * 
 * Flow:
 * Plivo SIP → Our Server → ElevenLabs Conversational AI
 * 
 * Use this for Indian phone numbers via Plivo SIP trunk.
 * ============================================================
 */

import type { Express } from 'express';
import type { Server as HttpServer } from 'http';

export * from './types';
export { PlivoElevenLabsConfig, getSipWebhookUrl, getSipStreamUrl } from './config/config';
export { AudioConverter } from './services/audio-converter';
export { ElevenLabsBridgeService } from './services/elevenlabs-bridge.service';
export { PlivoElevenLabsOutboundService } from './services/outbound-call.service';
export { setupPlivoElevenLabsWebhooks } from './routes/webhooks';
export { setupPlivoElevenLabsStream } from './routes/stream';

import { setupPlivoElevenLabsWebhooks } from './routes/webhooks';
import { setupPlivoElevenLabsStream } from './routes/stream';
import { getWebhookBaseUrl } from './config/config';
import { logger } from '../../utils/logger';

/**
 * Initialize the Plivo-ElevenLabs SIP trunk engine (HTTP routes only)
 */
export function initPlivoElevenLabsEngine(app: Express): void {
  const baseUrl = getWebhookBaseUrl();
  
  logger.info('🔗 Initializing Plivo-ElevenLabs SIP Trunk Engine');
  logger.info(`   Base URL: ${baseUrl}`);
  logger.info('   Webhook: /api/plivo-elevenlabs/voice/answer');
  logger.info('   Stream: /api/plivo-elevenlabs/stream/:callUuid');
  logger.info('   Incoming: /api/plivo-elevenlabs/incoming');
  
  setupPlivoElevenLabsWebhooks(app, baseUrl);
  
  logger.info('✅ Plivo-ElevenLabs SIP Trunk HTTP routes registered');
}

/**
 * Initialize the Plivo-ElevenLabs WebSocket stream on HTTP server
 * Call this after all other WebSocket handlers are registered
 */
export function initPlivoElevenLabsStream(httpServer: HttpServer): void {
  setupPlivoElevenLabsStream(httpServer);
  logger.info('✅ Plivo-ElevenLabs SIP Trunk WebSocket stream registered');
}
