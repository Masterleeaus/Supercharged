/**
 * Dead-letter webhook listing for the company in the verified session.
 *
 * GET /api/webhooks/dead-letters
 *
 * Every request runs the chain: authenticate, requireCompanyScope, requireApprover (admin or manager),
 * then setScopedCompany. The company is read only from res.locals.companyId, which requireCompanyScope
 * sets from the session. Query and body values never choose the tenant.
 *
 * The service module is loaded lazily so importing this router does not pull in the database layer.
 * Tests inject their own listDeadLetterDeliveries.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getCompanyScope } from '../middleware/company-scope.ts';
import type { PaymentWebhookQueue } from '@shared/schema';

export const DEAD_LETTER_PATH = '/api/webhooks/dead-letters';

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/** Guards are passed in by the caller so tests can use stubs and routes.ts can wire the real middleware. */
export interface DeadLetterGuards {
  authenticate: RequestHandler;
  requireCompanyScope: RequestHandler;
  /** Admin or manager only. Members are refused before the service runs. */
  requireApprover: RequestHandler;
}

export type ListDeadLetterDeliveries = (companyId: string, limit: number) => Promise<PaymentWebhookQueue[]> | PaymentWebhookQueue[];

export interface DeadLetterDeps {
  /** Defaults to listDeadLetterDeliveries from server/services/webhook-retry-service.ts. */
  listDeadLetterDeliveries?: ListDeadLetterDeliveries;
}

/** Parses the limit query value and clamps it to 1..100. Missing or non-numeric values use the default. */
export function clampDeadLetterLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, value));
}

let defaultLister: ListDeadLetterDeliveries | null = null;

async function loadDefaultLister(companyId: string, limit: number): Promise<PaymentWebhookQueue[]> {
  if (defaultLister === null) {
    const service = await import('../services/webhook-retry-service.ts');
    defaultLister = service.listDeadLetterDeliveries;
  }
  return defaultLister(companyId, limit);
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

export function createDeadLetterRouter(deps: DeadLetterDeps, guards: DeadLetterGuards): Router {
  const router = Router();
  const list = deps.listDeadLetterDeliveries ?? loadDefaultLister;

  router.get(
    DEAD_LETTER_PATH,
    guards.authenticate,
    guards.requireCompanyScope,
    guards.requireApprover,
    setScopedCompany,
    async (req: Request, res: Response, next: NextFunction) => {
      const companyId = res.locals.companyId as string;
      const limit = clampDeadLetterLimit(req.query.limit);
      try {
        const items = await list(companyId, limit);
        res.json({ items, limit });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
