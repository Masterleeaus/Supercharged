import type { Express, RequestHandler } from "express";
import { platformLanguagesPublicRouter } from "../../routes/platform-languages-routes";
import crmRoutes from "../../routes/crm-routes";
import { publicWidgetRoutes } from "../../modules/widget";
import type { RouteContext } from "./shared";

export function registerCrmPublicRoutes(app: Express, deps: { routeContext: RouteContext }): void {
  const { routeContext } = deps;

  // CRM routes - Lead Management (isolated module)
  // Use hybrid auth to allow both users and team members
  app.use("/api/crm", routeContext.authenticateHybrid as unknown as import('express').RequestHandler, crmRoutes);

  // Public Platform Languages route - for i18n dynamic loading (no auth required)
  // Must be registered BEFORE publicWidgetRoutes to ensure specific path matches first
  app.use("/api/public/platform-languages", platformLanguagesPublicRouter);

  // Website Widget routes - Embeddable voice widgets (isolated module)
  // Public widget routes must be registered BEFORE authenticated routes to allow external website embedding
  app.use("/api/public", publicWidgetRoutes);
}
