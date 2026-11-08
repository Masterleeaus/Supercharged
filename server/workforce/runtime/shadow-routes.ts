/**
 * Review routes for shadow writes (docs/SHADOW_WRITES_DESIGN.md).
 *
 *   GET  /api/workforce/shadow-changes/pending        list pending changes for the session company
 *   POST /api/workforce/shadow-changes/:id/approve    approve a pending change
 *   POST /api/workforce/shadow-changes/:id/reject     reject a pending change
 *   POST /api/workforce/shadow-changes/:id/retry      re-apply an approved change whose apply threw
 *
 * Every route runs: authenticate, requireCompanyScope, then requireApprover (admin or manager at mount).
 * - Company comes only from res.locals.companyId, which requireCompanyScope sets from the verified token.
 *   Body, query, params and headers are never read for tenancy.
 * - The approver is built from the verified session: req.user.id and req.user.role. The role is never read
 *   from the body, query or params. The service's mayDecide rules decide whether that approver may act.
 *
 * Service results map to HTTP as follows: not_permitted 403, not_found 404, not_pending and conflict 409,
 * invalid 400. A missing dependency returns 503. An apply that throws returns 500 and leaves the change at
 * 'approved', where the retry route can pick it up.
 */
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import type { SqlExecutor } from './pg-store.ts';
import {
  APPROVER_ROLES,
  createShadowChanges,
  type Approver,
  type DecideResult,
  type ShadowChange,
} from './shadow-changes.ts';
import { createPgShadowApply, createPgShadowStore } from './shadow-store-pg.ts';

/** The subset of the shadow service these routes use. createShadowChanges() satisfies it. */
export interface ShadowDecider {
  decide(
    companyId: string,
    id: string,
    approver: Approver,
    decision: 'approve' | 'reject',
  ): Promise<DecideResult>;
  retry(companyId: string, id: string, approver: Approver): Promise<DecideResult>;
}

export interface ShadowRouteDeps {
  shadow: ShadowDecider;
  /** Lists pending changes for one company. Optional: when absent the list route returns 503. */
  listPending?: (companyId: string) => Promise<readonly ShadowChange[]> | readonly ShadowChange[];
}

/** Guards are passed in so the caller wires the real middleware. requireApprover is required: no route is open. */
export interface ShadowRouteGuards {
  authenticate: RequestHandler;
  requireCompanyScope: RequestHandler;
  requireApprover: RequestHandler;
}

export const SHADOW_PENDING_PATH = '/api/workforce/shadow-changes/pending';
export const SHADOW_APPROVE_PATH = '/api/workforce/shadow-changes/:id/approve';
export const SHADOW_REJECT_PATH = '/api/workforce/shadow-changes/:id/reject';
export const SHADOW_RETRY_PATH = '/api/workforce/shadow-changes/:id/retry';

/**
 * Target tables an approved change may write to in production. Empty on purpose: until Jason names the desk
 * tables (each with a numeric `version` column), every approval is refused with 400 and nothing is applied.
 */
export const SHADOW_APPLY_TABLES: readonly string[] = [];

type SessionRequest = Request & { user?: { id?: unknown; role?: unknown } };

function scopedCompanyId(res: Response): string | null {
  const value = res.locals.companyId;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function sessionRole(req: Request): string | null {
  const role = (req as SessionRequest).user?.role;
  return typeof role === 'string' && role !== '' ? role : null;
}

/** Builds the approver from the verified session only. Returns null when the session lacks an id or role. */
function sessionApprover(req: Request): Approver | null {
  const user = (req as SessionRequest).user;
  const id = typeof user?.id === 'string' ? user.id : null;
  const role = sessionRole(req);
  if (!id || id.trim() === '' || !role) return null;
  return { kind: 'human', id, role };
}

const STATUS_BY_REASON: Record<Exclude<DecideResult, { ok: true }>['reason'], number> = {
  not_permitted: 403,
  not_found: 404,
  not_pending: 409,
  conflict: 409,
  invalid: 400,
};

export function createShadowRouter(deps: ShadowRouteDeps, guards: ShadowRouteGuards): Router {
  const router = Router();
  const chain: RequestHandler[] = [guards.authenticate, guards.requireCompanyScope, guards.requireApprover];

  router.get(SHADOW_PENDING_PATH, ...chain, async (req: Request, res: Response, next: NextFunction) => {
    const companyId = scopedCompanyId(res);
    if (!companyId) {
      res.status(403).json({ error: 'Company scope required' });
      return;
    }
    const role = sessionRole(req);
    if (!role || !(APPROVER_ROLES as readonly string[]).includes(role)) {
      res.status(403).json({ error: 'not_permitted' });
      return;
    }
    if (!deps.listPending) {
      res.status(503).json({ error: 'dependency_not_configured', dependency: 'listPending' });
      return;
    }
    try {
      const changes = await deps.listPending(companyId);
      res.json({ changes: changes.filter((c) => c.companyId === companyId && c.status === 'pending') });
    } catch (err) {
      next(err);
    }
  });

  const decisionRoutes: ReadonlyArray<readonly [string, 'approve' | 'reject' | 'retry']> = [
    [SHADOW_APPROVE_PATH, 'approve'],
    [SHADOW_REJECT_PATH, 'reject'],
    [SHADOW_RETRY_PATH, 'retry'],
  ];
  for (const [path, action] of decisionRoutes) {
    router.post(path, ...chain, async (req: Request, res: Response, next: NextFunction) => {
      const companyId = scopedCompanyId(res);
      if (!companyId) {
        res.status(403).json({ error: 'Company scope required' });
        return;
      }
      const approver = sessionApprover(req);
      if (!approver) {
        res.status(403).json({ error: 'not_permitted' });
        return;
      }
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      try {
        const result =
          action === 'retry'
            ? await deps.shadow.retry(companyId, id, approver)
            : await deps.shadow.decide(companyId, id, approver, action);
        if (result.ok) {
          res.json({ status: result.status });
          return;
        }
        res.status(STATUS_BY_REASON[result.reason]).json({ error: result.reason });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

/** A pool that can also hand out one connection, which the apply transaction needs. */
export interface ShadowPool extends SqlExecutor {
  connect(): Promise<SqlExecutor & { release(): void }>;
}

/**
 * Production wiring: the Postgres store, and an apply that takes one pooled connection per approval so that
 * BEGIN, the locked version check, the write and COMMIT all run on the same connection.
 */
export function createShadowRouterForProduction(pool: ShadowPool, guards: ShadowRouteGuards): Router {
  const store = createPgShadowStore(pool);
  const shadow = createShadowChanges({
    store,
    now: () => Date.now(),
    readVersion: async (companyId, table, id) => {
      if (!SHADOW_APPLY_TABLES.includes(table)) return null;
      const result = await pool.query(
        `SELECT version FROM ${table} WHERE company_id = $1 AND id = $2`,
        [companyId, id],
      );
      return result.rows.length === 0 ? null : Number(result.rows[0].version);
    },
    canApply: (table) => SHADOW_APPLY_TABLES.includes(table),
    apply: async (change) => {
      const client = await pool.connect();
      try {
        return await createPgShadowApply(client, { targetTables: SHADOW_APPLY_TABLES })(change);
      } finally {
        client.release();
      }
    },
  });
  return createShadowRouter(
    { shadow, listPending: (companyId) => shadow.listPending(companyId) },
    guards,
  );
}
