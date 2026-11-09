import type { Express, RequestHandler } from "express";
import { type Server } from "http";
import { hybridGateUnlessExempt } from "../../middleware/hybrid-gate-exemptions";
import { widgetRoutes } from "../../modules/widget";
import type { RouteContext } from "./shared";
import { logger } from "../../utils/logger";

export function registerStreamWidgetRoutes(app: Express, deps: { httpServer: Server; routeContext: RouteContext }): void {
  const { httpServer, routeContext } = deps;

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
      logger.info(`🔌 [Stream Proxy Fix] Reverse proxy stripped WebSocket headers for ${req.url}, restoring and re-emitting upgrade`);
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
}
