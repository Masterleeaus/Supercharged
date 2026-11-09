/**
 * Cockpit routes for the Desk dashboard.
 *
 *   GET /api/workforce/activity     workforce activity feed (completed work, approvals waiting, runs needing attention)
 *   GET /api/desk-mode              which Desk mode the request's host belongs to
 *   GET /api/campaigns/responses    campaign response feed (replies, opt-outs, conversions, calls)
 *
 * Feature routes run a mode guard first (deskModeMiddleware + requireModule): the activity feed needs the
 * workforce-runtime module, the campaign responses feed needs the campaigns module. A request from the other
 * host, or an unknown host, gets 404 before any auth or service call. Then the chain runs: authenticate,
 * requireCompanyScope, then setScopedCompany. DESK_MODE_PATH is host-guarded as well and requires
 * an authenticated company; unknown hosts get 404, not a fallback mode.
 * Company scope comes only from the verified session (req.user.companyId, through getCompanyScope),
 * copied to res.locals.companyId. Request bodies, queries, params and headers are never read for tenancy.
 *
 * The desk-mode lookup reads the Host header only (sessionDeskMode). X-Forwarded-Host is never read.
 *
 * No stored run list or campaign event store exists yet, so both feeds pass an empty list and say so
 * in the response (runsSource / eventsSource set to 'none').
 *
 * Builder refusals return 400 with the refusal reason. A missing company returns 403 from requireCompanyScope.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getCompanyScope } from '../middleware/company-scope.ts';
import { buildWorkforceActivity, type WorkforceApprovalInput, type WorkforceRunInput } from '../workforce/runtime/activity-feed.ts';
import { type DeskModeConfig } from '../modules/desk-modes/mode-resolver.ts';
import { deskModeMiddleware, requireModule } from '../modules/desk-modes/mode-middleware.ts';
import { DEFAULT_DESK_MODE_CONFIG, sessionDeskMode } from '../modules/desk-modes/session-mode.ts';
import { buildCampaignResponses } from '../modules/comms/campaign-responses-feed.ts';
import type { CampaignEvent } from '../modules/comms/campaign-analytics.ts';
import type { ApprovalService } from '../modules/approvals/approval-service.ts';

export const ACTIVITY_PATH = '/api/workforce/activity';
export const DESK_MODE_PATH = '/api/desk-mode';
export const CAMPAIGN_RESPONSES_PATH = '/api/campaigns/responses';

/** Kept for existing importers (server/routes.ts). Same hosts as desk-modes/session-mode.ts. */
export const DEFAULT_MODE_CONFIG: DeskModeConfig = DEFAULT_DESK_MODE_CONFIG;

/** Guards are passed in by the caller, so the real auth middleware is wired in routes.ts and tests can use stubs. */
export interface CockpitGuards {
  authenticate: RequestHandler;
  requireCompanyScope: RequestHandler;
  /** Admin or manager only. The activity feed lists pending approvals, which the approvals list also limits to these roles. */
  requireApprover: RequestHandler;
}

export interface CockpitDeps {
  /** Pending approvals for one company. Defaults to the approval service. Only the company passed in is ever queried. */
  loadApprovals?: (companyId: string) => Promise<readonly WorkforceApprovalInput[]> | readonly WorkforceApprovalInput[];
  /** Desk mode host config. Defaults to DEFAULT_MODE_CONFIG. */
  modeConfig?: DeskModeConfig;
}

let approvalService: ApprovalService | null = null;

/**
 * Built on first use. The approvals module is loaded lazily so importing this router does not pull in
 * the database layer, which matters for tests that inject their own loader.
 */
async function defaultApprovalService(): Promise<ApprovalService> {
  if (approvalService === null) {
    const { ApprovalService: Service, poolTenantRunner } = await import('../modules/approvals/index.ts');
    approvalService = new Service({ tenant: poolTenantRunner });
  }
  return approvalService;
}

/** Maps approval views to the fields the activity builder reads. Request params are not passed on. */
async function defaultLoadApprovals(companyId: string): Promise<WorkforceApprovalInput[]> {
  const service = await defaultApprovalService();
  const views = await service.listApprovals(companyId, { status: 'pending', limit: 50 });
  return views.map((view) => ({
    id: view.id,
    companyId,
    status: view.status,
    action: view.action,
    requestedAt: view.createdAt,
  }));
}

/** Sets res.locals.companyId from the verified session company. Fails closed with 403 when absent. */
function setScopedCompany(req: Request, res: Response, next: NextFunction): void {
  try {
    res.locals.companyId = getCompanyScope(req);
  } catch {
    res.status(403).json({ error: 'Company scope required' });
    return;
  }
  next();
}

function scopedCompanyId(res: Response): string {
  return res.locals.companyId as string;
}

export function createCockpitRouter(deps: CockpitDeps, guards: CockpitGuards): Router {
  const router = Router();
  const loadApprovals = deps.loadApprovals ?? defaultLoadApprovals;
  const modeConfig = deps.modeConfig ?? DEFAULT_MODE_CONFIG;
  const chain: RequestHandler[] = [guards.authenticate, guards.requireCompanyScope, setScopedCompany];
  // Mode guards run first, so a route outside the request's mode gets 404 before any auth or service call.
  // deskModeMiddleware sets req.deskMode from the Host header only and 404s unknown hosts.
  const modeFromHost = deskModeMiddleware(modeConfig) as unknown as RequestHandler;
  const workforceOnly: RequestHandler[] = [modeFromHost, requireModule('workforce-runtime') as unknown as RequestHandler];
  const commsOnly: RequestHandler[] = [modeFromHost, requireModule('campaigns') as unknown as RequestHandler];

  // No stored run list yet. The builder receives an empty list and the response says so.
  const runs: WorkforceRunInput[] = [];

  router.get(ACTIVITY_PATH, ...workforceOnly, guards.authenticate, guards.requireCompanyScope, guards.requireApprover, setScopedCompany, async (_req: Request, res: Response, next: NextFunction) => {
    const companyId = scopedCompanyId(res);
    try {
      const approvals = await loadApprovals(companyId);
      const items = buildWorkforceActivity({
        companyId,
        runs,
        approvals: [...approvals],
        now: new Date(),
      });
      res.json({ items, runsSource: 'none' });
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_company') {
        res.status(400).json({ error: 'invalid_company' });
        return;
      }
      next(error);
    }
  });

  // Authenticated session mode for a verified host only; never cache across sessions.
  router.get(DESK_MODE_PATH, modeFromHost, ...chain, (req: Request, res: Response) => {
    const result = sessionDeskMode(req.headers.host, modeConfig);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(result);
  });

  // No campaign event store yet. The builder receives an empty list and the response says so.
  const events: readonly CampaignEvent[] = [];

  router.get(CAMPAIGN_RESPONSES_PATH, ...commsOnly, ...chain, (_req: Request, res: Response) => {
    const companyId = scopedCompanyId(res);
    const result = buildCampaignResponses({ companyId, events });
    if (result.ok === false) {
      res.status(400).json({ error: result.error, message: result.message });
      return;
    }
    res.json({ items: result.items, eventsSource: 'none' });
  });

  return router;
}
