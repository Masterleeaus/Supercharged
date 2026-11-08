/*
 * Unified inbox types. Port of the Chatbot Agent unified inbox (UnifiedInboxService, ChatbotParticipant,
 * ChatbotPresence) and the handoff rule from the Chatbot extension (connect_agent_at).
 *
 * Types and constants only. No runtime imports. Every entity carries companyId.
 */

/** Ticket status from TicketStatusEnum. 'deleted' exists in PHP but is not part of the inbox query, so it is not ported. */
export const TICKET_STATUSES = ['new', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Who is handling a conversation. 'ai' while connect_agent_at is null, 'human' once a person took over.
 * The PHP source has no separate handler column, so this is derived from connectAgentAt.
 */
export const HANDLERS = ['ai', 'human'] as const;
export type Handler = (typeof HANDLERS)[number];

/** Priority values taken from the sibling customer-communications module. The PHP column is a free string(32). */
export const INBOX_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

/** Presence states from the PHP touchPresence validation. */
export const PRESENCE_STATES = ['online', 'away', 'busy', 'offline'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const MAX_ID_LENGTH = 191;
export const MAX_TYPE_LENGTH = 64;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;
export const MIN_PRESENCE_TTL_SECONDS = 15;
export const DEFAULT_PRESENCE_TTL_SECONDS = 120;

/** Position of a message in a conversation. Message ids are UUIDs in Desk, so order uses (createdAt, id). */
export interface MessageCursor {
  createdAt: Date;
  id: string;
}

export interface InboxConversation {
  companyId: string;
  id: string;
  chatbotId: string;
  name: string | null;
  summary: string | null;
  channel: string;
  /** Set when a human took over. Null while the AI handles the chat. */
  connectAgentAt: Date | null;
  ticketStatus: TicketStatus;
  assignedTo: string | null;
  priority: InboxPriority;
  lastActivityAt: Date;
}

export interface InboxMessage {
  companyId: string;
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  createdAt: Date;
  /** Null until a staff member has read it. Only inbound user messages drive the badge counts. */
  readAt: Date | null;
  isInternalNote: boolean;
}

export interface InboxParticipant {
  companyId: string;
  id: string;
  conversationId: string;
  type: string;
  reference: string | null;
  displayName: string | null;
  metadata: Record<string, unknown>;
  lastSeenAt: Date;
  lastReadMessageId: string | null;
  lastReadMessageCreatedAt: Date | null;
  lastReadAt: Date | null;
}

export interface InboxPresence {
  companyId: string;
  conversationId: string;
  participantKey: string;
  state: PresenceState;
  lastSeenAt: Date;
  metadata: Record<string, unknown>;
}

/** Who made a state change. Recorded on every emitted event. */
export interface InboxActor {
  id: string;
}

export interface HandlingState {
  conversationId: string;
  handler: Handler;
  handedOffAt: Date | null;
  assignedTo: string | null;
}

export interface HandlingChange {
  conversation: InboxConversation;
  /** False when the conversation was already in the requested state, so no event was emitted. */
  changed: boolean;
}

/** Input from the caller. Validated and normalised by the service before it reaches storage. */
export interface InboxQueryInput {
  /** Matches conversation name or summary, literally (no LIKE wildcards). */
  q?: string;
  handler?: Handler | 'all';
  assignedTo?: string;
  priority?: InboxPriority;
  status?: TicketStatus | 'all';
  /** Only conversations with an unread inbound message. */
  unread?: boolean;
  page?: number;
  perPage?: number;
}

/** Filter after validation. Storage applies it as given. */
export interface InboxFilter {
  q: string | null;
  handler: Handler | 'all';
  assignedTo: string | null;
  priority: InboxPriority | null;
  status: TicketStatus | null;
  unread: boolean;
  offset: number;
  limit: number;
}

export interface InboxPage {
  data: InboxConversation[];
  total: number;
  page: number;
  perPage: number;
}

/** Badge counts. Each count is the number of conversations with an unread inbound message. */
export interface UnreadCounts {
  agent: number;
  ai: number;
  all: number;
}

export interface UpsertParticipantInput {
  type: string;
  reference?: string | null;
  displayName?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TouchPresenceInput {
  participantKey: string;
  state?: PresenceState;
  metadata?: Record<string, unknown>;
}
