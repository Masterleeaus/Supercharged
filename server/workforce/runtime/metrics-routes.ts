/**
 * Read-only metrics route for the workforce dashboard (checklist section 11).
 *
 *   GET /api/workforce/metrics
 *
 * Response: { snapshot, alerts, agentBreakdown }. Every number is for the caller's company only.
 * Provider errors and approval gauges are process-wide and are not attributed to a company, so they are not returned here.
 *
 * Every route runs the same chain, in this order: authenticate, admin role, company scope, rate limit.
 * Company scope comes only from the verified token (through getCompanyScope), which is copied to res.locals.companyId.
 * Query strings, params, bodies and headers are never read for tenancy. The route has no write methods.
 *
 * Fails closed: 503 when no metrics instance is configured, 403 when company scope is missing.
 * The metrics instance is injected through deps.getMetrics, read on each request.
 */
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import { getCompanyScope } from '../../middleware/company-scope.ts';
import { apiRateLimiter } from '../../middleware/rateLimiter.ts';
import type { WorkforceMetrics } from './workforce-metrics.ts';

export const WORKFORCE_METRICS_PATH = '/api/workforce/metrics';

export interface WorkforceMetricsRouteDeps {
  /** Returns the metrics instance, or null/undefined when none is configured. Read on every request. */
  getMetrics?: () => WorkforceMetrics | null | undefined;
}

/** Guards are passed in so the real auth middleware is wired by the caller and tests can use stubs. */
export interface WorkforceMetricsRouteGuards {
  authenticate: RequestHandler;
  requireAdmin: RequestHandler;
  requireCompanyScope: RequestHandler;
}

/**
 * Process-wide holder for the one metrics instance that the run engine's audit sink also feeds
 * (metricsAuditSink). Null until the server wiring sets it; the route refuses until then.
 */
export const workforceMetricsHolder: { metrics: WorkforceMetrics | null } = { metrics: null };

/** Sets res.locals.companyId from the verified session company. Fails closed with 403 when absent. */
function setScopedCompany(req: Request, res: Response, next: NextFunction): void {
  let companyId: unknown;
  try {
    companyId = getCompanyScope(req);
  } catch {
    res.status(403).json({ error: 'Company scope required' });
    return;
  }
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    res.status(403).json({ error: 'Company scope required' });
    return;
  }
  res.locals.companyId = companyId;
  next();
}

export function createWorkforceMetricsRouter(deps: WorkforceMetricsRouteDeps, guards: WorkforceMetricsRouteGuards): Router {
  const router = Router();
  const chain: RequestHandler[] = [guards.authenticate, guards.requireAdmin, guards.requireCompanyScope, setScopedCompany, apiRateLimiter];

  router.get(WORKFORCE_METRICS_PATH, ...chain, (_req: Request, res: Response, next: NextFunction) => {
    const metrics = deps.getMetrics?.() ?? null;
    if (!metrics) {
      res.status(503).json({ error: 'dependency_not_configured', dependency: 'metrics' });
      return;
    }
    const companyId = res.locals.companyId as string;
    try {
      res.json({
        snapshot: metrics.companySnapshot(companyId),
        alerts: metrics.companyAlerts(companyId),
        // Run audit records carry a role or a coordinator, not the acting agent, so outcomes by agent are not computed yet.
        agentBreakdown: { available: false, reason: 'agent_id_not_recorded' },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
