/**
 * In-memory implementation of AgentInboxService and AgentConversationService. Used by the tests and for local
 * runs. It follows the same rules as the production store: every read and write is filtered by companyId,
 * and every method calls requireCompanyId first.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type {
  AgentConversation,
  AgentConversationService,
  AgentHandler,
  AgentInboxService,
  AgentMessage,
  AgentMessageRole,
  AgentTicketStatus,
  ConversationWithMessages,
  InboxPage,
  InboxQuery,
  StaffMessageInput,
} from "./contracts.ts";

export interface SeedConversation {
  id: string;
  companyId: string;
  chatbotId?: string;
  channel?: string;
  handler?: AgentHandler;
  ticketStatus?: AgentTicketStatus;
  handlerStaffId?: string | null;
}

export interface SeedMessage {
  conversationId: string;
  role: AgentMessageRole;
  message: string;
  isInternalNote?: boolean;
  staffId?: string | null;
}

export interface MemoryAgentStore extends AgentInboxService, AgentConversationService {
  seedConversation(input: SeedConversation): AgentConversation;
  seedMessage(companyId: string, input: SeedMessage): AgentMessage;
  /** Test inspection. Returns copies, so callers cannot change stored state. */
  allMessages(companyId: string, conversationId: string): AgentMessage[];
}

/** A stored message carries its company id. The public AgentMessage type does not. */
type StoredMessage = AgentMessage & { companyId: string };

export function createMemoryAgentStore(now: () => Date = () => new Date()): MemoryAgentStore {
  const conversations = new Map<string, AgentConversation>();
  const messages: StoredMessage[] = [];
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  function findConversation(companyId: string, id: string): AgentConversation | undefined {
    const conv = conversations.get(id);
    return conv && conv.companyId === companyId ? conv : undefined;
  }

  function copyConversation(conv: AgentConversation): AgentConversation {
    return { ...conv, updatedAt: new Date(conv.updatedAt) };
  }

  function copyMessage(m: StoredMessage): AgentMessage {
    const { companyId: _companyId, ...rest } = m;
    return { ...rest, createdAt: new Date(m.createdAt) };
  }

  function messagesFor(companyId: string, conversationId: string): AgentMessage[] {
    return messages
      .filter((m) => m.companyId === companyId && m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copyMessage);
  }

  return {
    seedConversation(input) {
      const companyId = requireCompanyId(input.companyId);
      if (conversations.has(input.id)) throw new Error(`duplicate conversation id ${input.id}`);
      const conv: AgentConversation = {
        id: input.id,
        companyId,
        chatbotId: input.chatbotId ?? "bot-1",
        channel: input.channel ?? "web",
        handler: input.handler ?? "ai",
        ticketStatus: input.ticketStatus ?? "new",
        handlerStaffId: input.handlerStaffId ?? null,
        updatedAt: now(),
      };
      conversations.set(conv.id, conv);
      return copyConversation(conv);
    },

    seedMessage(companyId, input) {
      const scoped = requireCompanyId(companyId);
      const conv = findConversation(scoped, input.conversationId);
      if (!conv) throw new Error(`seed: conversation ${input.conversationId} not in company`);
      const created: StoredMessage = {
        id: nextId("msg"),
        companyId: scoped,
        conversationId: input.conversationId,
        role: input.role,
        message: input.message,
        isInternalNote: input.isInternalNote ?? false,
        staffId: input.staffId ?? null,
        createdAt: now(),
      };
      messages.push(created);
      return copyMessage(created);
    },

    allMessages(companyId, conversationId) {
      return messagesFor(requireCompanyId(companyId), conversationId);
    },

    async listInbox(companyId: string, query: InboxQuery): Promise<InboxPage> {
      const scoped = requireCompanyId(companyId);
      const needle = query.search?.trim().toLowerCase() ?? "";

      const matching = [...conversations.values()]
        .filter((c) => c.companyId === scoped)
        .filter((c) => query.handler === undefined || c.handler === query.handler)
        .filter((c) => query.ticketStatus === undefined || query.ticketStatus === "all" || c.ticketStatus === query.ticketStatus)
        .filter((c) => {
          if (needle === "") return true;
          return messages.some(
            (m) =>
              m.companyId === scoped &&
              m.conversationId === c.id &&
              m.message.toLowerCase().includes(needle),
          );
        })
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      const start = (query.page - 1) * query.perPage;
      return {
        items: matching.slice(start, start + query.perPage).map(copyConversation),
        page: query.page,
        perPage: query.perPage,
        total: matching.length,
      };
    },

    async getConversation(companyId, conversationId): Promise<ConversationWithMessages | null> {
      const scoped = requireCompanyId(companyId);
      const conv = findConversation(scoped, conversationId);
      if (!conv) return null;
      return { conversation: copyConversation(conv), messages: messagesFor(scoped, conversationId) };
    },

    async appendStaffMessage(companyId, input: StaffMessageInput): Promise<AgentMessage | null> {
      const scoped = requireCompanyId(companyId);
      const conv = findConversation(scoped, input.conversationId);
      if (!conv) return null;
      const created: StoredMessage = {
        id: nextId("msg"),
        companyId: scoped,
        conversationId: conv.id,
        role: "assistant",
        message: input.message,
        isInternalNote: input.isInternalNote,
        staffId: input.staffId,
        createdAt: now(),
      };
      messages.push(created);
      conv.updatedAt = now();
      return copyMessage(created);
    },

    async setHandler(companyId, conversationId, handler, staffId) {
      const scoped = requireCompanyId(companyId);
      const conv = findConversation(scoped, conversationId);
      if (!conv) return null;
      conv.handler = handler;
      conv.handlerStaffId = handler === "human" ? staffId : null;
      conv.updatedAt = now();
      return copyConversation(conv);
    },

    async setTicketStatus(companyId, conversationId, status, _staffId) {
      const scoped = requireCompanyId(companyId);
      const conv = findConversation(scoped, conversationId);
      if (!conv) return null;
      conv.ticketStatus = status;
      conv.updatedAt = now();
      return copyConversation(conv);
    },
  };
}
