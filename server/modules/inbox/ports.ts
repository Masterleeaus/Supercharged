/*
 * Ports for the inbox. The service depends on these interfaces only. Every method
 * takes companyId and must scope reads and writes to it. Desk supplies the Drizzle
 * store later (see PORT-NOTES.md). Tests use the in-memory adapters.
 */
import type { Channel, Message, MessageStatus, Participant, Thread, ThreadParticipant, ThreadStatus, Assignee } from './types.ts';

export type ThreadPatch = Partial<{ status: ThreadStatus; assignee: Assignee | null; lastMessageAt: Date; updatedAt: Date }>;
export type MessagePatch = Partial<{ status: MessageStatus; approvalId: string | null; updatedAt: Date; queuedAt: Date }>;

export interface ThreadFilter {
  status?: ThreadStatus;
  assigneeId?: string;
}

export interface InboxStore {
  /**
   * Runs fn while holding a store-level lock for one contact's inbound key, so the lock holds
   * across server instances. The Drizzle store uses a transaction-scoped advisory lock. The
   * in-memory store just runs fn. fn is awaited before the lock is released.
   */
  lockInboundKey<T>(companyId: string, channel: Channel, address: string, fn: () => Promise<T>): Promise<T>;

  insertParticipant(participant: Participant): Promise<void>;
  findContactParticipant(companyId: string, channel: Channel, address: string): Promise<Participant | null>;

  insertThread(thread: Thread): Promise<void>;
  findThread(companyId: string, id: string): Promise<Thread | null>;
  /** Most recent thread for this contact on this channel that is not closed. */
  findOpenThreadForParticipant(companyId: string, channel: Channel, participantId: string): Promise<Thread | null>;
  updateThread(companyId: string, id: string, patch: ThreadPatch): Promise<Thread | null>;
  listThreads(companyId: string, filter: ThreadFilter): Promise<Thread[]>;

  linkParticipant(link: ThreadParticipant): Promise<void>;
  listThreadParticipants(companyId: string, threadId: string): Promise<ThreadParticipant[]>;

  insertMessage(message: Message): Promise<void>;
  findMessage(companyId: string, id: string): Promise<Message | null>;
  findMessageByExternalId(companyId: string, channel: Channel, externalId: string): Promise<Message | null>;
  updateMessage(companyId: string, id: string, patch: MessagePatch): Promise<Message | null>;
  listMessages(companyId: string, threadId: string): Promise<Message[]>;
}

/*
 * Structural subset of the approvals module (server/modules/approvals/approval-service.ts).
 * ApprovalService satisfies this shape. The module imports no approvals runtime code,
 * so the Express-side index is never loaded by inbox.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalGateRequest {
  companyId: string;
  requestedBy: string | null;
  agentId: string | null;
  action: string;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  ttlMs: number;
}

export interface ApprovalGateResult {
  status: ApprovalState;
  approval: { id: string };
  decision: string;
  policyId: string | null;
}

export interface ApprovalRecord {
  id: string;
  action: string;
  params: Record<string, unknown>;
  status: ApprovalState;
}

export interface ApprovalPort {
  gateAction(request: ApprovalGateRequest): Promise<ApprovalGateResult>;
  getApproval(companyId: string, id: string): Promise<ApprovalRecord | null>;
  /** Returns null when the approval is missing or already executed. */
  markExecuted(companyId: string, id: string, actorId: string | null, tx?: { claimExecuted(companyId: string, id: string, executedAt: Date): Promise<unknown> }): Promise<ApprovalRecord | null>;
  /**
   * Writes the execution audit event for a claim made on a transaction. The inbox calls it only
   * after that transaction commits, so a rolled-back send never leaves an audit row behind.
   */
  recordExecuted?(companyId: string, approval: ApprovalRecord, actorId: string | null): Promise<void>;
}

/*
 * Transaction handle for the approval send path. Every write runs on the same transaction,
 * so the approval claim and the thread and message updates commit together or not at all.
 * Each method is scoped by companyId, and a method returns false or null when nothing applied.
 */
export interface InboxWriteTx {
  /** False when the approval is missing, not approved, or already executed in this company. */
  markApprovalExecuted(companyId: string, approvalId: string): Promise<boolean>;
  updateThread(companyId: string, id: string, patch: ThreadPatch): Promise<Thread | null>;
  updateMessage(companyId: string, id: string, patch: MessagePatch): Promise<Message | null>;
}

/**
 * Transaction-shaped port, following TransactionRunner in approvals/apply-atomic.ts: runs the
 * callback in one transaction, commits on success, rolls back on throw, and rethrows the
 * callback's error unchanged.
 */
export interface InboxTransactionRunner {
  runInTransaction<T>(callback: (tx: InboxWriteTx) => Promise<T>): Promise<T>;
}
