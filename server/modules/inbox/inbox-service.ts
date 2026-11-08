/*
 * Inbox service. Pure logic: persistence and approvals come in through ports, and
 * nothing here opens a socket or calls a provider. "Queued" means handed to a
 * transport layer that this module does not contain.
 *
 * Rules:
 *   - Inbound messages are deduplicated per (company, channel, externalId). The DB unique key
 *     (DRAFT_inbox.sql) is the final guard; a unique conflict on insert returns the existing row.
 *   - An agent may draft only on a thread assigned to it, and may send only its own
 *     drafts, and only after the approvals gate has approved the exact body.
 *   - A human may send directly (sendAsStaff). That is the only unapproved path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { requireCompanyId } from '../chatbot/chatbot-scope.ts';
import { isUniqueConflict } from '../comms/inbound-dedupe.ts';
import type { ApprovalPort, InboxStore, InboxTransactionRunner, ThreadFilter } from './ports.ts';
import {
  CHANNELS,
  MAX_BODY_LENGTH,
  MAX_ID_LENGTH,
  SEND_ACTION,
  THREAD_STATUSES,
  type Actor,
  type Assignee,
  type Channel,
  type Message,
  type Participant,
  type Thread,
  type ThreadStatus,
} from './types.ts';

export type InboxErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict';

export class InboxError extends Error {
  readonly code: InboxErrorCode;

  constructor(message: string, code: InboxErrorCode) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface InboxServiceDeps {
  store: InboxStore;
  approvals: ApprovalPort;
  /**
   * Optional. When present, the approval claim and the thread and message updates for an
   * approved send run in one transaction, so a failed write rolls back the claim.
   * Without it, the writes run one after another (see applyApprovalDecision).
   */
  transactions?: InboxTransactionRunner;
  now?: () => Date;
  newId?: () => string;
  /** How long an agent's send request stays open for a decision. Default 15 minutes. */
  approvalTtlMs?: number;
}

export interface InboundInput {
  channel: Channel;
  address: string;
  displayName?: string | null;
  subject?: string | null;
  body: string;
  externalId: string;
}

export interface InboundResult {
  thread: Thread;
  message: Message;
  duplicate: boolean;
}

export interface InboxService {
  recordInbound(companyId: string, input: InboundInput): Promise<InboundResult>;
  getThread(companyId: string, threadId: string): Promise<Thread>;
  listThreads(companyId: string, filter?: ThreadFilter): Promise<Thread[]>;
  listMessages(companyId: string, threadId: string): Promise<Message[]>;
  assignThread(companyId: string, actor: Actor, threadId: string, assignee: Assignee | null): Promise<Thread>;
  setThreadStatus(companyId: string, actor: Actor, threadId: string, status: ThreadStatus): Promise<Thread>;
  /** Agents draft on threads assigned to them. Humans may draft on any thread. */
  createDraft(companyId: string, actor: Actor, threadId: string, body: string): Promise<Message>;
  /** Human only. The message is queued without the gate. */
  sendAsStaff(companyId: string, actor: Actor, threadId: string, body: string): Promise<Message>;
  /** Agent only. Sends its own draft through the approvals gate. */
  requestSend(companyId: string, actor: Actor, messageId: string): Promise<Message>;
  /** Reads the approval and moves the message to queued or rejected. Pending leaves it unchanged. */
  applyApprovalDecision(companyId: string, messageId: string): Promise<Message>;
}

const ADDRESS_RULES: Record<Channel, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  sms: /^\+[1-9]\d{6,14}$/,
  whatsapp: /^\+[1-9]\d{6,14}$/,
  phone: /^\+[1-9]\d{6,14}$/,
  web_chat: /^[A-Za-z0-9_-]{1,128}$/,
};

function assertChannel(value: unknown): Channel {
  if (typeof value !== 'string' || !(CHANNELS as readonly string[]).includes(value)) {
    throw new InboxError(`channel must be one of ${CHANNELS.join(', ')}`, 'invalid');
  }
  return value as Channel;
}

function assertAddress(channel: Channel, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 320 || !ADDRESS_RULES[channel].test(value)) {
    throw new InboxError(`address is not valid for channel ${channel}`, 'invalid');
  }
  return value;
}

function assertBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_BODY_LENGTH) {
    throw new InboxError(`body must be a non-empty string up to ${MAX_BODY_LENGTH} chars`, 'invalid');
  }
  return value;
}

function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new InboxError(`${field} must be a non-empty string up to ${MAX_ID_LENGTH} chars`, 'invalid');
  }
  return value;
}

function assertAssignee(value: unknown): Assignee | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null) throw new InboxError('assignee must be null or {kind, id}', 'invalid');
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'human' && kind !== 'agent') throw new InboxError("assignee.kind must be 'human' or 'agent'", 'invalid');
  return { kind, id: assertId((value as { id?: unknown }).id, 'assignee.id') };
}

function assertStatus(value: unknown): ThreadStatus {
  if (typeof value !== 'string' || !(THREAD_STATUSES as readonly string[]).includes(value)) {
    throw new InboxError(`status must be one of ${THREAD_STATUSES.join(', ')}`, 'invalid');
  }
  return value as ThreadStatus;
}

/** An agent works a thread only when assigned to it. A human works any thread. */
function canWork(thread: Thread, actor: Actor): boolean {
  if (actor.kind === 'human') return true;
  return thread.assignee?.kind === 'agent' && thread.assignee.id === actor.id;
}

/** Runs fn after earlier callers holding the same key finish. Process-local only; the store lock covers other instances. */
function createKeyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export function createInboxService(deps: InboxServiceDeps): InboxService {
  const { store, approvals } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const ttlMs = deps.approvalTtlMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('inbox: approvalTtlMs must be positive');

  async function loadThread(companyId: string, threadId: string): Promise<Thread> {
    const thread = await store.findThread(companyId, threadId);
    if (!thread) throw new InboxError('Thread not found', 'not_found');
    return thread;
  }

  async function loadMessage(companyId: string, messageId: string): Promise<Message> {
    const message = await store.findMessage(companyId, messageId);
    if (!message) throw new InboxError('Message not found', 'not_found');
    return message;
  }

  function newMessage(
    companyId: string,
    thread: Thread,
    fields: Pick<Message, 'direction' | 'status' | 'authorKind' | 'authorId' | 'body' | 'externalId'>,
    at: Date,
  ): Message {
    return {
      companyId,
      id: newId(),
      threadId: thread.id,
      channel: thread.channel,
      approvalId: null,
      queuedAt: null,
      bodySha256: sha256(fields.body),
      createdAt: at,
      updatedAt: at,
      ...fields,
    };
  }

  const withInboundKey = createKeyedLock();

  const service: InboxService = {
    async recordInbound(rawCompanyId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const channel = assertChannel(input.channel);
      const address = assertAddress(channel, input.address);
      const body = assertBody(input.body);
      const externalId = assertId(input.externalId, 'externalId');
      // One critical section per contact on this channel. Same-contact deliveries serialize,
      // so the loser sees the winner's participant, thread and message. The process-local lock
      // is the fast path; the store lock holds the same section across server instances.
      return withInboundKey(`${companyId}|${channel}|${address}`, () => store.lockInboundKey(companyId, channel, address, async () => {
        const at = now();
        const existing = await store.findMessageByExternalId(companyId, channel, externalId);
        if (existing) {
          return { thread: await loadThread(companyId, existing.threadId), message: existing, duplicate: true };
        }

        let participant: Participant | null = await store.findContactParticipant(companyId, channel, address);
        if (!participant) {
          const created: Participant = {
            companyId,
            id: newId(),
            kind: 'contact',
            channel,
            address,
            displayName: input.displayName ?? null,
            createdAt: at,
          };
          try {
            await store.insertParticipant(created);
            participant = created;
          } catch (err) {
            if (!isUniqueConflict(err)) throw err;
            participant = await store.findContactParticipant(companyId, channel, address);
            if (!participant) throw err;
          }
        }

        let thread = await store.findOpenThreadForParticipant(companyId, channel, participant.id);
        if (thread) {
          const patch = { lastMessageAt: at, updatedAt: at, ...(thread.status === 'snoozed' ? { status: 'open' as const } : {}) };
          thread = (await store.updateThread(companyId, thread.id, patch)) ?? thread;
        } else {
          thread = {
            companyId,
            id: newId(),
            channel,
            subject: input.subject ?? null,
            status: 'open',
            assignee: null,
            lastMessageAt: at,
            createdAt: at,
            updatedAt: at,
          };
          await store.insertThread(thread);
          await store.linkParticipant({ companyId, threadId: thread.id, participantId: participant.id });
        }

        const message = newMessage(
          companyId,
          thread,
          { direction: 'inbound', status: 'received', authorKind: 'contact', authorId: participant.id, body, externalId },
          at,
        );
        try {
          await store.insertMessage(message);
        } catch (err) {
          if (!isUniqueConflict(err)) throw err;
          const winner = await store.findMessageByExternalId(companyId, channel, externalId);
          if (!winner) throw err;
          return { thread: await loadThread(companyId, winner.threadId), message: winner, duplicate: true };
        }
        return { thread, message, duplicate: false };
      }));
    },

    async getThread(companyId, threadId) {
      return loadThread(requireCompanyId(companyId), assertId(threadId, 'threadId'));
    },

    async listThreads(companyId, filter = {}) {
      return store.listThreads(requireCompanyId(companyId), filter);
    },

    async listMessages(companyId, threadId) {
      const co = requireCompanyId(companyId);
      await loadThread(co, assertId(threadId, 'threadId'));
      return store.listMessages(co, threadId);
    },

    async assignThread(companyId, actor, threadId, assignee) {
      const co = requireCompanyId(companyId);
      const thread = await loadThread(co, assertId(threadId, 'threadId'));
      const next = assertAssignee(assignee);
      // An agent may claim a thread for itself. It cannot hand work to someone else or drop it.
      if (actor.kind === 'agent' && (next === null || next.kind !== 'agent' || next.id !== actor.id)) {
        throw new InboxError('An agent may only assign a thread to itself', 'forbidden');
      }
      return (await store.updateThread(co, thread.id, { assignee: next, updatedAt: now() })) ?? thread;
    },

    async setThreadStatus(companyId, actor, threadId, status) {
      const co = requireCompanyId(companyId);
      const thread = await loadThread(co, assertId(threadId, 'threadId'));
      if (!canWork(thread, actor)) throw new InboxError('Thread is not assigned to this actor', 'forbidden');
      return (await store.updateThread(co, thread.id, { status: assertStatus(status), updatedAt: now() })) ?? thread;
    },

    async createDraft(companyId, actor, threadId, body) {
      const co = requireCompanyId(companyId);
      const thread = await loadThread(co, assertId(threadId, 'threadId'));
      if (!canWork(thread, actor)) throw new InboxError('Thread is not assigned to this actor', 'forbidden');
      const message = newMessage(
        co,
        thread,
        {
          direction: 'outbound',
          status: 'draft',
          authorKind: actor.kind === 'agent' ? 'agent' : 'staff',
          authorId: actor.id,
          body: assertBody(body),
          externalId: null,
        },
        now(),
      );
      await store.insertMessage(message);
      return message;
    },

    async sendAsStaff(companyId, actor, threadId, body) {
      const co = requireCompanyId(companyId);
      if (actor.kind !== 'human') throw new InboxError('Only a human may send without approval', 'forbidden');
      const thread = await loadThread(co, assertId(threadId, 'threadId'));
      const at = now();
      const message = newMessage(
        co,
        thread,
        { direction: 'outbound', status: 'queued', authorKind: 'staff', authorId: actor.id, body: assertBody(body), externalId: null },
        at,
      );
      message.queuedAt = at;
      await store.insertMessage(message);
      await store.updateThread(co, thread.id, { lastMessageAt: at, updatedAt: at });
      return message;
    },

    async requestSend(companyId, actor, messageId) {
      const co = requireCompanyId(companyId);
      if (actor.kind !== 'agent') throw new InboxError('Humans send with sendAsStaff', 'forbidden');
      const message = await loadMessage(co, assertId(messageId, 'messageId'));
      if (message.direction !== 'outbound' || message.authorKind !== 'agent' || message.authorId !== actor.id) {
        throw new InboxError('An agent may only send its own drafts', 'forbidden');
      }
      if (message.status !== 'draft') throw new InboxError(`Message is ${message.status}, not a draft`, 'conflict');

      const gate = await approvals.gateAction({
        companyId: co,
        requestedBy: null,
        agentId: actor.id,
        action: SEND_ACTION,
        params: { messageId: message.id, threadId: message.threadId, channel: message.channel, bodySha256: message.bodySha256 },
        context: { threadId: message.threadId, channel: message.channel },
        urgency: 'normal',
        ttlMs,
      });
      const awaiting = (await store.updateMessage(co, message.id, {
        status: 'awaiting_approval',
        approvalId: gate.approval.id,
        updatedAt: now(),
      })) ?? message;

      if (gate.status === 'approved') return service.applyApprovalDecision(co, awaiting.id);
      if (gate.status === 'rejected' || gate.status === 'expired') {
        return (await store.updateMessage(co, message.id, { status: 'rejected', updatedAt: now() })) ?? awaiting;
      }
      return awaiting;
    },

    async applyApprovalDecision(companyId, messageId) {
      const co = requireCompanyId(companyId);
      const message = await loadMessage(co, assertId(messageId, 'messageId'));
      if (message.status !== 'awaiting_approval' || !message.approvalId) return message;

      const approval = await approvals.getApproval(co, message.approvalId);
      if (!approval) throw new InboxError('Approval not found', 'not_found');
      if (approval.status === 'pending') return message;

      if (approval.status === 'rejected' || approval.status === 'expired') {
        return (await store.updateMessage(co, message.id, { status: 'rejected', updatedAt: now() })) ?? message;
      }

      // Approved. Bind the decision to this exact message and body before anything is queued.
      const p = approval.params;
      const matches =
        approval.action === SEND_ACTION &&
        p.messageId === message.id &&
        p.threadId === message.threadId &&
        p.bodySha256 === message.bodySha256;
      if (!matches) throw new InboxError('Approval does not match this message', 'conflict');

      const at = now();
      if (deps.transactions) {
        // One transaction: the claim, the thread touch and the message status commit together.
        // Any throw (including the 'already executed' conflict) rolls back all three.
        const committed = await deps.transactions.runInTransaction(async (tx) => {
          // The claim runs on the transaction handle. The approvals port returns null when nothing
          // was claimed. The wrapper returns a non-null marker because the handle only reports a boolean.
          const claim = await approvals.markExecuted(co, approval.id, null, {
            claimExecuted: async (companyId, id) => ((await tx.markApprovalExecuted(companyId, id)) ? { id } : null),
          });
          if (!claim) throw new InboxError('Approval was already executed', 'conflict');
          await tx.updateThread(co, message.threadId, { lastMessageAt: at, updatedAt: at });
          const queued = await tx.updateMessage(co, message.id, { status: 'queued', queuedAt: at, updatedAt: at });
          if (!queued) throw new InboxError('Message not found', 'not_found');
          return queued;
        });
        // Audit only after the commit. A rolled-back send writes no execution record.
        if (approvals.recordExecuted) await approvals.recordExecuted(co, approval, null);
        return committed;
      }

      // No transaction runner is configured. The claim runs first so a second decision cannot
      // execute the approval twice. If a later write fails, the approval stays executed and the
      // message stays awaiting_approval. Desk must supply `transactions` to close that gap.
      const executed = await approvals.markExecuted(co, approval.id, null);
      if (!executed) throw new InboxError('Approval was already executed', 'conflict');

      await store.updateThread(co, message.threadId, { lastMessageAt: at, updatedAt: at });
      return (await store.updateMessage(co, message.id, { status: 'queued', queuedAt: at, updatedAt: at })) ?? message;
    },
  };
  return service;
}
