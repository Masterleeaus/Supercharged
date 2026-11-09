// Shared plumbing for the comms routers (inbox, campaigns, marketing).
//
// No Express import. Each router factory takes a router object with the minimal shape
// below. At the mounting site, an Express Router satisfies it. Every route:
//   - runs the injected mode guard first (requireModule(name) in production), so a
//     workforce-mode request gets 404 before any service is touched;
//   - takes companyId and actor from the resolved session only, never from the body
//     or the query string;
//   - has company keys stripped from the body before it reaches a service;
//   - maps domain errors (code: invalid, not_found, forbidden, conflict, refused) to
//     HTTP status. Anything else is a 500 with no detail.

import type { DeskMode } from './mode-resolver.ts';
import { isCompanyId } from '../../infrastructure/database/tenant-context.ts';

export interface HttpRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  deskMode?: DeskMode;
  deskHost?: string;
  /** Role of the verified session user, copied from the authenticated request. Read by requireRole only. */
  userRole?: string;
}

export interface HttpResponse {
  statusCode: number;
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

export type NextFunction = (err?: unknown) => void;

export type HttpHandler = (req: HttpRequest, res: HttpResponse, next: NextFunction) => void | Promise<void>;

export interface RouterLike {
  use(handler: HttpHandler): unknown;
  get(path: string, ...handlers: HttpHandler[]): unknown;
  post(path: string, ...handlers: HttpHandler[]): unknown;
  patch(path: string, ...handlers: HttpHandler[]): unknown;
}

export interface RouteScope {
  companyId: string;
  /** autonomy is set only for an agent, and only from the verified session actor (res.locals.actor). */
  actor: { kind: 'human' | 'agent'; id: string; autonomy?: unknown };
}

/** Resolves company and actor from the authenticated session. Returns null when there is none. */
export type ScopeResolver = (req: HttpRequest) => RouteScope | null;

/** Builds a role guard for the listed roles, e.g. requireRole('admin', 'manager'). Admin always passes. */
export type RoleGuardFactory = (...roles: string[]) => HttpHandler;

export interface CommsRouterDeps<S> {
  router: RouterLike;
  service: S;
  scope: ScopeResolver;
  /** Mode guard for the module, e.g. requireModule('inbox'). Required: there is no default. */
  modeGuard: HttpHandler;
  /** Role guard factory (requireRole from middleware/auth). Required: a router without it refuses to build. */
  requireRole: RoleGuardFactory;
}

const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  refused: 422,
};

const COMPANY_KEYS = ['company_id', 'companyId', 'tenant_id', 'tenantId'] as const;

/**
 * Validates the injected dependencies, then installs the mode guard ahead of every route.
 * Throws at construction time if anything is missing, so a router cannot be built without a guard.
 */
export function prepareCommsRouter<S>(deps: CommsRouterDeps<S>, label: string): RouterLike {
  if (!deps || typeof deps !== 'object') throw new Error(`${label}: deps are required`);
  if (!deps.router || typeof deps.router.use !== 'function') throw new Error(`${label}: router is required`);
  if (!deps.service) throw new Error(`${label}: service is required`);
  if (typeof deps.scope !== 'function') throw new Error(`${label}: scope resolver is required`);
  if (typeof deps.modeGuard !== 'function') {
    throw new Error(`${label}: modeGuard is required; this router mounts under comms only`);
  }
  if (typeof deps.requireRole !== 'function') throw new Error(`${label}: requireRole is required`);
  deps.router.use(deps.modeGuard);
  return deps.router;
}

/** Copy of the body without company keys. Non-object bodies become an empty object. */
export function bodyOf(req: HttpRequest): Record<string, unknown> {
  const raw = req.body;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of COMPANY_KEYS) delete out[key];
  return out;
}

/** First non-empty string value of a query parameter, or undefined. */
export function queryString(req: HttpRequest, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function sendServiceError(res: HttpResponse, err: unknown): void {
  if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
    const code = (err as { code: string }).code;
    const status = Object.prototype.hasOwnProperty.call(DOMAIN_STATUS, code) ? DOMAIN_STATUS[code] : undefined;
    if (status !== undefined) {
      res.status(status).json({ error: err.message });
      return;
    }
  }
  res.status(500).json({ error: 'internal_error' });
}

/**
 * Wraps a route. Resolves the session scope first (401 if absent), then runs the handler.
 * Only the scope's companyId and actor are passed on. Nothing from the body is trusted for them.
 */
export function commsRoute(
  scope: ScopeResolver,
  run: (s: RouteScope, req: HttpRequest) => Promise<unknown>,
  status = 200,
): HttpHandler {
  return async (req, res) => {
    let s: RouteScope | null;
    try {
      s = scope(req);
    } catch {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!s || !isCompanyId(s.companyId) || !s.actor ||
      (s.actor.kind !== 'human' && s.actor.kind !== 'agent') ||
      typeof s.actor.id !== 'string' || s.actor.id.trim() === '') {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    try {
      const result = await run(s, req);
      res.status(status).json(result);
    } catch (err) {
      sendServiceError(res, err);
    }
  };
}
