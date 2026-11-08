/*
 * Atomic application of an approval decision and the matching message status update.
 *
 * Both writes go through one transaction handle obtained from runInTransaction. If either
 * write does not apply, or the callback throws, the transaction is rolled back and neither
 * write is kept. Nothing here writes SQL: the transaction runner and its write methods are
 * injected, so the repository layer owns the conditional UPDATEs.
 *
 * Contract for the injected implementation:
 *   - writeApprovalDecision moves a row from 'pending' to decided only when it is still
 *     pending and unexpired at decidedAt, and in the given company. Returns false otherwise.
 *   - writeMessageStatus moves a row only when it is in the given company, belongs to the
 *     given approval, and currently has expectedStatus. Returns false otherwise.
 *   - runInTransaction must rethrow errors from the callback unchanged after rolling back.
 *   - afterCommit side effects (waiter notification, audit log) run only after commit.
 */

export type ApprovalDecision = 'approved' | 'rejected';

/** Message status an approval decision moves a waiting message to. */
export type MessageNextStatus = 'queued' | 'skipped';

/** Only messages waiting on an approval can be moved by a decision. */
export const AWAITING_APPROVAL = 'awaiting_approval' as const;

export interface ApprovalDecisionWrite {
  companyId: string;
  approvalId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  reason: string | null;
  decidedAt: Date;
}

export interface MessageStatusWrite {
  companyId: string;
  messageId: string;
  approvalId: string;
  expectedStatus: typeof AWAITING_APPROVAL;
  nextStatus: MessageNextStatus;
  skipReason: 'approval_rejected' | null;
  updatedAt: Date;
}

/** Transaction handle. Every write is scoped by companyId, which the caller supplies. */
export interface ApprovalMessageTx {
  writeApprovalDecision(write: ApprovalDecisionWrite): Promise<boolean>;
  writeMessageStatus(write: MessageStatusWrite): Promise<boolean>;
}

/** Transaction-shaped port: runs callback in one transaction, commits on success, rolls back on throw. */
export interface TransactionRunner {
  runInTransaction<T>(callback: (tx: ApprovalMessageTx) => Promise<T>): Promise<T>;
}

export interface AppliedDecision {
  kind: 'applied';
  companyId: string;
  approvalId: string;
  messageId: string;
  decision: ApprovalDecision;
  messageStatus: MessageNextStatus;
  decidedAt: Date;
}

export type ApplyDecisionResult =
  | AppliedDecision
  | { kind: 'approval_not_pending' }
  | { kind: 'message_not_awaiting' };

export interface ApplyDecisionDeps {
  transactions: TransactionRunner;
  now?: () => Date;
  /** Runs only after the transaction has committed, e.g. waiter notification and audit logging. */
  afterCommit?: (applied: AppliedDecision) => Promise<void>;
}

export interface ApplyDecisionInput {
  /** Verified company id from the session. Never from a request body. */
  companyId: string;
  approvalId: string;
  messageId: string;
  decision: ApprovalDecision;
  /** Namespaced actor, e.g. `dashboard:<userId>`. */
  decidedBy: string;
  reason?: string | null;
}

const MAX_REASON_LENGTH = 500;

/** Thrown inside the callback to roll back the approval write when the message write does not apply. */
class NotApplied extends Error {
  constructor(readonly outcome: 'approval_not_pending' | 'message_not_awaiting') {
    super(outcome);
    this.name = 'NotApplied';
  }
}

/** Pure mapping from a decision to the message update it requires. */
export function messageUpdateFor(decision: ApprovalDecision): { nextStatus: MessageNextStatus; skipReason: 'approval_rejected' | null } {
  return decision === 'approved'
    ? { nextStatus: 'queued', skipReason: null }
    : { nextStatus: 'skipped', skipReason: 'approval_rejected' };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

/**
 * Applies an approval decision and its message status update in one transaction.
 * Returns applied, or the outcome that stopped it. In the non-applied cases the approval
 * write is rolled back, so the approval stays pending.
 */
export async function applyApprovalDecision(
  deps: ApplyDecisionDeps,
  input: ApplyDecisionInput
): Promise<ApplyDecisionResult> {
  // Fail closed before any transaction is opened.
  const companyId = requireText(input.companyId, 'companyId');
  const approvalId = requireText(input.approvalId, 'approvalId');
  const messageId = requireText(input.messageId, 'messageId');
  const decidedBy = requireText(input.decidedBy, 'decidedBy');
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    throw new TypeError('decision must be approved or rejected');
  }
  const reason = input.reason ?? null;
  if (reason !== null && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
    throw new TypeError(`reason must be a string up to ${MAX_REASON_LENGTH} chars`);
  }

  const decidedAt = deps.now ? deps.now() : new Date();
  const { nextStatus, skipReason } = messageUpdateFor(input.decision);

  try {
    await deps.transactions.runInTransaction(async (tx) => {
      const decided = await tx.writeApprovalDecision({
        companyId,
        approvalId,
        decision: input.decision,
        decidedBy,
        reason,
        decidedAt,
      });
      if (!decided) throw new NotApplied('approval_not_pending');

      const moved = await tx.writeMessageStatus({
        companyId,
        messageId,
        approvalId,
        expectedStatus: AWAITING_APPROVAL,
        nextStatus,
        skipReason,
        updatedAt: decidedAt,
      });
      // Throwing here rolls back the approval write above.
      if (!moved) throw new NotApplied('message_not_awaiting');
    });
  } catch (err) {
    if (err instanceof NotApplied) return { kind: err.outcome };
    throw err;
  }

  const applied: AppliedDecision = {
    kind: 'applied',
    companyId,
    approvalId,
    messageId,
    decision: input.decision,
    messageStatus: nextStatus,
    decidedAt,
  };
  if (deps.afterCommit) await deps.afterCommit(applied);
  return applied;
}
