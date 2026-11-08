/**
 * HTTP metrics middleware and the access guard for the /metrics endpoint.
 *
 * Runtime-independent of express: only type imports, so it can be unit tested
 * without the framework installed.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { HttpRequestSample } from '../services/metrics';

export interface HttpMetricsSink {
  observeHttpRequest(sample: HttpRequestSample): void;
}

export const UNMATCHED_ROUTE = '__unmatched__';
export const OTHER_METHOD = 'OTHER';
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const NOOP_SINK: HttpMetricsSink = { observeHttpRequest() {} };

/**
 * Route pattern for the matched route (e.g. /api/users/:id).
 * Returns a fixed placeholder when no route matched, so raw URLs never become labels.
 */
export function routeLabel(req: Pick<Request, 'route' | 'baseUrl'>): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string') return UNMATCHED_ROUTE;
  return `${req.baseUrl ?? ''}${path}`;
}

export function methodLabel(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : OTHER_METHOD;
}

export function statusClassLabel(status: number): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
  return `${Math.floor(status / 100)}xx`;
}

export function createMetricsMiddleware(sink: HttpMetricsSink = NOOP_SINK): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    let recorded = false;

    const record = (statusClass: string) => {
      if (recorded) return;
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      try {
        sink.observeHttpRequest({
          method: methodLabel(req.method),
          route: routeLabel(req),
          statusClass,
          durationSeconds,
        });
      } catch {
        // Metrics must never affect the response.
      }
    };

    res.on('finish', () => record(statusClassLabel(res.statusCode)));
    res.on('close', () => record('aborted'));
    next();
  };
}

export interface MetricsAccessOptions {
  /** Bearer token accepted for scrapers (METRICS_TOKEN). */
  metricsToken?: string;
  /** Admin check, e.g. checkAdmin from middleware/admin-auth. Runs when no valid metrics token is presented. */
  adminAuth?: (req: any, res: any, next: any) => unknown;
}

function bearerToken(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Fails closed. With neither a metrics token nor an admin check configured,
 * responds 404 so the endpoint is indistinguishable from an absent route.
 */
export function createMetricsAccessGuard(options: MetricsAccessOptions): RequestHandler {
  const token = options.metricsToken?.trim() || undefined;
  const adminAuth = typeof options.adminAuth === 'function' ? options.adminAuth : undefined;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!token && !adminAuth) {
      res.status(404).end();
      return;
    }
    const presented = bearerToken(req);
    if (token && presented !== undefined && tokensMatch(presented, token)) {
      next();
      return;
    }
    if (adminAuth) {
      adminAuth(req, res, next);
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };
}
