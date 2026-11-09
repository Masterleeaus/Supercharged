import type { Express, RequestHandler } from "express";
import flowAutomationRouter from "../../routes/flow-automation-routes";
import incomingConnectionsRouter from "../../routes/incoming-connections-routes";
import invoiceRouter from "../../routes/invoice-routes";
import audioRoutes from "../../routes/audio-routes";
import type { RouteContext } from "./shared";

export function registerUserServiceRoutes(app: Express, deps: { routeContext: RouteContext }): void {
  const { routeContext } = deps;

  // Audio upload routes
  app.use("/api/audio", audioRoutes);

  // Invoice routes (download, generate)
  app.use("/api/invoices", invoiceRouter);

  // Flow Automation routes
  // Use hybrid auth to allow both users and team members
  app.use("/api/flow-automation", routeContext.authenticateHybrid as unknown as import('express').RequestHandler, flowAutomationRouter);

  // Incoming Connections routes (links agents to phone numbers)
  app.use("/api/incoming-connections", incomingConnectionsRouter);
}
