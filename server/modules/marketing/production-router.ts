/** Durable Marketing Express factory. Reject missing services and guards. */
import type { RequestHandler, Router } from 'express';
import { createMarketingRouter } from './marketing-router.ts';
import type { MarketingService } from './marketing-service.ts';
import { requireModule } from '../desk-modes/mode-middleware.ts';
import { commsScopeFromLocals, expressCommsRouterLike } from '../desk-modes/express-comms-adapter.ts';
import type { RoleGuardFactory, HttpHandler } from '../desk-modes/comms-router.ts';
export interface MarketingProductionRouterDeps { service: MarketingService; requireRole: (...roles:string[]) => RequestHandler; }
export function createMarketingRouterForProduction(deps: MarketingProductionRouterDeps): Router {
  if (!deps || !deps.service || typeof deps.requireRole !== 'function') throw new Error('marketing: durable service and role guards required');
  const {router,routes}=expressCommsRouterLike();
  createMarketingRouter({router:routes,service:deps.service,scope:commsScopeFromLocals,
    modeGuard:requireModule('marketing') as HttpHandler,
    requireRole:deps.requireRole as unknown as RoleGuardFactory});
  return router;
}
