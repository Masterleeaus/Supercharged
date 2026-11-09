import type { Express, RequestHandler } from "express";
import { authenticateToken, requireRole, type AuthRequest } from "../../middleware/auth";
import { workforceHealthHandler } from "../../workforce/runtime/health.ts";
import { agentRunsFromRecords, createWorkforceAdminRouter, workforceControls } from "../../workforce/runtime/workforce-admin-routes.ts";
import { createPgRoster } from "../../workforce/pg-roster.ts";
import { createTaskBoardRouter } from "../../workforce/runtime/task-board-routes.ts";
import { createPgRunStore, type SqlExecutor } from "../../workforce/runtime/pg-store.ts";
import { createCompanyControlsRouter } from "../../workforce/runtime/company-controls-routes.ts";
import { loadCatalogueAtStartup, getActiveCatalogue } from "../../workforce/catalogue/startup.ts";
import { createRoster, listAgents as listRosterAgents } from "../../workforce/roster.ts";
import { createWorkforceRosterRouter } from "../../routes/workforce-roster-routes.ts";
import { createDeadLetterRouter } from "../../routes/dead-letter-routes.ts";
import { createCampaignRouterForProduction, createDrizzleCampaignStore, type ApprovalPort, type SendTransport } from "../../modules/campaigns/index.ts";
import { createCompanySettingsStore } from "../../modules/settings/company-settings.ts";
import { pool } from "../../db";
import type { TenantPool } from "../../infrastructure/database/tenant-context";
import { createSuppressionList } from "../../modules/comms/suppression.ts";
import { deskModeMiddleware } from "../../modules/desk-modes/index.ts";
import { featureEnabled } from "../../lib/feature-flags";
import { requireCompanyScope } from "../../middleware/company-scope";
import { createCockpitRouter, DEFAULT_MODE_CONFIG } from "../../routes/cockpit-routes";
import type { CommsAuditSink } from "./shared";
import { logger } from "../../utils/logger";

export async function registerWorkforceCommsRoutes(app: Express, deps: { commsAudit: CommsAuditSink }): Promise<void> {
  const { commsAudit } = deps;

  await loadCatalogueAtStartup();
  await (await import("../../workforce/runtime/startup.ts")).startWorkforceRuntime();
  app.get("/api/workforce/health", authenticateToken, requireRole("admin"), workforceHealthHandler);
  // Agent writes (create, configure, pause, resume, retire) use the Postgres roster, so they survive a restart and match
  // what the server stores. The retire guard reads running work through the run store. With no active catalogue the
  // roster is unset and those routes return 503 (fail closed).
  const adminDbPool = (await import("../../db")).pool as unknown as SqlExecutor;
  const adminCatalogue = getActiveCatalogue();
  const adminRoster = adminCatalogue ? createPgRoster({ db: adminDbPool, catalogue: adminCatalogue }) : undefined;
  const adminRunStore = createPgRunStore(adminDbPool);
  app.use(createWorkforceAdminRouter({
    controls: workforceControls,
    roster: adminRoster,
    getRuns: async (companyId: string) => agentRunsFromRecords(await adminRunStore.listRuns(companyId)),
    isRosterAgent: async (companyId: string, agentId: string) => (await adminRoster?.getAgent(companyId, agentId)) !== undefined,
  }, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireAdmin: requireRole("admin") as unknown as import('express').RequestHandler, requireManager: requireRole("admin", "manager") as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope() }));
  app.use((await import("../../workforce/runtime/shadow-routes.ts")).createShadowRouterForProduction((await import("../../db")).pool as unknown as import("../../workforce/runtime/shadow-routes.ts").ShadowPool, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireApprover: requireRole("admin", "manager") as unknown as import('express').RequestHandler }));
  app.use(createTaskBoardRouter({ store: createPgRunStore((await import("../../db")).pool as unknown as SqlExecutor) }, { authenticate: authenticateToken as unknown as import('express').RequestHandler, requireCompanyScope: requireCompanyScope(), requireAdminOrManager: requireRole("admin", "manager") as unknown as import('express').RequestHandler }));
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
  logger.info(`[flags] COMMS_CAMPAIGNS_ENABLED=${commsCampaignsEnabled ? "on" : "off"} (default off)`);
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
      companySettings: createCompanySettingsStore({ pool: pool as unknown as TenantPool }),
      suppression: createSuppressionList({ audit: commsAudit.audit, clock: () => new Date().toISOString() }),
      requireRole: requireRole("admin", "manager") as unknown as import('express').RequestHandler,
    }),
  );
}
