/** Disabled by default. When enabled, requires injected durable service; fails before any router is mounted. */
import type { Express, RequestHandler } from 'express';
import { deskModeMiddleware } from '../../modules/desk-modes/mode-middleware.ts';
import { DEFAULT_DESK_MODE_CONFIG } from '../../modules/desk-modes/session-mode.ts';
import { createInboxRouterForProduction } from '../../modules/inbox/production-router.ts';
import { createMarketingRouterForProduction } from '../../modules/marketing/production-router.ts';
import type { InboxService } from '../../modules/inbox/inbox-service.ts';
import type { MarketingService } from '../../modules/marketing/marketing-service.ts';
import { assertServiceContract } from '../../modules/desk-modes/service-contracts.ts';
export interface OptionalCommsMountDeps {
 authenticate:RequestHandler; requireCompanyScope:RequestHandler;
 requireRole:(...roles:string[])=>RequestHandler; inbox?:InboxService; marketing?:MarketingService;
 env?:Record<string,string|undefined>;
}
export function registerOptionalCommsRoutes(app:Pick<Express,'use'>,deps:OptionalCommsMountDeps) {
 if(!deps||typeof deps.authenticate!=='function'||typeof deps.requireCompanyScope!=='function'||typeof deps.requireRole!=='function') throw new Error('comms: authentication, company scope and roles required');
 const env=deps.env??process.env;
 const inboxEnabled=env.COMMS_INBOX_ENABLED==='true', marketingEnabled=env.COMMS_MARKETING_ENABLED==='true';
 if(inboxEnabled&&!deps.inbox) throw new Error('COMMS_INBOX_ENABLED requires durable InboxService');
 if(marketingEnabled&&!deps.marketing) throw new Error('COMMS_MARKETING_ENABLED requires durable MarketingService');
 // Validate all enabled service operations before mounting either surface.
 if(inboxEnabled) assertServiceContract('inbox',deps.inbox);
 if(marketingEnabled) assertServiceContract('marketing',deps.marketing);
 const common:RequestHandler[]=[
  deskModeMiddleware(DEFAULT_DESK_MODE_CONFIG) as RequestHandler,
  deps.authenticate, deps.requireCompanyScope,
  (req,res,next)=> {
   const id=(req as typeof req & {userId?:unknown}).userId;
   if(typeof id!=='string'||id.trim()==='') {res.status(401).json({error:'unauthenticated'});return;}
   res.locals.actor={kind:'human',id};next();
  },
 ];
 const mounted:string[]=[],skipped:string[]=[];
 if(inboxEnabled){app.use('/api/comms/inbox',...common,createInboxRouterForProduction({service:deps.inbox!,requireRole:deps.requireRole}));mounted.push('inbox');}
 else skipped.push('inbox');
 if(marketingEnabled){app.use('/api/comms/marketing',...common,createMarketingRouterForProduction({service:deps.marketing!,requireRole:deps.requireRole}));mounted.push('marketing');}
 else skipped.push('marketing');
 return {mounted,skipped};
}
