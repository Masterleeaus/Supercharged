/**
 * Admin routes for company controls (roles, tiers, action limits, budgets, approval rules) and the usage view.
 *
 *   GET /api/workforce/company-controls   read the company's controls (defaults when none are saved)
 *   PUT /api/workforce/company-controls   replace the company's controls (human only, audited, versioned)
 *   GET /api/workforce/usage              spend and tool-call counts for the company, with budgets
 *
 * Every route runs the same chain, in this order: authenticate, admin role, company scope, then the rate limiter.
 * Company scope comes only from the verified token (through getCompanyScope, copied to res.locals.companyId).
 * Request bodies, queries, params and headers are never read for tenancy.
 *
 * Writes are human-only: the actor is the session user (req.userId). Each accepted change is written to the
 * audit sink BEFORE it is stored, so a change is never stored without an audit record. If the audit sink fails,
 * nothing is stored. A write carries expectedVersion; a stale version gets 409 and nothing is stored.
 *
 * Fail closed: a missing dependency returns 503 (dependency_not_configured), an invalid role catalogue returns
 * 503, and a document that fails parseCompanyControls is refused with 400 and stores nothing.
 * Errors to clients are generic. Refusal reasons name fields and fixed phrases only, never submitted values.
 */
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import { getCompanyScope } from '../../middleware/company-scope.ts';
import { apiRateLimiter } from '../../middleware/rateLimiter.ts';
import {
  BUDGET_KEYS,
  CONTROL_TIERS,
  defaultControlsDocument,
  describeControlChanges,
  parseCompanyControls,
  type CompanyBudgets,
  type CompanyControls,
  type ControlTier,
  type ControlsDocument,
} from '../../modules/approvals/company-policy.ts';
import type { BudgetLedger } from './budgets.ts';

export const COMPANY_CONTROLS_PATH = '/api/workforce/company-controls';
export const WORKFORCE_USAGE_PATH = '/api/workforce/usage';

/** A role as the catalogue describes it. `autonomy` is the role's tier cap. */
export interface RoleSummary {
  id: string;
  name: string;
  autonomy: string;
}

export interface StoredControls {
  version: number;
  controls: CompanyControls;
}

export type WriteOutcome = { ok: true; version: number } | { ok: false; reason: 'version_conflict' };

/** Persistence for one company's controls. Every method takes the company from the caller (the session). */
export interface CompanyControlsStore {
  read(companyId: string): Promise<StoredControls | null>;
  write(companyId: string, controls: CompanyControls, expectedVersion: number): Promise<WriteOutcome>;
}

export interface UsageSnapshot {
  /** UTC calendar day the "today" figures refer to. */
  day: string;
  runsStarted: number;
  spendCentsToday: number;
  /** Every run the ledger holds for the company, all days. */
  totals: { runs: number; toolCalls: number; tokens: number; spendCents: number };
}

export interface UsageSource {
  read(companyId: string, now: number): Promise<UsageSnapshot> | UsageSnapshot;
}

/** Shape of an audit entry. It matches AuditLogEntry in services/audit-log.ts, so the composition root can pass logAuditEvent. */
export interface ControlsAuditEntry {
  action: 'admin.settings_update';
  userId: string;
  resourceType: 'company_controls';
  resourceId: string;
  metadata: { companyId: string; fromVersion: number; toVersion: number; changes: string[] };
}

export interface ControlsAuditSink {
  record(entry: ControlsAuditEntry): Promise<void> | void;
}

export interface CompanyControlsDeps {
  /** The role catalogue. Missing means the route returns 503. */
  roles?: () => Promise<readonly RoleSummary[]> | readonly RoleSummary[];
  store?: CompanyControlsStore;
  usage?: UsageSource;
  audit?: ControlsAuditSink;
  now?: () => number;
}

/** Guards are passed in so the real auth middleware is wired by the caller and tests can use stubs. */
export interface CompanyControlsGuards {
  authenticate: RequestHandler;
  requireAdmin: RequestHandler;
  requireCompanyScope: RequestHandler;
}

export class RoleCatalogueInvalidError extends Error {
  readonly code = 'role_catalogue_invalid';
  constructor() {
    super('role catalogue has a role with an unknown tier or a duplicate id');
    this.name = 'RoleCatalogueInvalidError';
  }
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

function scopedCompanyId(res: Response): string {
  return res.locals.companyId as string;
}

function sessionUserId(req: Request): string | null {
  const userId = (req as Request & { userId?: unknown }).userId;
  return typeof userId === 'string' && userId.trim() !== '' ? userId : null;
}

function unavailable(res: Response, name: string): void {
  res.status(503).json({ error: 'dependency_not_configured', dependency: name });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Role id to tier cap. Throws RoleCatalogueInvalidError when a role has no valid tier or an id repeats. */
function capsFrom(roles: readonly RoleSummary[]): Map<string, ControlTier> {
  const caps = new Map<string, ControlTier>();
  for (const role of roles) {
    if (caps.has(role.id)) throw new RoleCatalogueInvalidError();
    if (!(CONTROL_TIERS as readonly string[]).includes(role.autonomy)) throw new RoleCatalogueInvalidError();
    caps.set(role.id, role.autonomy as ControlTier);
  }
  return caps;
}

/** Loads the catalogue and its caps. Returns null when no catalogue is configured. Throws when it is invalid. */
async function loadRoles(deps: CompanyControlsDeps): Promise<{ list: RoleSummary[]; caps: Map<string, ControlTier> } | null> {
  if (!deps.roles) return null;
  const list = [...(await deps.roles())];
  return { list, caps: capsFrom(list) };
}

/**
 * Creates the in-memory store. For tests and local use only: the data is lost when the process exits.
 * Versions start at 0 (nothing stored) and go up by one on each accepted write.
 */
export function createMemoryControlsStore(): CompanyControlsStore {
  const docs = new Map<string, StoredControls>();
  return {
    async read(companyId) {
      const found = docs.get(companyId);
      return found ? structuredClone(found) : null;
    },
    async write(companyId, controls, expectedVersion) {
      const current = docs.get(companyId)?.version ?? 0;
      if (current !== expectedVersion) return { ok: false, reason: 'version_conflict' };
      const version = current + 1;
      docs.set(companyId, { version, controls: structuredClone(controls) });
      return { ok: true, version };
    },
  };
}

/**
 * Usage from the in-memory budget ledger (budgets.ts). Only rows for this company are read, so one company's
 * figures never include another's. The ledger is not modified.
 */
export function createLedgerUsageSource(ledger: BudgetLedger): UsageSource {
  return {
    read(companyId, now) {
      const day = new Date(now).toISOString().slice(0, 10);
      const prefix = `${companyId}\u0000`;
      const totals = { runs: 0, toolCalls: 0, tokens: 0, spendCents: 0 };
      for (const [key, usage] of ledger.runs) {
        if (!key.startsWith(prefix)) continue;
        totals.runs += 1;
        totals.toolCalls += usage.toolCalls;
        totals.tokens += usage.tokens;
        totals.spendCents += usage.spendCents;
      }
      const today = ledger.companies.get(companyId);
      const todayRecord = today && today.day === day ? today : null;
      return {
        day,
        runsStarted: todayRecord ? todayRecord.runIds.size : 0,
        spendCentsToday: todayRecord ? todayRecord.spendCents : 0,
        totals,
      };
    },
  };
}

export function createCompanyControlsRouter(deps: CompanyControlsDeps, guards: CompanyControlsGuards): Router {
  const router = Router();
  // apiRateLimiter runs after authentication and company scope, so its default key is the session user (req.userId).
  const chain: RequestHandler[] = [guards.authenticate, guards.requireAdmin, guards.requireCompanyScope, setScopedCompany, apiRateLimiter];
  const now = deps.now ?? (() => Date.now());

  router.get(COMPANY_CONTROLS_PATH, ...chain, async (_req: Request, res: Response, next: NextFunction) => {
    if (!deps.store) return unavailable(res, 'store');
    let roleSet: Awaited<ReturnType<typeof loadRoles>>;
    try {
      roleSet = await loadRoles(deps);
    } catch {
      return unavailable(res, 'roles');
    }
    if (!roleSet) return unavailable(res, 'roles');
    const companyId = scopedCompanyId(res);
    try {
      const stored = await deps.store.read(companyId);
      const document: ControlsDocument = stored ? stored.controls : defaultControlsDocument(roleSet.caps);
      res.json({
        configured: stored !== null,
        version: stored?.version ?? 0,
        roles: roleSet.list.map((role) => ({ id: role.id, name: role.name, cap: role.autonomy })),
        budgetKeys: BUDGET_KEYS,
        controls: document,
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(COMPANY_CONTROLS_PATH, ...chain, async (req: Request, res: Response, next: NextFunction) => {
    const userId = sessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!deps.store) return unavailable(res, 'store');
    if (!deps.audit) return unavailable(res, 'audit');
    let roleSet: Awaited<ReturnType<typeof loadRoles>>;
    try {
      roleSet = await loadRoles(deps);
    } catch {
      return unavailable(res, 'roles');
    }
    if (!roleSet) return unavailable(res, 'roles');

    const body: unknown = req.body;
    if (!isPlainObject(body)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const expectedVersion = body.expectedVersion;
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
      res.status(400).json({ error: 'invalid_request', reason: 'expectedVersion: must be a whole number of zero or more' });
      return;
    }
    const parsed = parseCompanyControls(body.controls, roleSet.caps);
    if (!parsed.ok) {
      res.status(400).json({ error: 'invalid_controls', reason: parsed.reason });
      return;
    }

    const companyId = scopedCompanyId(res);
    try {
      const stored = await deps.store.read(companyId);
      const currentVersion = stored?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        res.status(409).json({ error: 'version_conflict', version: currentVersion });
        return;
      }
      const before: ControlsDocument = stored ? stored.controls : defaultControlsDocument(roleSet.caps);
      const changes = describeControlChanges(before, parsed.controls);
      if (changes.length === 0) {
        res.json({ version: currentVersion, changed: false, changes, controls: parsed.controls });
        return;
      }

      // Audit first. If the audit sink fails, nothing is stored.
      try {
        await deps.audit.record({
          action: 'admin.settings_update',
          userId,
          resourceType: 'company_controls',
          resourceId: companyId,
          metadata: { companyId, fromVersion: currentVersion, toVersion: currentVersion + 1, changes },
        });
      } catch {
        res.status(503).json({ error: 'dependency_not_configured', dependency: 'audit' });
        return;
      }

      const outcome = await deps.store.write(companyId, parsed.controls, expectedVersion);
      if (!outcome.ok) {
        res.status(409).json({ error: 'version_conflict' });
        return;
      }
      res.json({ version: outcome.version, changed: true, changes, controls: parsed.controls });
    } catch (error) {
      next(error);
    }
  });

  router.get(WORKFORCE_USAGE_PATH, ...chain, async (_req: Request, res: Response, next: NextFunction) => {
    if (!deps.usage) return unavailable(res, 'usage');
    if (!deps.store) return unavailable(res, 'store');
    const companyId = scopedCompanyId(res);
    try {
      const [snapshot, stored] = await Promise.all([deps.usage.read(companyId, now()), deps.store.read(companyId)]);
      const budgets: CompanyBudgets | null = stored?.controls.budgets ?? null;
      res.json({
        day: snapshot.day,
        today: { runsStarted: snapshot.runsStarted, spendCents: snapshot.spendCentsToday },
        totals: snapshot.totals,
        budgets,
        remainingToday: budgets
          ? {
              runs: Math.max(0, budgets.maxRunsPerCompanyPerDay - snapshot.runsStarted),
              spendCents: Math.max(0, budgets.maxSpendCentsPerCompanyPerDay - snapshot.spendCentsToday),
            }
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
