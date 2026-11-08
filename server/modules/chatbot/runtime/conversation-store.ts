/*
 * Storage port for conversation create, archive, merge, search, summary cache and delivery status.
 *
 * The runtime depends on this interface alone. The in-memory store below is the reference behaviour and the one the
 * tests use. A Drizzle store needs columns that the chatbot_conversations table does not have yet (status,
 * merged_into_id, summary, summary_updated_at). See DECISIONS.md, change requests.
 *
 * Tenancy: every method takes companyId first. A row whose company differs is treated as absent (null, [] or false).
 * Outbox rows are written by the same method that changes state, so a store can keep them in one transaction.
 */
import type { ChannelKind } from "../contracts/channels.ts";
import type { ConversationRecord, ConversationStatus, MessageRole } from "../contracts/runtime.ts";
import type { OutboxTx } from "../channels/outbox.ts";

/** A message as the conversation store keeps it. Text is null for non-text content. */
export interface StoredMessage {
  id: string;
  companyId: string;
  conversationId: string;
  role: MessageRole;
  text: string | null;
  isInternalNote: boolean;
  createdAt: Date;
}

export interface NewStoredMessage {
  id: string;
  role: MessageRole;
  text: string | null;
  isInternalNote: boolean;
  createdAt: Date;
}

/** An outbox row to write in the same unit of work as the state change. Ids and status only, never message text. */
export interface OutboxAppend {
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  availableAt: Date;
}

export interface ConversationSearchQuery {
  chatbotId?: string;
  channel?: ChannelKind;
  status?: ConversationStatus;
  customerId?: string;
  /** Case-insensitive text, matched against the summary and every message of the conversation. */
  query?: string;
  updatedAfter?: Date;
  /** Already clamped by the runtime. Store returns at most limit rows. */
  limit: number;
  /** Opaque cursor from a previous page. */
  after: { updatedAt: Date; id: string } | null;
}

export type MergeOutcome =
  | { kind: "merged"; movedMessages: number; target: ConversationRecord; source: ConversationRecord }
  | { kind: "already_merged"; target: ConversationRecord; source: ConversationRecord }
  | { kind: "conflict" };

export interface ConversationStore {
  /** Chatbot ownership check. Returns false for a chatbot of another company. */
  chatbotBelongsTo(companyId: string, chatbotId: string): Promise<boolean>;
  /** Conversation owning a message, or null when the message is not in this company. */
  conversationOfMessage(companyId: string, messageId: string): Promise<string | null>;

  insertConversation(companyId: string, record: ConversationRecord, outbox: OutboxAppend): Promise<ConversationRecord>;
  findConversation(companyId: string, id: string): Promise<ConversationRecord | null>;
  insertMessage(companyId: string, conversationId: string, message: NewStoredMessage): Promise<StoredMessage | null>;
  /**
   * Stores one assistant reply and runs enqueueSend in the same unit of work. enqueueSend receives the transaction
   * handle (undefined in the memory store) and writes the channel send row through it. If either step fails, the
   * reply is not stored. Returns null when the conversation is not in this company (nothing is written).
   */
  insertReply(
    companyId: string,
    conversationId: string,
    reply: NewStoredMessage,
    enqueueSend: ((tx: OutboxTx) => Promise<unknown>) | null,
  ): Promise<StoredMessage | null>;
  /** Oldest first. Empty when the conversation is not in this company. */
  listMessages(companyId: string, conversationId: string): Promise<StoredMessage[]>;

  /** Sets status. Returns null when the conversation is absent. The outbox row is written with the change. */
  setStatus(
    companyId: string,
    id: string,
    status: ConversationStatus,
    now: Date,
    outbox: OutboxAppend | null,
  ): Promise<ConversationRecord | null>;

  /**
   * Moves every message of source into target and marks source merged, as one unit. Re-checks the states it depends
   * on, so a concurrent change gives 'conflict' instead of a half merge.
   */
  mergeConversations(
    companyId: string,
    targetId: string,
    sourceId: string,
    now: Date,
    outbox: OutboxAppend,
  ): Promise<MergeOutcome>;

  setSummary(companyId: string, id: string, summary: string, now: Date): Promise<ConversationRecord | null>;

  /** Newest first by updatedAt, then id. Filters are applied before the limit. */
  searchConversations(companyId: string, query: ConversationSearchQuery): Promise<ConversationRecord[]>;
}

/** Outbox rows the memory store has accepted. Tests read this to check that state change and event come together. */
export interface MemoryOutboxRow extends OutboxAppend {
  companyId: string;
  createdAt: Date;
}

export interface MemoryConversationStore extends ConversationStore {
  readonly outbox: readonly MemoryOutboxRow[];
  /** Test helper: registers a chatbot for a company. */
  addChatbot(companyId: string, chatbotId: string): void;
}

const copy = <T>(value: T): T => structuredClone(value);

export function createMemoryConversationStore(): MemoryConversationStore {
  const chatbots = new Map<string, Set<string>>();
  const conversations = new Map<string, Map<string, ConversationRecord>>();
  const messages = new Map<string, Map<string, StoredMessage>>();
  const outbox: MemoryOutboxRow[] = [];

  const bucket = <T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> => {
    let rows = store.get(companyId);
    if (!rows) {
      rows = new Map<string, T>();
      store.set(companyId, rows);
    }
    return rows;
  };
  const readBucket = <T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> =>
    store.get(companyId) ?? new Map<string, T>();

  const writeOutbox = (companyId: string, event: OutboxAppend, now: Date): void => {
    outbox.push({ ...copy(event), companyId, createdAt: now });
  };

  const messagesOf = (companyId: string, conversationId: string): StoredMessage[] =>
    [...readBucket(messages, companyId).values()]
      .filter((row) => row.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  return {
    get outbox() {
      return outbox.map((row) => copy(row));
    },

    addChatbot(companyId, chatbotId) {
      let owned = chatbots.get(companyId);
      if (!owned) {
        owned = new Set<string>();
        chatbots.set(companyId, owned);
      }
      owned.add(chatbotId);
    },

    async chatbotBelongsTo(companyId, chatbotId) {
      return chatbots.get(companyId)?.has(chatbotId) ?? false;
    },

    async conversationOfMessage(companyId, messageId) {
      return readBucket(messages, companyId).get(messageId)?.conversationId ?? null;
    },

    async insertConversation(companyId, record, event) {
      const row = { ...copy(record), companyId };
      bucket(conversations, companyId).set(row.id, row);
      writeOutbox(companyId, event, row.createdAt);
      return copy(row);
    },

    async findConversation(companyId, id) {
      const row = readBucket(conversations, companyId).get(id);
      return row ? copy(row) : null;
    },

    async insertMessage(companyId, conversationId, message) {
      if (!readBucket(conversations, companyId).has(conversationId)) return null;
      const row: StoredMessage = { ...copy(message), companyId, conversationId };
      bucket(messages, companyId).set(row.id, row);
      return copy(row);
    },

    async insertReply(companyId, conversationId, reply, enqueueSend) {
      const rows = bucket(conversations, companyId);
      const conversation = rows.get(conversationId);
      if (!conversation) return null;
      const messageRows = bucket(messages, companyId);
      const row: StoredMessage = { ...copy(reply), companyId, conversationId, role: "assistant" };
      messageRows.set(row.id, row);
      try {
        if (enqueueSend) await enqueueSend(undefined);
      } catch (error) {
        // Same unit as the send row: a failed send row takes the reply with it.
        messageRows.delete(row.id);
        throw error;
      }
      rows.set(conversationId, { ...conversation, updatedAt: reply.createdAt });
      return copy(row);
    },

    async listMessages(companyId, conversationId) {
      return messagesOf(companyId, conversationId).map(copy);
    },

    async setStatus(companyId, id, status, now, event) {
      const rows = bucket(conversations, companyId);
      const current = rows.get(id);
      if (!current) return null;
      const next: ConversationRecord = { ...current, status, updatedAt: now };
      rows.set(id, next);
      if (event) writeOutbox(companyId, event, now);
      return copy(next);
    },

    async mergeConversations(companyId, targetId, sourceId, now, event) {
      const rows = bucket(conversations, companyId);
      const target = rows.get(targetId);
      const source = rows.get(sourceId);
      if (!target || !source) return { kind: "conflict" };

      if (source.status === "merged" && source.mergedIntoId === targetId) {
        return { kind: "already_merged", target: copy(target), source: copy(source) };
      }
      if (target.status !== "open" || source.status === "merged") return { kind: "conflict" };

      const moving = messagesOf(companyId, sourceId);
      const messageRows = bucket(messages, companyId);
      for (const message of moving) messageRows.set(message.id, { ...message, conversationId: targetId });

      const nextSource: ConversationRecord = { ...source, status: "merged", mergedIntoId: targetId, updatedAt: now };
      const nextTarget: ConversationRecord = { ...target, updatedAt: now };
      rows.set(sourceId, nextSource);
      rows.set(targetId, nextTarget);
      writeOutbox(companyId, event, now);
      return {
        kind: "merged",
        movedMessages: moving.length,
        target: copy(nextTarget),
        source: copy(nextSource),
      };
    },

    async setSummary(companyId, id, summary, now) {
      const rows = bucket(conversations, companyId);
      const current = rows.get(id);
      if (!current) return null;
      const next: ConversationRecord = { ...current, summary, summaryUpdatedAt: now };
      rows.set(id, next);
      return copy(next);
    },

    async searchConversations(companyId, query) {
      const needle = query.query?.trim().toLowerCase() ?? "";
      const list = [...readBucket(conversations, companyId).values()].filter((row) => {
        if (query.status !== undefined ? row.status !== query.status : row.status !== "open") return false;
        if (query.chatbotId !== undefined && row.chatbotId !== query.chatbotId) return false;
        if (query.channel !== undefined && row.channel !== query.channel) return false;
        if (query.customerId !== undefined && row.customerId !== query.customerId) return false;
        if (query.updatedAfter !== undefined && row.updatedAt.getTime() <= query.updatedAfter.getTime()) return false;
        if (needle !== "") {
          const inSummary = (row.summary ?? "").toLowerCase().includes(needle);
          const inMessages = messagesOf(companyId, row.id).some((message) => (message.text ?? "").toLowerCase().includes(needle));
          if (!inSummary && !inMessages) return false;
        }
        return true;
      });

      list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const afterCut = query.after;
      const pageSource = afterCut
        ? list.filter((row) => {
            const time = row.updatedAt.getTime();
            const cut = afterCut.updatedAt.getTime();
            return time < cut || (time === cut && row.id < afterCut.id);
          })
        : list;
      return pageSource.slice(0, query.limit).map(copy);
    },
  };
}
