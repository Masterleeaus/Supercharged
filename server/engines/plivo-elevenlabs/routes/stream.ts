'use strict';
/**
 * ============================================================
 * Plivo-ElevenLabs SIP Trunk - WebSocket Stream Route
 * 
 * Handles bidirectional audio streaming between Plivo and ElevenLabs.
 * ISOLATED from existing Twilio+ElevenLabs and Plivo+OpenAI systems.
 * 
 * Session Lifecycle:
 * - Inbound calls: /incoming webhook creates session before stream connects
 * - Outbound calls: Session should be pre-created by the outbound call service
 * - If no session exists when stream starts, logs error (audio will be dropped)
 * ============================================================
 */

import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ElevenLabsBridgeService } from '../services/elevenlabs-bridge.service';
import { logger } from '../../../utils/logger';

interface PlivoStreamMessage {
  event: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    callId: string;
    tracks: string[];
    mediaFormat?: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  stop?: {
    reason: string;
  };
}

/**
 * Setup Plivo-ElevenLabs WebSocket stream handler on the HTTP server
 */
export function setupPlivoElevenLabsStream(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url?.split('?')[0] || '';
    
    if (pathname.startsWith('/api/plivo-elevenlabs/stream/')) {
      const callUuid = pathname.split('/api/plivo-elevenlabs/stream/')[1];
      
      if (!callUuid) {
        logger.error(`[Plivo-ElevenLabs Stream] Invalid stream URL: ${pathname}`);
        socket.destroy();
        return;
      }
      
      logger.info(`✅ [Plivo-ElevenLabs Stream] Handling WebSocket upgrade for call: ${callUuid}`);
      
      wss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
        logger.info(`✅ [Plivo-ElevenLabs Stream] WebSocket connected for call: ${callUuid}`);
        handleStreamConnection(ws, callUuid);
      });
    }
  });

  logger.info('✅ Plivo-ElevenLabs WebSocket stream endpoint registered');
}

/**
 * Handle Plivo stream WebSocket connection
 */
function handleStreamConnection(ws: WebSocket, callUuid: string): void {
  let streamSid: string | null = null;
  let isConnected = false;
  let sessionMissing = false;
  let audioDropped = 0;
  let sessionEnded = false;

  ws.on('message', async (data: Buffer | string) => {
    try {
      const rawData = typeof data === 'string' ? data : data.toString('utf8');
      const message: PlivoStreamMessage = JSON.parse(rawData);
      
      switch (message.event) {
        case 'connected':
          logger.info(`[Plivo-ElevenLabs Stream] Connected event for ${callUuid}`);
          break;
          
        case 'start':
          streamSid = message.start?.streamSid || message.streamSid || null;
          logger.info(`[Plivo-ElevenLabs Stream] Stream started: ${streamSid}`);
          if (message.start?.mediaFormat) {
            logger.info(`[Plivo-ElevenLabs Stream] Media format: ${JSON.stringify(message.start.mediaFormat)}`);
          }
          
          if (!ElevenLabsBridgeService.hasSession(callUuid)) {
            logger.error(`[Plivo-ElevenLabs Stream] ERROR: No session found for ${callUuid}. Audio will be dropped.`);
            logger.error(`[Plivo-ElevenLabs Stream] Session must be created by /incoming webhook or outbound call service before stream connects.`);
            sessionMissing = true;
          } else {
            ElevenLabsBridgeService.setPlivoWebSocket(callUuid, ws, streamSid || '');
            isConnected = true;
          }
          break;
          
        case 'media':
          if (sessionMissing) {
            audioDropped++;
            if (audioDropped === 1 || audioDropped % 100 === 0) {
              logger.warn(`[Plivo-ElevenLabs Stream] Dropping audio (${audioDropped} chunks) - no session for ${callUuid}`);
            }
            return;
          }
          
          if (message.media?.payload && isConnected) {
            await ElevenLabsBridgeService.handlePlivoAudio(callUuid, message.media.payload);
          }
          break;
          
        case 'stop':
          logger.info(`[Plivo-ElevenLabs Stream] Stream stopped: ${message.stop?.reason}`);
          if (audioDropped > 0) {
            logger.warn(`[Plivo-ElevenLabs Stream] Total audio chunks dropped: ${audioDropped}`);
          }
          isConnected = false;
          break;
          
        default:
          break;
      }
    } catch (error: any) {
      logger.error(`[Plivo-ElevenLabs Stream] Error processing message:`, error.message);
    }
  });

  ws.on('close', async (code: number, reason: Buffer) => {
    logger.info(`[Plivo-ElevenLabs Stream] WebSocket closed for ${callUuid}: ${code}`);
    isConnected = false;
    
    if (!sessionMissing && !sessionEnded) {
      sessionEnded = true;
      try {
        const result = await ElevenLabsBridgeService.endSession(callUuid);
        logger.info(`[Plivo-ElevenLabs Stream] Session ended: duration=${result.duration}s, transcript parts=${result.transcript.length}`);
      } catch (err: any) {
        logger.error(`[Plivo-ElevenLabs Stream] Error ending session:`, err.message);
      }
    }
  });

  ws.on('error', (error: Error) => {
    logger.error(`[Plivo-ElevenLabs Stream] WebSocket error for ${callUuid}:`, error);
    isConnected = false;
  });
}
