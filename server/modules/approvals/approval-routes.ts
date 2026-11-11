import { Router, type RequestHandler, type Response } from 'express';
import { requireRole, type AuthRequest } from '../../middleware/auth';
import { ApprovalService, parseRuleInput, type ApprovalStatus } from './approval-service';
import { applyApprovalDecision, type AppliedDecision, type TransactionRunner } from './apply-atomic';
import { logAuditEvent } from '../../services/audit-log';
import { logger } from '../../utils/logger.ts';

export interface ApprovalRouteDecisionDeps {
  /**
   * Returns a transaction runner bound to one company. Injected by the composition root.
   * When absent, approve and reject are refused with 503 (fail closed).
   */
  transactionsFor?: (companyId: string) => TransactionRunner;
}

export interface ApprovalRouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
}

/** Mounted paths relative to the module base path. Kept next to the router so they stay in sync. */
export const APPROVAL_ROUTES: readonly ApprovalRouteDef[] = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/rules' },
  { method: 'POST', path: '/rules' },
  { method: 'PUT', path: '/rules/:ruleId' },
  { method: 'DELETE', path: '/rules/:ruleId' },
  { method: 'GET', path: '/:id' },
  { method: 'POST', path: '/:id/approve' },
  { method: 'POST', path: '/:id/reject' },
  { method: 'POST', path: '/:id/revoke' },
  { method: 'POST', path: '/:id/resubmit' },
  { method: 'POST', path: '/:id/executed' },
];

const STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'revoked'];
/** The only body field a resubmit may carry. Action, company and actor are not editable. */
const RESUBMIT_FIELDS: readonly string[] = ['params'];
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Company scope comes only from res.locals.companyId, which requireCompanyScope sets
 * from the verified session. Request bodies, queries and params are never read for tenancy.
 */
function scopedCompanyId(res: Response): string | null {
  const value: unknown = res.locals.companyId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseId(value: string | undefined): string | null {
  return value !== undefined && ID_PATTERN.test(value) ? value : null;
}

type ScopedHandler = (req: AuthRequest, res: Response, companyId: string) => Promise<void>;

/** Express 4 does not forward async rejections, so wrap handlers and pass errors to next(). */
function scoped(handler: ScopedHandler): RequestHandler {
  return (req, res, next) => {
    const companyId = scopedCompanyId(res);
    if (!companyId) {
      res.status(403).json({ error: 'Company scope not resolved' });
      return;
    }
    handler(req as AuthRequest, res, companyId).catch(next);
  };
}

/**
 * Post-commit side effect for a decision made through this route. Runs only after the
 * approval write and the message status write have committed, so it can never gate the action.
 * It writes the same approval.approved / approval.rejected audit event that
 * ApprovalService.decideApproval writes, using the same metadata shape.
 *
 * It also resolves any in-process waiter on the approval right away, through
 * ApprovalService.notifyDecision. That call and the audit write are independent: a notify failure
 * is logged and does not stop the audit write, and an audit failure does not undo the notify.
 *
 * Audit errors propagate. The decision is already committed, so the audit failure is surfaced rather than hidden.
 */
function publishDecision(
  service: ApprovalService,
  context: { decidedBy: string; approvalAction: string }
): (applied: AppliedDecision) => Promise<void> {
  return async (applied) => {
    try {
      service.notifyDecision(applied.companyId, applied.approvalId, applied.decision);
    } catch (error: unknown) {
      logger.error('[Approvals] Failed to notify waiters of decision', { approvalId: applied.approvalId, error });
    }
    await logAuditEvent({
      action: applied.decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      userId: context.decidedBy.startsWith('dashboard:') ? context.decidedBy.slice('dashboard:'.length) : undefined,
      resourceType: 'approval',
      resourceId: applied.approvalId,
      metadata: { companyId: applied.companyId, action: context.approvalAction, decidedBy: context.decidedBy },
    });
  };
}

/** The message a send approval gates, taken from the approval params. Null if absent or malformed. */
function linkedMessageId(params: Record<string, unknown>): string | null {
  const value = params.messageId;
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

export function createApprovalRouter(service: ApprovalService, decisionDeps: ApprovalRouteDecisionDeps = {}): Router {
  const router = Router();
  const approverRoles = requireRole('admin', 'manager');
  const adminOnly = requireRole('admin');
  const executorRoles = requireRole('admin', 'agent');

  router.get('/', approverRoles, scoped(async (req, res, companyId) => {
    const rawStatus = firstString(req.query.status);
    if (rawStatus !== undefined && !(STATUSES as readonly string[]).includes(rawStatus)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const limit = Number.parseInt(firstString(req.query.limit) ?? '50', 10);
    const approvals = await service.listApprovals(companyId, {
      status: rawStatus as ApprovalStatus | undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    res.json({ approvals });
  }));

  router.get('/rules', adminOnly, scoped(async (_req, res, companyId) => {
    res.json({ rules: await service.listRules(companyId) });
  }));

  router.post('/rules', adminOnly, scoped(async (req, res, companyId) => {
    const parsed = parseRuleInput(req.body);
    if (parsed.ok === false) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const rule = await service.createRule(companyId, parsed.value);
      res.status(201).json({ rule });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'A rule with this name already exists' });
        return;
      }
      throw error;
    }
  }));

  router.put('/rules/:ruleId', adminOnly, scoped(async (req, res, companyId) => {
    const ruleId = parseId(req.params.ruleId);
    if (!ruleId) {
      res.status(400).json({ error: 'Invalid rule id' });
      return;
    }
    const parsed = parseRuleInput(req.body);
    if (parsed.ok === false) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const rule = await service.updateRule(companyId, ruleId, parsed.value);
    if (!rule) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.json({ rule });
  }));

  router.delete('/rules/:ruleId', adminOnly, scoped(async (req, res, companyId) => {
    const ruleId = parseId(req.params.ruleId);
    if (!ruleId) {
      res.status(400).json({ error: 'Invalid rule id' });
      return;
    }
    const deleted = await service.deleteRule(companyId, ruleId);
    if (!deleted) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.status(204).end();
  }));

  router.get('/:id', approverRoles, scoped(async (req, res, companyId) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid approval id' });
      return;
    }
    const approval = await service.getApproval(companyId, id);
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }
    res.json({ approval });
  }));

  for (const decision of ['approve', 'reject'] as const) {
    router.post(`/:id/${decision}`, approverRoles, scoped(async (req, res, companyId) => {
      const transactionsFor = decisionDeps.transactionsFor;
      if (!transactionsFor) {
        res.status(503).json({ error: 'Approval decisions are unavailable' });
        return;
      }
      const id = parseId(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid approval id' });
        return;
      }
      if (!req.userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const reason = req.body?.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
        res.status(400).json({ error: 'reason must be a string up to 500 chars' });
        return;
      }
      const existing = await service.getApproval(companyId, id);
      if (!existing) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }
      const messageId = linkedMessageId(existing.params);
      if (!messageId) {
        res.status(409).json({ error: 'Approval is not linked to a message' });
        return;
      }
      const decidedBy = `dashboard:${req.userId}`;
      const result = await applyApprovalDecision(
        { transactions: transactionsFor(companyId), afterCommit: publishDecision(service, { decidedBy, approvalAction: existing.action }) },
        {
          companyId,
          approvalId: id,
          messageId,
          decision: decision === 'approve' ? 'approved' : 'rejected',
          decidedBy,
          reason,
        }
      );
      if (result.kind === 'applied') {
        res.json({ approval: await service.getApproval(companyId, id) });
        return;
      }
      if (result.kind === 'message_not_awaiting') {
        res.status(409).json({ error: 'Message is no longer awaiting approval' });
        return;
      }
      const current = await service.getApproval(companyId, id);
      if (!current) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }
      res.status(409).json({ error: 'Approval is no longer pending', status: current.status });
    }));
  }

  router.post('/:id/revoke', approverRoles, scoped(async (req, res, companyId) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid approval id' });
      return;
    }
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const reason = req.body?.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
      res.status(400).json({ error: 'reason must be a string up to 500 chars' });
      return;
    }
    const result = await service.revokeApproval(companyId, id, `dashboard:${req.userId}`, reason);
    if (result.kind === 'ok') {
      res.json({ approval: result.approval });
      return;
    }
    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }
    res.status(409).json({ error: result.error, status: result.status, executed: result.executed });
  }));

  router.post('/:id/resubmit', approverRoles, scoped(async (req, res, companyId) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid approval id' });
      return;
    }
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Body must be an object with params' });
      return;
    }
    // Any other field (action, companyId, requestedBy, agentId, status...) is refused, not ignored.
    const extra = Object.keys(body).filter((key) => !RESUBMIT_FIELDS.includes(key));
    if (extra.length > 0) {
      res.status(400).json({ error: `Only params can be edited; not allowed: ${extra.join(', ')}` });
      return;
    }
    const params = (body as { params?: unknown }).params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      res.status(400).json({ error: 'params must be an object' });
      return;
    }
    const result = await service.resubmitApproval(companyId, id, params as Record<string, unknown>, req.userId);
    if (result.kind === 'ok') {
      res.status(201).json({ approval: result.approval });
      return;
    }
    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }
    res.status(409).json({ error: result.error, status: result.status, executed: result.executed });
  }));

  router.post('/:id/executed', executorRoles, scoped(async (req, res, companyId) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid approval id' });
      return;
    }
    const approval = await service.markExecuted(companyId, id, req.userId ?? null);
    if (approval) {
      res.json({ approval });
      return;
    }
    const current = await service.getApproval(companyId, id);
    if (!current) {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }
    res.status(409).json({ error: 'Approval is not approved or was already executed', status: current.status });
  }));

  return router;
}
