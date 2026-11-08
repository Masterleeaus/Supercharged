/*
 * In-memory adapters for tests and local runs. Every record carries companyId, and
 * every read filters on it first, so one company cannot see another's threads or
 * messages. Nothing here touches a database or a provider.
 */
import type { ApprovalGateRequest, ApprovalGateResult, ApprovalPort, ApprovalRecord, ApprovalState, InboxStore, InboxTransactionRunner, InboxWriteTx, MessagePatch, ThreadFilter, ThreadPatch } from './ports.ts';
import type { Channel, Message, Participant, Thread, ThreadParticipant } from './types.ts';

function requireCo(companyId: string): string {
  if (typeof companyId !== 'string' || companyId.trim() === '') throw new TypeError('inbox: companyId is required');
  return companyId;
}

export class InMemoryInboxStore implements InboxStore {
  private readonly participants: Participant[] = [];
  private readonly threads: Thread[] = [];
  private readonly links: ThreadParticipant[] = [];
  private readonly messages: Message[] = [];

  /** Copy of every row, for rolling back a failed in-memory transaction. */
  snapshot(): InMemoryStoreSnapshot {
    return {
      participants: this.participants.map((p) => ({ ...p })),
      threads: this.threads.map((t) => ({ ...t })),
      links: this.links.map((l) => ({ ...l })),
      messages: this.messages.map((m) => ({ ...m })),
    };
  }

  /** Puts every row back to a snapshot taken earlier. */
  restore(state: InMemoryStoreSnapshot): void {
    replaceRows(this.participants, state.participants);
    replaceRows(this.threads, state.threads);
    replaceRows(this.links, state.links);
    replaceRows(this.messages, state.messages);
  }

  /**
   * No store-level lock here. The service's process-local keyed lock already serializes
   * same-contact deliveries in this process, and a single in-memory store has no other instance.
   */
  async lockInboundKey<T>(companyId: string, _channel: Channel, _address: string, fn: () => Promise<T>): Promise<T> {
    requireCo(companyId);
    return fn();
  }

  async insertParticipant(participant: Participant): Promise<void> {
    requireCo(participant.companyId);
    // Mirror the DB partial unique index: one contact per (company, channel, address).
    if (participant.kind === 'contact') {
      const clash = this.participants.some(
        (p) =>
          p.companyId === participant.companyId &&
          p.kind === 'contact' &&
          p.channel === participant.channel &&
          p.address === participant.address,
      );
      if (clash) {
        const err = new Error('inbox_participants: unique conflict on contact address');
        err.name = 'UniqueConflictError';
        throw err;
      }
    }
    this.participants.push({ ...participant });
  }

  async findContactParticipant(companyId: string, channel: Channel, address: string): Promise<Participant | null> {
    const found = this.participants.find(
      (p) => p.companyId === requireCo(companyId) && p.kind === 'contact' && p.channel === channel && p.address === address,
    );
    return found ? { ...found } : null;
  }

  async insertThread(thread: Thread): Promise<void> {
    requireCo(thread.companyId);
    this.threads.push({ ...thread });
  }

  async findThread(companyId: string, id: string): Promise<Thread | null> {
    const found = this.threads.find((t) => t.companyId === requireCo(companyId) && t.id === id);
    return found ? { ...found } : null;
  }

  async findOpenThreadForParticipant(companyId: string, channel: Channel, participantId: string): Promise<Thread | null> {
    const co = requireCo(companyId);
    const linkedIds = new Set(
      this.links.filter((l) => l.companyId === co && l.participantId === participantId).map((l) => l.threadId),
    );
    const candidates = this.threads
      .filter((t) => t.companyId === co && t.channel === channel && t.status !== 'closed' && linkedIds.has(t.id))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return candidates[0] ? { ...candidates[0] } : null;
  }

  async updateThread(companyId: string, id: string, patch: ThreadPatch): Promise<Thread | null> {
    const row = this.threads.find((t) => t.companyId === requireCo(companyId) && t.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return { ...row };
  }

  async listThreads(companyId: string, filter: ThreadFilter): Promise<Thread[]> {
    return this.threads
      .filter((t) => t.companyId === requireCo(companyId))
      .filter((t) => (filter.status ? t.status === filter.status : true))
      .filter((t) => (filter.assigneeId ? t.assignee?.id === filter.assigneeId : true))
      .map((t) => ({ ...t }));
  }

  async linkParticipant(link: ThreadParticipant): Promise<void> {
    requireCo(link.companyId);
    this.links.push({ ...link });
  }

  async listThreadParticipants(companyId: string, threadId: string): Promise<ThreadParticipant[]> {
    return this.links.filter((l) => l.companyId === requireCo(companyId) && l.threadId === threadId).map((l) => ({ ...l }));
  }

  async insertMessage(message: Message): Promise<void> {
    requireCo(message.companyId);
    // Mirror the DB unique key: one inbound row per (company, channel, externalId).
    if (message.direction === 'inbound' && message.externalId !== null) {
      const clash = this.messages.some(
        (m) => m.companyId === message.companyId && m.channel === message.channel && m.externalId === message.externalId,
      );
      if (clash) {
        const err = new Error('inbox_messages: unique conflict on external id');
        err.name = 'UniqueConflictError';
        throw err;
      }
    }
    this.messages.push({ ...message });
  }

  async findMessage(companyId: string, id: string): Promise<Message | null> {
    const found = this.messages.find((m) => m.companyId === requireCo(companyId) && m.id === id);
    return found ? { ...found } : null;
  }

  async findMessageByExternalId(companyId: string, channel: Channel, externalId: string): Promise<Message | null> {
    const found = this.messages.find(
      (m) => m.companyId === requireCo(companyId) && m.channel === channel && m.externalId === externalId,
    );
    return found ? { ...found } : null;
  }

  async updateMessage(companyId: string, id: string, patch: MessagePatch): Promise<Message | null> {
    const row = this.messages.find((m) => m.companyId === requireCo(companyId) && m.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return { ...row };
  }

  async listMessages(companyId: string, threadId: string): Promise<Message[]> {
    return this.messages
      .filter((m) => m.companyId === requireCo(companyId) && m.threadId === threadId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => ({ ...m }));
  }
}

/**
 * Fake approvals port. New requests start in `nextState` (pending by default), so a test
 * can make the gate approve or reject immediately, then decide a pending one with decide().
 */
export class InMemoryApprovalPort implements ApprovalPort {
  readonly requests: ApprovalGateRequest[] = [];
  nextState: ApprovalState = 'pending';
  private readonly rows = new Map<string, ApprovalRecord & { companyId: string; executed: boolean }>();
  private seq = 0;

  async gateAction(request: ApprovalGateRequest): Promise<ApprovalGateResult> {
    this.requests.push(request);
    this.seq += 1;
    const id = `appr_${this.seq}`;
    const status = this.nextState;
    this.rows.set(id, {
      id,
      companyId: request.companyId,
      action: request.action,
      params: request.params,
      status,
      executed: false,
    });
    return {
      status,
      approval: { id },
      decision: status === 'approved' ? 'auto_approve' : status === 'rejected' ? 'auto_deny' : 'route_to_human',
      policyId: null,
    };
  }

  async getApproval(companyId: string, id: string): Promise<ApprovalRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.companyId !== companyId) return null;
    return { id: row.id, action: row.action, params: row.params, status: row.status };
  }

  async markExecuted(
    companyId: string,
    id: string,
    _actorId: string | null,
    tx?: { claimExecuted(companyId: string, id: string, executedAt: Date): Promise<unknown> },
  ): Promise<ApprovalRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.companyId !== companyId || row.status !== 'approved' || row.executed) return null;
    // With a transaction handle, the claim runs on that handle, as the Drizzle port does.
    if (tx) {
      if (!(await tx.claimExecuted(companyId, id, new Date()))) return null;
    }
    row.executed = true;
    return { id: row.id, action: row.action, params: row.params, status: row.status };
  }

  /** Test helper: records the audit write that the inbox makes after a commit. */
  readonly executedAudit: Array<{ companyId: string; id: string; actorId: string | null }> = [];

  async recordExecuted(companyId: string, approval: ApprovalRecord, actorId: string | null): Promise<void> {
    this.executedAudit.push({ companyId, id: approval.id, actorId });
  }

  /** Test helper: a human decision on a pending approval. */
  decide(id: string, status: Extract<ApprovalState, 'approved' | 'rejected' | 'expired'>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no approval ${id}`);
    row.status = status;
  }

  isExecuted(id: string): boolean {
    return this.rows.get(id)?.executed ?? false;
  }

  /** Copy of every approval row, for rolling back a failed in-memory transaction. */
  snapshot(): Map<string, ApprovalRow> {
    return new Map([...this.rows].map(([id, row]) => [id, { ...row }]));
  }

  /** Puts every approval row back to a snapshot taken earlier. */
  restore(state: Map<string, ApprovalRow>): void {
    this.rows.clear();
    for (const [id, row] of state) this.rows.set(id, { ...row });
  }
}

type ApprovalRow = ApprovalRecord & { companyId: string; executed: boolean };

export interface InMemoryStoreSnapshot {
  participants: Participant[];
  threads: Thread[];
  links: ThreadParticipant[];
  messages: Message[];
}

function replaceRows<T>(target: T[], rows: T[]): void {
  target.splice(0, target.length, ...rows.map((r) => ({ ...r })));
}

/**
 * Transaction runner for the in-memory adapters. Takes a snapshot of both the store and the
 * approvals port, runs the callback against them, and restores both if the callback throws.
 * The error is rethrown unchanged, as the InboxTransactionRunner contract requires.
 * It is single-process only; it does not isolate concurrent callers.
 */
export function createInMemoryTransactionRunner(store: InMemoryInboxStore, approvals: InMemoryApprovalPort): InboxTransactionRunner {
  return {
    async runInTransaction(callback) {
      const storeState = store.snapshot();
      const approvalState = approvals.snapshot();
      const tx: InboxWriteTx = {
        async markApprovalExecuted(companyId, approvalId) {
          return (await approvals.markExecuted(companyId, approvalId, null)) !== null;
        },
        updateThread: (companyId, id, patch) => store.updateThread(companyId, id, patch),
        updateMessage: (companyId, id, patch) => store.updateMessage(companyId, id, patch),
      };
      try {
        return await callback(tx);
      } catch (err) {
        store.restore(storeState);
        approvals.restore(approvalState);
        throw err;
      }
    },
  };
}
