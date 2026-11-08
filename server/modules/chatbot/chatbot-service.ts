/**
 * Business logic for the chatbot module (port of Chatbot extension System/Services/ChatbotService.php,
 * plus the conversation rules the routes need).
 *
 * Every public method takes companyId as its first argument and passes it to storage. The company id
 * comes from the verified request scope, never from a body, query or params value. No Express types and
 * no SQL in this file.
 */
import { ChatbotError, requireCompanyId } from "./chatbot-scope.ts";
import type {
  ChatbotInsert,
  ChatbotPatch,
  ChatbotRecord,
  ChatbotStorage,
  ConversationInsert,
  ConversationPatch,
  ConversationRecord,
  MessageRecord,
  TicketStatus,
} from "./chatbot-storage.ts";
import { exportConversation, type ConversationExportFormat, type ExportFile } from "./conversation-export.ts";
import {
  composeResponse,
  DEFAULT_COMPOSER_OPTIONS,
  plainFallbackText,
  type ComposerOptions,
} from "./generative-ui/response-composer.ts";
import type { BuilderRegistry } from "./generative-ui/builder-registry.ts";
import { isSupportedSurface } from "./generative-ui/spec-normaliser.ts";
import type { Obj } from "./generative-ui/semantics.ts";

export { ChatbotError } from "./chatbot-scope.ts";

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export interface ConversationQuery {
  /** Omit or pass "all" for every chatbot. */
  chatbotId?: string;
  /** Omit or pass "all" for every channel. */
  channel?: string;
  /** "ai" = bot handling, "human" = an agent has connected. */
  handler?: "ai" | "human";
  /** "new" or "closed". Omit or pass "all" for both. */
  ticketStatus?: TicketStatus | "all";
  unreadOnly?: boolean;
  /** Inclusive YYYY-MM-DD range on updatedAt. Applied only when both ends are set. */
  startDate?: string;
  endDate?: string;
  /** Case-insensitive substring match against any message in the conversation. */
  search?: string;
  /** "newest" or "oldest" order by the latest user message. Default is last activity, newest first. */
  sort?: "newest" | "oldest";
  page?: number;
  perPage?: number;
}

export interface ConversationListItem extends ConversationRecord {
  lastUserMessageAt: Date | null;
  hasUnreadUserMessage: boolean;
}

export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
}

export interface UnreadCounts {
  /** Human-handled conversations with an unread user message. */
  agent: number;
  /** Bot-handled conversations with an unread user message. */
  ai: number;
  /** Conversations with at least one user message. */
  all: number;
}

export interface AssistantReplyResult {
  message: MessageRecord;
  accepted: boolean;
  changes: Array<{ path: string; message: string }>;
  issues: Array<{ path: string; message: string }>;
}

export interface GenerativeUiDeps {
  registry: BuilderRegistry;
  options?: ComposerOptions;
}

export interface ChatbotServiceDeps {
  storage: ChatbotStorage;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Without this, assistant replies are stored as plain text. */
  generativeUi?: GenerativeUiDeps;
}

export interface ChatbotService {
  listChatbots(companyId: string): Promise<ChatbotRecord[]>;
  getChatbot(companyId: string, id: string): Promise<ChatbotRecord>;
  createChatbot(companyId: string, input: ChatbotInsert): Promise<ChatbotRecord>;
  updateChatbot(companyId: string, id: string, patch: ChatbotPatch): Promise<ChatbotRecord>;

  startConversation(companyId: string, input: ConversationInsert): Promise<ConversationRecord>;
  listConversations(companyId: string, query?: ConversationQuery): Promise<Page<ConversationListItem>>;
  getConversation(companyId: string, id: string): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] }>;
  recordUserMessage(companyId: string, conversationId: string, message: string): Promise<MessageRecord>;
  recordAssistantReply(
    companyId: string,
    conversationId: string,
    rawText: string,
    surface?: string,
  ): Promise<AssistantReplyResult>;
  updateConversationState(
    companyId: string,
    id: string,
    state: { ticketStatus?: TicketStatus; pinned?: boolean; connectAgent?: boolean },
  ): Promise<ConversationRecord>;
  markConversationRead(companyId: string, id: string): Promise<number>;
  unreadCounts(companyId: string): Promise<UnreadCounts>;
  exportConversation(companyId: string, id: string, format: ConversationExportFormat | "pdf" | string): Promise<ExportFile>;
}

function hasUnreadUserMessage(messages: MessageRecord[]): boolean {
  return messages.some((message) => message.role === "user" && message.readAt === null);
}

function latestUserMessageTime(messages: MessageRecord[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const time = message.createdAt.getTime();
    if (latest === null || time > latest) latest = time;
  }
  return latest;
}

function inDateRange(value: Date, startDate: string, endDate: string): boolean {
  const time = value.getTime();
  return time >= Date.parse(`${startDate}T00:00:00.000Z`) && time <= Date.parse(`${endDate}T23:59:59.999Z`);
}

function clampPage(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function clampPerPage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

export function createChatbotService({ storage, now = () => new Date(), generativeUi }: ChatbotServiceDeps): ChatbotService {
  const requireChatbot = async (companyId: string, id: string): Promise<ChatbotRecord> => {
    const chatbot = await storage.findChatbot(companyId, id);
    if (!chatbot) throw new ChatbotError("Chatbot not found", 404);
    return chatbot;
  };

  const requireConversation = async (companyId: string, id: string): Promise<ConversationRecord> => {
    const conversation = await storage.findConversation(companyId, id);
    if (!conversation) throw new ChatbotError("Conversation not found", 404);
    return conversation;
  };

  return {
    async listChatbots(companyId) {
      return storage.listChatbots(requireCompanyId(companyId));
    },

    async getChatbot(companyId, id) {
      return requireChatbot(requireCompanyId(companyId), id);
    },

    async createChatbot(companyId, input) {
      const scope = requireCompanyId(companyId);
      const title = input.title.trim();
      if (title === "") throw new ChatbotError("title must not be blank", 400);
      return storage.insertChatbot(scope, { ...input, title }, now());
    },

    async updateChatbot(companyId, id, patch) {
      const scope = requireCompanyId(companyId);
      const updated = await storage.updateChatbot(scope, id, patch, now());
      if (!updated) throw new ChatbotError("Chatbot not found", 404);
      return updated;
    },

    async startConversation(companyId, input) {
      const scope = requireCompanyId(companyId);
      const chatbot = await requireChatbot(scope, input.chatbotId);
      if (!chatbot.active) throw new ChatbotError("Chatbot is not active", 409);
      return storage.insertConversation(scope, input, now());
    },

    async listConversations(companyId, query = {}) {
      const scope = requireCompanyId(companyId);
      const rows = await storage.listConversations(scope);
      const items: ConversationListItem[] = [];
      const needle = query.search?.trim().toLowerCase() ?? "";

      for (const conversation of rows) {
        if (!conversation.isShownOnHistory) continue;
        if (query.chatbotId && query.chatbotId !== "all" && conversation.chatbotId !== query.chatbotId) continue;
        if (query.channel && query.channel !== "all" && conversation.channel !== query.channel) continue;
        if (query.handler === "ai" && conversation.connectAgentAt !== null) continue;
        if (query.handler === "human" && conversation.connectAgentAt === null) continue;
        if (query.ticketStatus && query.ticketStatus !== "all" && conversation.ticketStatus !== query.ticketStatus) {
          continue;
        }
        if (query.startDate && query.endDate && !inDateRange(conversation.updatedAt, query.startDate, query.endDate)) {
          continue;
        }

        const messages = await storage.listMessages(scope, conversation.id);
        if (needle !== "" && !messages.some((message) => message.message.toLowerCase().includes(needle))) continue;
        if (query.unreadOnly && !hasUnreadUserMessage(messages)) continue;

        const latest = latestUserMessageTime(messages);
        items.push({
          ...conversation,
          lastUserMessageAt: latest === null ? null : new Date(latest),
          hasUnreadUserMessage: hasUnreadUserMessage(messages),
        });
      }

      // Pinned first, then the chosen order. MySQL puts NULL lowest, so NULL sorts last in DESC and first in ASC.
      const latestKey = (item: ConversationListItem): number => item.lastUserMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      items.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (query.sort === "newest") return latestKey(b) - latestKey(a) || a.id.localeCompare(b.id);
        if (query.sort === "oldest") return latestKey(a) - latestKey(b) || a.id.localeCompare(b.id);
        return b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || a.id.localeCompare(b.id);
      });

      const perPage = clampPerPage(query.perPage);
      const page = clampPage(query.page);
      const start = (page - 1) * perPage;
      return { data: items.slice(start, start + perPage), total: items.length, page, perPage };
    },

    async getConversation(companyId, id) {
      const scope = requireCompanyId(companyId);
      const conversation = await requireConversation(scope, id);
      const messages = await storage.listMessages(scope, id);
      return { conversation, messages };
    },

    async recordUserMessage(companyId, conversationId, message) {
      const scope = requireCompanyId(companyId);
      const conversation = await requireConversation(scope, conversationId);
      const stamp = now();
      const row = await storage.insertMessage(scope, {
        conversationId: conversation.id,
        role: "user",
        message,
        createdAt: stamp,
      });
      if (!row) throw new ChatbotError("Conversation not found", 404);
      await storage.updateConversation(scope, conversation.id, { lastActivityAt: stamp }, stamp);
      return row;
    },

    async recordAssistantReply(companyId, conversationId, rawText, surface = "chat") {
      const scope = requireCompanyId(companyId);
      const conversation = await requireConversation(scope, conversationId);
      const chatbot = await requireChatbot(scope, conversation.chatbotId);
      const stamp = now();

      let text = plainFallbackText(rawText);
      let contentType: "text" | "titan-ui" = "text";
      let uiSpec: Obj | null = null;
      let changes: AssistantReplyResult["changes"] = [];
      let issues: AssistantReplyResult["issues"] = [];
      let accepted = false;

      const composerOptions = generativeUi?.options ?? DEFAULT_COMPOSER_OPTIONS;
      if (generativeUi && composerOptions.enabled && chatbot.generativeUiEnabled) {
        const composed = composeResponse(rawText, generativeUi.registry, isSupportedSurface(surface) ? surface : "chat");
        text = composed.fallbackText;
        changes = composed.changes;
        issues = composed.issues;
        if (composed.accepted && composed.spec) {
          accepted = true;
          contentType = "titan-ui";
          uiSpec = composed.spec;
        }
      }

      const row = await storage.insertMessage(scope, {
        conversationId: conversation.id,
        role: "assistant",
        message: text,
        contentType,
        uiSpec,
        createdAt: stamp,
      });
      if (!row) throw new ChatbotError("Conversation not found", 404);
      await storage.updateConversation(scope, conversation.id, { lastActivityAt: stamp }, stamp);
      return { message: row, accepted, changes, issues };
    },

    async updateConversationState(companyId, id, state) {
      const scope = requireCompanyId(companyId);
      const conversation = await requireConversation(scope, id);
      const stamp = now();
      const patch: ConversationPatch = {};
      if (state.ticketStatus !== undefined) patch.ticketStatus = state.ticketStatus;
      if (state.pinned !== undefined) patch.pinned = state.pinned;
      if (state.connectAgent !== undefined) {
        // Connecting an agent keeps the original hand-over time. Disconnecting clears it.
        if (state.connectAgent) {
          patch.connectAgentAt = conversation.connectAgentAt ?? stamp;
        } else {
          patch.connectAgentAt = null;
        }
      }
      const updated = await storage.updateConversation(scope, id, patch, stamp);
      if (!updated) throw new ChatbotError("Conversation not found", 404);
      return updated;
    },

    async markConversationRead(companyId, id) {
      const scope = requireCompanyId(companyId);
      await requireConversation(scope, id);
      return storage.markUserMessagesRead(scope, id, now());
    },

    async unreadCounts(companyId) {
      const scope = requireCompanyId(companyId);
      const counts: UnreadCounts = { agent: 0, ai: 0, all: 0 };
      for (const conversation of await storage.listConversations(scope)) {
        const messages = await storage.listMessages(scope, conversation.id);
        const hasUserMessage = messages.some((message) => message.role === "user");
        const unread = hasUnreadUserMessage(messages);
        if (hasUserMessage) counts.all += 1;
        if (unread && conversation.connectAgentAt !== null) counts.agent += 1;
        if (unread && conversation.connectAgentAt === null) counts.ai += 1;
      }
      return counts;
    },

    async exportConversation(companyId, id, format) {
      const scope = requireCompanyId(companyId);
      if (format === "pdf") {
        throw new ChatbotError("PDF export is not available in this module", 501);
      }
      const conversation = await requireConversation(scope, id);
      const chatbot = await storage.findChatbot(scope, conversation.chatbotId);
      const messages = await storage.listMessages(scope, id);
      return exportConversation(
        { conversation, chatbotTitle: chatbot?.title ?? null, messages, now: now() },
        format,
      );
    },
  };
}
