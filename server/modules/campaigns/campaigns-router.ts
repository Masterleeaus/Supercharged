// HTTP routes for comms campaigns, comms mode only. Factory only: nothing is mounted here.
//
// Not exposed on purpose:
//   - releaseApproved: driven by the approval decision, not by a client request.
//   - dispatchJob: called by the send worker, not by a client request.

import {
  Router as ExpressRouter,
  type NextFunction as ExpressNext,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type RequestHandler as ExpressRequestHandler,
  type Router as ExpressRouterType,
} from 'express';
import {
  createCampaignService,
  type CampaignServiceDeps,
  type CampaignService,
  type ConsentChecker,
} from './campaign-service.ts';
import type { ApprovalPort, CampaignStore, SendTransport } from './ports.ts';
import { checkConsent } from '../comms/consent.ts';
import type { SuppressionList } from '../comms/suppression.ts';
import type { CompanySettingsStore } from '../settings/company-settings.ts';
import { requireModule } from '../desk-modes/mode-middleware.ts';
import {
  bodyOf,
  commsRoute,
  prepareCommsRouter,
  queryString,
  type CommsRouterDeps,
  type HttpHandler,
  type HttpRequest,
  type HttpResponse,
  type RoleGuardFactory,
  type RouteScope,
  type RouterLike,
  type ScopeResolver,
} from '../desk-modes/comms-router.ts';

export type CampaignsRouterDeps = CommsRouterDeps<CampaignService>;

function jobFilter(req: HttpRequest): { campaignId?: string; stepId?: string; approvalId?: string } {
  const filter: { campaignId?: string; stepId?: string; approvalId?: string } = {};
  const campaignId = queryString(req, 'campaignId');
  const stepId = queryString(req, 'stepId');
  const approvalId = queryString(req, 'approvalId');
  if (campaignId !== undefined) filter.campaignId = campaignId;
  if (stepId !== undefined) filter.stepId = stepId;
  if (approvalId !== undefined) filter.approvalId = approvalId;
  return filter;
}

export function createCampaignsRouter(deps: CampaignsRouterDeps): RouterLike {
  const router = prepareCommsRouter(deps, 'campaigns');
  const { service, scope } = deps;
  // Audience exports, campaign launch, approvals and send jobs are staff-only: admin or manager.
  const staffOnly = deps.requireRole('admin', 'manager');

  router.post(
    '/audiences',
    staffOnly,
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.defineAudience(s.companyId, { name: b.name as string, channel: b.channel, tagsAll: b.tagsAll });
      },
      201,
    ),
  );

  router.get(
    '/audiences/:id/resolution',
    staffOnly,
    commsRoute(scope, (s, req) => service.resolveAudience(s.companyId, req.params.id)),
  );

  router.post(
    '/contacts',
    staffOnly,
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.addContact(s.companyId, {
          channel: b.channel,
          address: b.address,
          displayName: (b.displayName as string | null | undefined) ?? null,
          tags: b.tags,
          timezone: b.timezone,
        });
      },
      201,
    ),
  );

  router.post(
    '/opt-ins',
    staffOnly,
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.recordOptIn(s.companyId, { channel: b.channel, address: b.address, source: b.source });
      },
      201,
    ),
  );

  router.post(
    '/unsubscribes',
    staffOnly,
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.unsubscribe(s.companyId, {
          channel: b.channel,
          address: b.address,
          reason: (b.reason as string | null | undefined) ?? null,
        });
      },
      201,
    ),
  );

  router.post(
    '/campaigns',
    staffOnly,
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.createCampaign(s.companyId, {
          name: b.name as string,
          channel: b.channel,
          audienceId: b.audienceId as string,
        });
      },
      201,
    ),
  );

  router.post(
    '/campaigns/:id/steps',
    staffOnly,
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.addStep(s.companyId, req.params.id, {
          delayHours: b.delayHours,
          subject: b.subject,
          body: b.body,
        });
      },
      201,
    ),
  );

  router.post(
    '/campaigns/:id/activation',
    staffOnly,
    commsRoute(scope, (s, req) => service.activateCampaign(s.companyId, s.actor, req.params.id)),
  );

  router.post(
    '/campaigns/:id/steps/:stepId/send-request',
    staffOnly,
    commsRoute(scope, (s, req) => service.requestSend(s.companyId, s.actor, req.params.id, req.params.stepId)),
  );

  router.get('/jobs', staffOnly, commsRoute(scope, (s, req) => service.listJobs(s.companyId, jobFilter(req))));

  return router;
}

// ---------------------------------------------------------------------------
// Production composition. Builds the service with company settings, consent, suppression and
// quiet hours wired, then returns an Express router. Not mounted anywhere: the mounting site
// (server/routes.ts) is the lead's call.
// ---------------------------------------------------------------------------

/** Express request as seen by the route adapter. Tenancy is read from res.locals only. */
export type ProductionRequest = HttpRequest & { locals: Record<string, unknown> };

export interface CampaignRouterProductionDeps {
  store: CampaignStore;
  approvals: ApprovalPort;
  transport: SendTransport;
  /** Company settings store. Company quiet hours come from here and win over deps.quietHours. */
  companySettings: CompanySettingsStore;
  /** Company suppression list, checked at dispatch. */
  suppression: SuppressionList;
  /** Consent check. Defaults to checkConsent from comms/consent.ts. */
  consent?: ConsentChecker;
  /** Fallback quiet-hours source, used only for a company with no stored setting. */
  quietHours?: CampaignServiceDeps['quietHours'];
  /** Session scope resolver. Defaults to reading companyId and actor from res.locals. */
  scope?: ScopeResolver;
  now?: () => Date;
  newId?: () => string;
  approvalTtlMs?: number;
  /** Role guard factory, requireRole from middleware/auth. Required: the router refuses to build without it. */
  requireRole: (...roles: string[]) => unknown;
}

/**
 * Default scope: companyId from res.locals.companyId (set by requireCompanyScope), actor from res.locals.actor.
 * The actor's autonomy tier is carried through from that verified actor only, never from the request.
 */
export function scopeFromLocals(req: HttpRequest): RouteScope | null {
  const locals = (req as ProductionRequest).locals;
  if (!locals) return null;
  const companyId = locals.companyId;
  const actor = locals.actor as { kind?: unknown; id?: unknown; autonomy?: unknown } | undefined;
  if (typeof companyId !== 'string' || companyId === '') return null;
  if (!actor || (actor.kind !== 'human' && actor.kind !== 'agent') || typeof actor.id !== 'string' || actor.id === '') {
    return null;
  }
  const scoped: RouteScope['actor'] = { kind: actor.kind, id: actor.id };
  if (actor.autonomy !== undefined) scoped.autonomy = actor.autonomy;
  return { companyId, actor: scoped };
}

function toHttpRequest(req: ExpressRequest, res: ExpressResponse): ProductionRequest {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
  const base = req as unknown as { deskMode?: HttpRequest['deskMode']; deskHost?: string; userRole?: unknown };
  return {
    method: req.method,
    path: req.path,
    params: { ...req.params },
    query: { ...req.query },
    headers,
    body: req.body,
    deskMode: base.deskMode,
    deskHost: base.deskHost,
    userRole: typeof base.userRole === 'string' ? base.userRole : undefined,
    locals: res.locals,
  };
}

/** Runs one comms handler behind an Express route. Anything thrown goes to next(err). */
function adaptHandler(handler: HttpHandler): ExpressRequestHandler {
  return (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => {
    const httpReq = toHttpRequest(req, res);
    const httpRes = res as unknown as HttpResponse;
    Promise.resolve()
      .then(() => handler(httpReq, httpRes, (err?: unknown) => next(err)))
      .catch(next);
  };
}

/** Minimal RouterLike over an Express router, so the comms router code stays framework-free. */
function expressRouterLike(router: ExpressRouterType): RouterLike {
  return {
    use: (h: HttpHandler) => router.use(adaptHandler(h)),
    get: (path: string, ...hs: HttpHandler[]) => router.get(path, ...hs.map(adaptHandler)),
    post: (path: string, ...hs: HttpHandler[]) => router.post(path, ...hs.map(adaptHandler)),
    patch: (path: string, ...hs: HttpHandler[]) => router.patch(path, ...hs.map(adaptHandler)),
  };
}

/** Dependencies for the production campaigns service (store, transport, settings, suppression, consent). */
export type CampaignServiceProductionDeps = Omit<CampaignRouterProductionDeps, 'scope' | 'requireRole'>;

/**
 * Production service: validates every required dependency up front, then builds the campaign
 * service with companySettings, consent, suppression and quiet hours wired. The send worker
 * calls dispatchJob on this same instance.
 */
export function createCampaignServiceForProduction(deps: CampaignServiceProductionDeps): CampaignService {
  if (!deps || typeof deps !== 'object') throw new Error('campaigns: production deps are required');
  const required: Array<keyof CampaignServiceProductionDeps> = ['store', 'approvals', 'transport', 'companySettings', 'suppression'];
  for (const key of required) {
    if (!deps[key]) throw new Error(`campaigns: ${String(key)} is required for production wiring`);
  }
  return createCampaignService({
    store: deps.store,
    approvals: deps.approvals,
    transport: deps.transport,
    companySettings: deps.companySettings,
    suppression: deps.suppression,
    consent: deps.consent ?? checkConsent,
    quietHours: deps.quietHours,
    now: deps.now,
    newId: deps.newId,
    approvalTtlMs: deps.approvalTtlMs,
  });
}

/**
 * Production wiring for the campaigns module. Returns an Express router with the mode guard
 * (requireModule('campaigns')) ahead of every route. Pass `service` to share an instance with the
 * send worker; otherwise one is built from the same deps.
 */
export function createCampaignRouterForProduction(
  deps: CampaignRouterProductionDeps & { service?: CampaignService },
): ExpressRouterType {
  const service = deps.service ?? createCampaignServiceForProduction(deps);

  const expressRouter = ExpressRouter();
  createCampaignsRouter({
    router: expressRouterLike(expressRouter),
    service,
    scope: deps.scope ?? scopeFromLocals,
    modeGuard: requireModule('campaigns') as unknown as HttpHandler,
    requireRole: deps.requireRole as RoleGuardFactory,
  });
  return expressRouter;
}
