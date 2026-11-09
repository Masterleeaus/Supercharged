/** Durable Inbox Express factory. Reject missing services, never substitute in-memory storage. */
import type { RequestHandler, Router } from 'express';
import { createInboxRouter } from './inbox-router.ts';
import type { InboxService } from './inbox-service.ts';
import { requireModule } from '../desk-modes/mode-middleware.ts';
import { commsScopeFromLocals, expressCommsRouterLike } from '../desk-modes/express-comms-adapter.ts';
import type { RoleGuardFactory, HttpHandler } from '../desk-modes/comms-router.ts';
export interface InboxProductionRouterDeps { service: InboxService; requireRole: (...roles:string[]) => RequestHandler; }
export function createInboxRouterForProduction(deps: InboxProductionRouterDeps): Router {
  if (!deps || !deps.service || typeof deps.requireRole !== 'function') throw new Error('inbox: durable service and role guards required');
  const {router,routes}=expressCommsRouterLike();
  createInboxRouter({router:routes,service:deps.service,scope:commsScopeFromLocals,
    modeGuard:requireModule('inbox') as HttpHandler,
    requireRole:deps.requireRole as unknown as RoleGuardFactory});
  return router;
}
