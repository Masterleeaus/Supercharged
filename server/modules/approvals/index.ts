import type { Express, RequestHandler } from 'express';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { authenticateToken } from '../../middleware/auth';
import { requireCompanyScope } from '../../middleware/company-scope';
import { withTenant, type TenantPool, type TenantQueryClient } from '../../infrastructure/database/tenant-context';
import { ApprovalService, type ApprovalDb, type RedactFn, type TenantRunner } from './approval-service';
import { APPROVAL_ROUTES, createApprovalRouter } from './approval-routes';
import type { ApprovalMessageTx, MessageStatusWrite, TransactionRunner, ApprovalDecisionWrite } from './apply-atomic';

export { ApprovalService, parseRuleInput, defaultRedact } from './approval-service';
export type { ApprovalStatus, ApprovalView, GateActionInput, GateActionResult, RuleInput, RuleView, TenantRunner } from './approval-service';
export { createApprovalGate } from './approval-gate-adapter';
export type { ApprovalServiceLike } from './approval-gate-adapter';
export { evaluatePolicy } from './policy-engine';
export type { ApprovalRequest, Policy, PolicyRule, PolicyDecision, DecisionType, MatcherValue } from './types';

/**
 * Writes for one company's approval decision, run on a client that already has the tenant set.
 * The approval update is conditional on pending and unexpired. The message update is conditional
 * on the message belonging to this approval and still awaiting it. Both are scoped by company_id.
 *
 * inbox_messages has no 'skipped' status and no skip_reason column (migrations/DRAFT_inbox.sql),
 * so a rejected message is stored as 'rejected'. The skip reason is not persisted.
 */
export function sqlApprovalMessageTx(client: TenantQueryClient): ApprovalMessageTx {
  return {
    async writeApprovalDecision(write: ApprovalDecisionWrite): Promise<boolean> {
      const result = await client.query(
        `UPDATE approvals
            SET status = $3, decided_by = $4, decided_at = $5, decision_reason = $6, updated_at = $5
          WHERE company_id = $1 AND id = $2 AND status = 'pending' AND expires_at > $5
          RETURNING id`,
        [write.companyId, write.approvalId, write.decision, write.decidedBy, write.decidedAt, write.reason]
      );
      return result.rows.length === 1;
    },
    async writeMessageStatus(write: MessageStatusWrite): Promise<boolean> {
      const storedStatus = write.nextStatus === 'queued' ? 'queued' : 'rejected';
      const queuedAt = write.nextStatus === 'queued' ? write.updatedAt : null;
      const result = await client.query(
        `UPDATE inbox_messages
            SET status = $5, queued_at = COALESCE($6, queued_at), updated_at = $7
          WHERE company_id = $1 AND id = $2 AND approval_id = $3 AND status = $4
          RETURNING id`,
        [write.companyId, write.messageId, write.approvalId, write.expectedStatus, storedStatus, queuedAt, write.updatedAt]
      );
      return result.rows.length === 1;
    },
  };
}

/**
 * Returns a transaction runner for one company, backed by the app pool in server/db.ts.
 * Each runInTransaction opens one withTenant transaction (BEGIN, restricted role, company
 * setting, COMMIT or ROLLBACK), so the approval write and the message write commit together.
 */
export function poolTransactionsFor(companyId: string): TransactionRunner {
  return {
    async runInTransaction<T>(callback: (tx: ApprovalMessageTx) => Promise<T>): Promise<T> {
      const { pool } = await import('../../db');
      return withTenant(pool as unknown as TenantPool, companyId, (client) => callback(sqlApprovalMessageTx(client)));
    },
  };
}

export interface ApprovalModuleOptions {
  /**
   * Tenant runner. Defaults to a runner bound to the app pool in server/db.ts (loaded lazily,
   * so importing this module does not require DATABASE_URL). Not needed when `service` is given.
   */
  tenant?: TenantRunner;
  /**
   * Returns a transaction runner per company for approval decisions. Defaults to
   * poolTransactionsFor. Without it, decide routes return 503.
   */
  transactionsFor?: (companyId: string) => TransactionRunner;
  service?: ApprovalService;
  /** Defaults to authenticateToken from server/middleware/auth.ts. */
  authenticate?: RequestHandler;
  /** Defaults to /api/approvals. */
  basePath?: string;
  redact?: RedactFn;
}

export interface ApprovalModuleRegistration {
  registered: true;
  paths: string[];
}

/**
 * Runs each call inside withTenant on the app pool, with a drizzle handle bound to the
 * pinned transaction client. Every query therefore runs under the company's session setting.
 */
export const poolTenantRunner: TenantRunner = {
  async run<T>(companyId: string, fn: (db: ApprovalDb) => Promise<T>): Promise<T> {
    const { pool } = await import('../../db');
    return withTenant(pool as unknown as TenantPool, companyId, (client) =>
      fn(drizzle(client as unknown as PoolClient) as unknown as ApprovalDb)
    );
  },
};

/**
 * Mounts the approvals routes on the Express app. Every route runs authenticate, then
 * requireCompanyScope() (company from the verified token only), then its role check.
 * Returns the list of "METHOD path" entries that were mounted.
 */
export function registerApprovalModule(
  app: Pick<Express, 'use'>,
  options: ApprovalModuleOptions = {}
): ApprovalModuleRegistration {
  const basePath = options.basePath ?? '/api/approvals';
  const service = options.service ?? new ApprovalService({ tenant: options.tenant ?? poolTenantRunner, redact: options.redact });
  const authenticate = options.authenticate ?? (authenticateToken as unknown as RequestHandler);

  const transactionsFor = options.transactionsFor ?? poolTransactionsFor;

  app.use(basePath, authenticate, requireCompanyScope(), createApprovalRouter(service, { transactionsFor }));

  return {
    registered: true,
    paths: APPROVAL_ROUTES.map((route) => `${route.method} ${basePath}${route.path === '/' ? '' : route.path}`),
  };
}
