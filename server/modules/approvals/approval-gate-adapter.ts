/**
 * Binds the runtime's ApprovalGate (workforce/runtime/tool-registry.ts) to ApprovalService.
 *
 * Only type imports are used here, so this file loads without the database or audit log.
 * Tenancy: every call passes the company id from the caller. ApprovalService scopes each
 * query by company_id, so an approval belonging to another company reads as missing and
 * cannot be claimed.
 *
 * claimApproval relies on ApprovalService.markExecuted, which runs one conditional UPDATE
 * (status = 'approved' AND executed_at IS NULL). Only one caller can match that row, so a
 * second claim of the same approval returns null and the adapter returns false.
 */
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import type { ApprovalGate, ApprovalRecord, ApprovalRequest } from '../../workforce/runtime/tool-registry.ts';
import type { ApprovalService, ApprovalView } from './approval-service';

/** The subset of ApprovalService the gate needs. Lets tests supply an in-memory service. */
export type ApprovalServiceLike = Pick<ApprovalService, 'gateAction' | 'getApproval' | 'markExecuted'>;

function toRecord(companyId: CompanyId, view: ApprovalView): ApprovalRecord {
  return {
    id: view.id,
    companyId,
    action: view.action,
    status: view.status,
    decidedBy: view.decidedBy,
    paramsSha256: view.paramsSha256,
    executed: view.executedAt !== null,
  };
}

export function createApprovalGate(service: ApprovalServiceLike): ApprovalGate {
  return {
    async gateAction(request: ApprovalRequest) {
      const result = await service.gateAction({
        companyId: request.companyId,
        requestedBy: request.requestedBy,
        agentId: request.agentId,
        action: request.action,
        params: request.params,
        context: request.context,
        urgency: request.urgency,
        ttlMs: request.ttlMs,
      });
      return { status: result.status, approval: { id: result.approval.id } };
    },

    async readApproval(companyId: CompanyId, approvalId: string): Promise<ApprovalRecord | null> {
      const view = await service.getApproval(companyId, approvalId);
      return view ? toRecord(companyId, view) : null;
    },

    async claimApproval(companyId: CompanyId, approvalId: string, actorId: string | null): Promise<boolean> {
      const claimed = await service.markExecuted(companyId, approvalId, actorId);
      return claimed !== null;
    },
  };
}
