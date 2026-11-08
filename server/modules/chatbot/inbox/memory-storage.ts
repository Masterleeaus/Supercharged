/*
 * In-memory InboxStorage for tests and local runs. Rows are kept per company, and every method reads
 * only the bucket for the companyId it was given, so one company cannot see another's rows.
 * Nothing here touches a database.
 */
import type { ConversationStatePatch, HandlerTransition, InboxStorage } from "./ports.ts";
import type {
  Handler,
  InboxConversation,
  InboxFilter,
  InboxMessage,
  InboxParticipant,
  InboxPresence,
  MessageCursor,
} from "./types.ts";

interface CompanyBucket {
  conversations: Map<string, InboxConversation>;
  messages: InboxMessage[];
  participants: Map<string, InboxParticipant>;
  presence: Map<string, InboxPresence>;
}

export interface SeedConversationInput {
  id: string;
  chatbotId?: string;
  name?: string | null;
  summary?: string | null;
  channel?: string;
  connectAgentAt?: Date | null;
  ticketStatus?: "new" | "closed";
  assignedTo?: string | null;
  priority?: InboxConversation["priority"];
  lastActivityAt: Date;
}

export interface SeedMessageInput {
  id: string;
  role: "user" | "assistant";
  createdAt: Date;
  readAt?: Date | null;
  isInternalNote?: boolean;
}

function requireCompany(companyId: string): string {
  if (typeof companyId !== "string" || companyId.trim() === "") {
    throw new TypeError("inbox storage: companyId is required");
  }
  return companyId;
}

function emptyBucket(): CompanyBucket {
  return { conversations: new Map(), messages: [], participants: new Map(), presence: new Map() };
}

/** Orders messages by createdAt, then by id, so the cursor order is total. */
function compareCursor(a: MessageCursor, b: MessageCursor): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function cloneConversation(row: InboxConversation): InboxConversation {
  return { ...row };
}

function cloneParticipant(row: InboxParticipant): InboxParticipant {
  return { ...row, metadata: { ...row.metadata } };
}

function clonePresence(row: InboxPresence): InboxPresence {
  return { ...row, metadata: { ...row.metadata } };
}

export class InMemoryInboxStorage implements InboxStorage {
  private readonly buckets = new Map<string, CompanyBucket>();

  private bucket(companyId: string): CompanyBucket {
    const key = requireCompany(companyId);
    let found = this.buckets.get(key);
    if (!found) {
      found = emptyBucket();
      this.buckets.set(key, found);
    }
    return found;
  }

  private readBucket(companyId: string): CompanyBucket {
    return this.buckets.get(requireCompany(companyId)) ?? emptyBucket();
  }

  /** Test helper. Adds a conversation for one company. */
  seedConversation(companyId: string, input: SeedConversationInput): InboxConversation {
    const b = this.bucket(companyId);
    if (b.conversations.has(input.id)) {
      throw new Error(`inbox storage: conversation ${input.id} already exists for this company`);
    }
    const row: InboxConversation = {
      companyId,
      id: input.id,
      chatbotId: input.chatbotId ?? "chatbot-1",
      name: input.name ?? null,
      summary: input.summary ?? null,
      channel: input.channel ?? "web",
      connectAgentAt: input.connectAgentAt ?? null,
      ticketStatus: input.ticketStatus ?? "new",
      assignedTo: input.assignedTo ?? null,
      priority: input.priority ?? "normal",
      lastActivityAt: input.lastActivityAt,
    };
    b.conversations.set(input.id, row);
    return cloneConversation(row);
  }

  /** Test helper. Adds a message to a conversation of the same company. */
  addMessage(companyId: string, conversationId: string, input: SeedMessageInput): InboxMessage {
    const b = this.bucket(companyId);
    if (!b.conversations.has(conversationId)) {
      throw new Error(`inbox storage: conversation ${conversationId} is not in this company`);
    }
    const row: InboxMessage = {
      companyId,
      id: input.id,
      conversationId,
      role: input.role,
      createdAt: input.createdAt,
      readAt: input.readAt ?? null,
      isInternalNote: input.isInternalNote ?? false,
    };
    b.messages.push(row);
    return { ...row };
  }

  async getConversation(companyId: string, conversationId: string): Promise<InboxConversation | null> {
    const row = this.readBucket(companyId).conversations.get(conversationId);
    return row ? cloneConversation(row) : null;
  }

  async listConversations(companyId: string, filter: InboxFilter): Promise<{ rows: InboxConversation[]; total: number }> {
    const b = this.readBucket(companyId);
    const needle = filter.q === null ? null : filter.q.toLowerCase();

    const matched = [...b.conversations.values()]
      .filter((row) => {
        if (needle !== null) {
          const haystack = [row.name, row.summary].map((v) => (v ?? "").toLowerCase());
          if (!haystack.some((v) => v.includes(needle))) return false;
        }
        if (filter.handler === "ai" && row.connectAgentAt !== null) return false;
        if (filter.handler === "human" && row.connectAgentAt === null) return false;
        if (filter.assignedTo !== null && row.assignedTo !== filter.assignedTo) return false;
        if (filter.priority !== null && row.priority !== filter.priority) return false;
        if (filter.status !== null && row.ticketStatus !== filter.status) return false;
        if (filter.unread && !this.hasUnreadInbound(b, row.id)) return false;
        return true;
      })
      .sort((a, c) => {
        const byActivity = c.lastActivityAt.getTime() - a.lastActivityAt.getTime();
        if (byActivity !== 0) return byActivity;
        return a.id < c.id ? -1 : a.id > c.id ? 1 : 0;
      });

    const rows = matched.slice(filter.offset, filter.offset + filter.limit).map(cloneConversation);
    return { rows, total: matched.length };
  }

  /** Synchronous body, so the check and the write cannot interleave with another call. */
  async transitionHandler(
    companyId: string,
    conversationId: string,
    to: Handler,
    connectedAt: Date,
  ): Promise<HandlerTransition | null> {
    const row = this.bucket(companyId).conversations.get(conversationId);
    if (!row) return null;
    const from: Handler = row.connectAgentAt === null ? "ai" : "human";
    if (from === to) return { applied: false, from, conversation: cloneConversation(row) };
    row.connectAgentAt = to === "human" ? connectedAt : null;
    return { applied: true, from, conversation: cloneConversation(row) };
  }

  async saveConversationState(
    companyId: string,
    conversationId: string,
    patch: ConversationStatePatch,
  ): Promise<InboxConversation | null> {
    const b = this.bucket(companyId);
    const row = b.conversations.get(conversationId);
    if (!row) return null;
    if ("ticketStatus" in patch && patch.ticketStatus !== undefined) row.ticketStatus = patch.ticketStatus;
    if ("assignedTo" in patch) row.assignedTo = patch.assignedTo ?? null;
    if ("priority" in patch && patch.priority !== undefined) row.priority = patch.priority;
    return cloneConversation(row);
  }

  async countConversationsWithUnreadInbound(companyId: string, handler: Handler | "all"): Promise<number> {
    const b = this.readBucket(companyId);
    let count = 0;
    for (const row of b.conversations.values()) {
      if (handler === "ai" && row.connectAgentAt !== null) continue;
      if (handler === "human" && row.connectAgentAt === null) continue;
      if (this.hasUnreadInbound(b, row.id)) count += 1;
    }
    return count;
  }

  async latestMessageCursor(companyId: string, conversationId: string): Promise<MessageCursor | null> {
    const cursors = this.conversationCursors(this.readBucket(companyId), conversationId);
    if (cursors.length === 0) return null;
    return cursors.reduce((latest, next) => (compareCursor(next, latest) > 0 ? next : latest));
  }

  async findMessageCursor(companyId: string, conversationId: string, messageId: string): Promise<MessageCursor | null> {
    const row = this.readBucket(companyId).messages.find(
      (m) => m.conversationId === conversationId && m.id === messageId,
    );
    return row ? { createdAt: row.createdAt, id: row.id } : null;
  }

  async countMessagesAfter(companyId: string, conversationId: string, cursor: MessageCursor | null): Promise<number> {
    const cursors = this.conversationCursors(this.readBucket(companyId), conversationId);
    if (cursor === null) return cursors.length;
    return cursors.filter((c) => compareCursor(c, cursor) > 0).length;
  }

  async findParticipantByKey(
    companyId: string,
    conversationId: string,
    type: string,
    reference: string | null,
  ): Promise<InboxParticipant | null> {
    const row = [...this.readBucket(companyId).participants.values()].find(
      (p) => p.conversationId === conversationId && p.type === type && p.reference === reference,
    );
    return row ? cloneParticipant(row) : null;
  }

  async getParticipant(companyId: string, conversationId: string, participantId: string): Promise<InboxParticipant | null> {
    const row = this.readBucket(companyId).participants.get(participantId);
    if (!row || row.conversationId !== conversationId) return null;
    return cloneParticipant(row);
  }

  async saveParticipant(companyId: string, participant: InboxParticipant): Promise<void> {
    if (participant.companyId !== requireCompany(companyId)) {
      throw new Error("inbox storage: participant companyId does not match the scope it was saved under");
    }
    this.bucket(companyId).participants.set(participant.id, cloneParticipant(participant));
  }

  async listParticipants(companyId: string, conversationId: string): Promise<InboxParticipant[]> {
    return [...this.readBucket(companyId).participants.values()]
      .filter((p) => p.conversationId === conversationId)
      .sort((a, c) => (a.type === c.type ? (a.displayName ?? "").localeCompare(c.displayName ?? "") : a.type.localeCompare(c.type)))
      .map(cloneParticipant);
  }

  async deleteParticipant(companyId: string, conversationId: string, participantId: string): Promise<boolean> {
    const b = this.bucket(companyId);
    const row = b.participants.get(participantId);
    if (!row || row.conversationId !== conversationId) return false;
    return b.participants.delete(participantId);
  }

  async getPresence(companyId: string, conversationId: string, participantKey: string): Promise<InboxPresence | null> {
    const row = this.readBucket(companyId).presence.get(presenceKey(conversationId, participantKey));
    return row ? clonePresence(row) : null;
  }

  async savePresence(companyId: string, presence: InboxPresence): Promise<void> {
    if (presence.companyId !== requireCompany(companyId)) {
      throw new Error("inbox storage: presence companyId does not match the scope it was saved under");
    }
    this.bucket(companyId).presence.set(presenceKey(presence.conversationId, presence.participantKey), clonePresence(presence));
  }

  async listPresenceSince(companyId: string, conversationId: string, since: Date): Promise<InboxPresence[]> {
    return [...this.readBucket(companyId).presence.values()]
      .filter((p) => p.conversationId === conversationId && p.lastSeenAt.getTime() >= since.getTime())
      .map(clonePresence);
  }

  private conversationCursors(b: CompanyBucket, conversationId: string): MessageCursor[] {
    return b.messages
      .filter((m) => m.conversationId === conversationId)
      .map((m) => ({ createdAt: m.createdAt, id: m.id }));
  }

  private hasUnreadInbound(b: CompanyBucket, conversationId: string): boolean {
    return b.messages.some(
      (m) => m.conversationId === conversationId && m.role === "user" && m.readAt === null && !m.isInternalNote,
    );
  }
}

function presenceKey(conversationId: string, participantKey: string): string {
  return `${conversationId}\u0000${participantKey}`;
}
