/*
 * Read side of the reply runtime over the conversation store. The reply runtime reads the conversation, its chatbot and
 * the messages through ReplyStorage (the chatbot storage shapes). This adapter maps the conversation store's records to
 * those shapes, so one store serves both the reply path and the channel path.
 *
 * Rules:
 * - Tenancy: every read is by companyId. A row of another company comes back as null.
 * - Roles: the conversation store calls a customer "customer" (stored as "user"). Only user and assistant messages are
 *   mapped, because the chatbot message shape has no other roles. Staff and system rows are left out of the prompt.
 */
import type { ChatbotRecord, ConversationRecord as ChatbotConversationRecord, MessageRecord } from "../chatbot-storage.ts";
import type { ChatbotStorage } from "../chatbot-storage.ts";
import type { ConversationRecord } from "../contracts/runtime.ts";
import type { ConversationStore, StoredMessage } from "./conversation-store.ts";
import type { ReplyStorage } from "./types.ts";

export function toChatbotConversation(record: ConversationRecord): ChatbotConversationRecord {
  return {
    id: record.id,
    companyId: record.companyId,
    chatbotId: record.chatbotId,
    sessionId: record.externalThreadId ?? `rt-${record.id}`,
    channel: record.channel,
    connectAgentAt: null,
    isShownOnHistory: true,
    ticketStatus: "new",
    pinned: false,
    lastActivityAt: record.updatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toMessageRecord(stored: StoredMessage): MessageRecord | null {
  if (stored.role !== "customer" && stored.role !== "assistant") return null;
  return {
    id: stored.id,
    companyId: stored.companyId,
    conversationId: stored.conversationId,
    role: stored.role === "customer" ? "user" : "assistant",
    message: stored.text ?? "",
    contentType: "text",
    uiSpec: null,
    mediaUrl: null,
    mediaName: null,
    isInternalNote: stored.isInternalNote,
    readAt: null,
    createdAt: stored.createdAt,
  };
}

export function createConversationReplyStorage(deps: {
  store: ConversationStore;
  chatbots: Pick<ChatbotStorage, "findChatbot">;
}): ReplyStorage {
  return {
    async findConversation(companyId, id) {
      const record = await deps.store.findConversation(companyId, id);
      return record && record.companyId === companyId ? toChatbotConversation(record) : null;
    },

    async findChatbot(companyId, id): Promise<ChatbotRecord | null> {
      const record = await deps.chatbots.findChatbot(companyId, id);
      return record && record.companyId === companyId ? record : null;
    },

    async listMessages(companyId, conversationId) {
      const stored = await deps.store.listMessages(companyId, conversationId);
      return stored.map(toMessageRecord).filter((row): row is MessageRecord => row !== null);
    },
  };
}
