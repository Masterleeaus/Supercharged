/*
 * Storage port for the unified inbox. The service depends on this interface only.
 *
 * Every method takes companyId as its first argument and must read or write only rows that carry it.
 * A row whose companyId differs from the argument is treated as absent (null, empty or false).
 * Tests use InMemoryInboxStorage. A Drizzle adapter is not written yet (see DECISIONS.md).
 */
import type {
  Handler,
  InboxConversation,
  InboxFilter,
  InboxParticipant,
  InboxPresence,
  InboxPriority,
  MessageCursor,
  TicketStatus,
} from "./types.ts";

/** Fields the service may change on a conversation. Each key is optional, and only the keys present are written. */
export interface ConversationStatePatch {
  ticketStatus?: TicketStatus;
  assignedTo?: string | null;
  priority?: InboxPriority;
}

/**
 * Result of a handler change. applied is false when the conversation already had that handler,
 * and nothing was written. from is the handler before the call.
 */
export interface HandlerTransition {
  applied: boolean;
  from: Handler;
  conversation: InboxConversation;
}

export interface InboxStorage {
  getConversation(companyId: string, conversationId: string): Promise<InboxConversation | null>;

  /**
   * Moves the conversation to the given handler in one conditional write. The check and the write are one
   * step, so two concurrent takeovers cannot both report applied. 'human' sets connectAgentAt to connectedAt,
   * and 'ai' clears it. Returns null when the conversation is not in this company.
   */
  transitionHandler(
    companyId: string,
    conversationId: string,
    to: Handler,
    connectedAt: Date,
  ): Promise<HandlerTransition | null>;

  /** Returns the page of rows that match the filter, plus the total that match before paging. Sorted by lastActivityAt desc. */
  listConversations(companyId: string, filter: InboxFilter): Promise<{ rows: InboxConversation[]; total: number }>;

  /** Returns the updated row, or null when the conversation is not in this company. */
  saveConversationState(companyId: string, conversationId: string, patch: ConversationStatePatch): Promise<InboxConversation | null>;

  /** Number of conversations that have at least one unread inbound (role user, not an internal note) message. */
  countConversationsWithUnreadInbound(companyId: string, handler: Handler | "all"): Promise<number>;

  /** Cursor of the newest message in the conversation, or null when it has no messages. */
  latestMessageCursor(companyId: string, conversationId: string): Promise<MessageCursor | null>;

  /** Cursor of one message, or null when the message is not in this conversation of this company. */
  findMessageCursor(companyId: string, conversationId: string, messageId: string): Promise<MessageCursor | null>;

  /** Messages strictly after the cursor. A null cursor counts every message. */
  countMessagesAfter(companyId: string, conversationId: string, cursor: MessageCursor | null): Promise<number>;

  findParticipantByKey(
    companyId: string,
    conversationId: string,
    type: string,
    reference: string | null,
  ): Promise<InboxParticipant | null>;

  getParticipant(companyId: string, conversationId: string, participantId: string): Promise<InboxParticipant | null>;

  /** Inserts the row when its id is new, otherwise replaces it. The companyId argument must match the row. */
  saveParticipant(companyId: string, participant: InboxParticipant): Promise<void>;

  listParticipants(companyId: string, conversationId: string): Promise<InboxParticipant[]>;

  /** True when a row was removed. */
  deleteParticipant(companyId: string, conversationId: string, participantId: string): Promise<boolean>;

  getPresence(companyId: string, conversationId: string, participantKey: string): Promise<InboxPresence | null>;

  /** Inserts or replaces the presence row for (conversation, participantKey). The companyId argument must match the row. */
  savePresence(companyId: string, presence: InboxPresence): Promise<void>;

  /** Presence rows with lastSeenAt at or after since. Order is not guaranteed, the service sorts. */
  listPresenceSince(companyId: string, conversationId: string, since: Date): Promise<InboxPresence[]>;
}
