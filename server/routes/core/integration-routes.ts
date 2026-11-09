import type { Express, RequestHandler } from "express";
import { authenticateToken } from "../../middleware/auth";
import { googleSheetsRouter } from "../../services/google-sheets/google-sheets.routes";
import { createRAGKnowledgeRoutes } from "../../routes/rag-knowledge-routes";
import { requireCompanyScope } from "../../middleware/company-scope";
import type { RouteContext } from "./shared";

export async function registerIntegrationRoutes(app: Express, deps: { routeContext: RouteContext }): Promise<void> {
  const { routeContext } = deps;

  // RAG Knowledge Base routes (scalable alternative to ElevenLabs 20MB KB)
  // Mounted unconditionally: no env check here. USE_RAG_KNOWLEDGE is read only by isRAGEnabled()
  // (services/rag-elevenlabs-tool.ts), which defaults to on and is off only when set to false, 0 or no.
  const ragKnowledgeRoutes = createRAGKnowledgeRoutes(routeContext.authenticateHybrid, { requireCompanyScope: requireCompanyScope() });
  app.use("/api/rag-knowledge", ragKnowledgeRoutes);

  // Google Sheets authenticated endpoints (auth, status, disconnect, sheets list)
  app.use("/api/integrations/google", authenticateToken as unknown as import('express').RequestHandler, googleSheetsRouter);

  // Google Calendar authenticated endpoints (auth, exchange, status, disconnect)
  const { googleCalendarRouter } = await import("../../services/google-calendar/google-calendar.routes");
  app.use("/api/google-calendar", authenticateToken as unknown as import('express').RequestHandler, googleCalendarRouter);
}
