import type { Express } from "express";
import { type Server } from "http";
import { WebSocketServer } from "ws";
import { db } from "../../db";
import { agents, calls } from "@shared/schema";
import { eq } from "drizzle-orm";
import { handleTwilioStreamWebSocket } from "../../routes/webhook-routes";
import { logger } from "../../utils/logger";

export function registerTwilioStreamUpgrade(app: Express, deps: { httpServer: Server }): void {
  const { httpServer } = deps;

  // This must be registered on the httpServer to properly handle Twilio WebSocket streams
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url?.split('?')[0] || '';

    logger.info(`🔌 [Upgrade] Request for: ${request.url}`);
    logger.info(`   Pathname: ${pathname}`);

    // Only handle Twilio stream WebSocket upgrades
    if (pathname === '/api/webhooks/twilio/stream') {
      logger.info(`✅ [Upgrade] Handling Twilio stream WebSocket`);

      const wss = new WebSocketServer({ noServer: true });

      wss.handleUpgrade(request, socket, head, async (ws: any) => {
        logger.info(`✅ [WebSocket] Upgrade successful for Twilio stream`);
        logger.info(`   Waiting for Twilio 'start' event to determine routing...`);

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
              logger.info(`📨 [WebSocket] Received '${data.event}' event, buffering...`);
              return;
            }

            // Got start event - clear timeout and route to handler
            if (startTimeout) {
              clearTimeout(startTimeout);
              startTimeout = null;
            }

            logger.info(`📨 [WebSocket] Received Twilio 'start' event, routing to handler`);

            // Extract custom parameters sent from TwiML <Parameter> tags
            const customParams = data.start?.customParameters || {};
            const callId = customParams.callId;
            const agentId = customParams.agentId;

            logger.info(`   Extracted routing params:`);
            logger.info(`   - callId: ${callId}`);
            logger.info(`   - agentId: ${agentId}`);

            if (!agentId || !callId) {
              logger.error(`❌ [WebSocket] Missing required routing parameters (agentId or callId)`);
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
                logger.error(`❌ [WebSocket] Agent not found for ID: ${agentId}`);
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
                logger.error(`❌ [WebSocket] Security: Call not found for ID: ${callId}`);
                ws.close(1008, 'Call not found');
                return;
              }

              logger.info(`✅ [WebSocket] Found agent: ${agent.id} (type: ${agent.type})`);

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
              logger.info(`🔀 [WebSocket] Routing to ElevenLabs handler (agent type: ${agent.type})`);
              if (agent.type === 'flow') {
                logger.info(`   Flow context: flowId=${flowId}, executionId=${executionId}`);
              }
              handleTwilioStreamWebSocket(ws, mockReq);

              // Delay replay slightly to allow handlers to attach listeners
              // Then replay all buffered messages as raw Buffers
              setTimeout(() => {
                logger.info(`📨 [WebSocket] Replaying ${bufferedMessages.length} buffered messages`);
                for (const bufferedMsg of bufferedMessages) {
                  ws.emit('message', bufferedMsg);
                }
                // Clear buffer after replay to prevent double-processing
                bufferedMessages.length = 0;
              }, 100); // 100ms delay

            } catch (error) {
              logger.error('❌ [WebSocket] Error during routing:', error);
              ws.close(1011, 'Internal server error during routing');
            }
          } catch (error) {
            logger.error('❌ [WebSocket] Error parsing message:', error);
            // Don't close on parse errors, just log and continue
          }
        };

        // Attach temporary message handler
        ws.on('message', tempMessageHandler);

        // Set timeout for start event
        startTimeout = setTimeout(() => {
          if (!handlerRouted) {
            logger.error('❌ [WebSocket] Timeout waiting for Twilio start event');
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
      logger.info(`📡 [Upgrade] Passing through: ${pathname}`);
    }
  });
}
