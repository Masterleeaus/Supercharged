/** Express bridge: tenant and actor always derive from verified response locals. */
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import type { HttpHandler, HttpRequest, HttpResponse, RouterLike, RouteScope } from './comms-router.ts';
import { isCompanyId } from '../../infrastructure/database/tenant-context.ts';
export function commsScopeFromLocals(req: HttpRequest): RouteScope | null {
  const locals = (req as HttpRequest & { locals?: Record<string, unknown> }).locals;
  if (!locals || !isCompanyId(locals.companyId)) return null;
  const a = locals.actor as Record<string, unknown> | undefined;
  if (!a || (a.kind !== 'human' && a.kind !== 'agent') || typeof a.id !== 'string' || a.id.trim() === '') return null;
  const actor: RouteScope['actor'] = { kind: a.kind, id: a.id };
  if (a.autonomy !== undefined) actor.autonomy = a.autonomy;
  return { companyId: locals.companyId, actor };
}
export function adaptCommsHandler(handler: HttpHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const source = req as Request & { deskMode?: HttpRequest['deskMode']; deskHost?: string; userRole?: string };
    const forwarded: HttpRequest & { locals: Record<string, unknown> } = {
      method: req.method, path: req.path, params: { ...req.params } as Record<string,string>,
      query: { ...req.query }, headers: req.headers as HttpRequest['headers'], body: req.body,
      deskMode: source.deskMode, deskHost: source.deskHost, userRole: source.userRole, locals: res.locals,
    };
    Promise.resolve().then(() => handler(forwarded, res as unknown as HttpResponse, next)).catch(next);
  };
}
export function expressCommsRouterLike(router: Router = Router()): { router: Router; routes: RouterLike } {
  return { router, routes: {
    use(handler) { router.use(adaptCommsHandler(handler)); },
    get(path, ...handlers) { router.get(path, ...handlers.map(adaptCommsHandler)); },
    post(path, ...handlers) { router.post(path, ...handlers.map(adaptCommsHandler)); },
    patch(path, ...handlers) { router.patch(path, ...handlers.map(adaptCommsHandler)); },
  }};
}
