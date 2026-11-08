/**
 * Storage contract for the chatbot module.
 *
 * Every method takes companyId as its first argument and only reads or writes rows that carry it.
 * The service depends on the ChatbotStorage interface alone, so tests use createMemoryChatbotStorage()
 * and the database is never touched. createDrizzleChatbotStorage() runs the same contract against the
 * chatbot tables in shared/schema.ts.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../shared/schema.ts";
import { requireCompanyId } from "./chatbot-scope.ts";

const { chatbots, chatbotConversations, chatbotMessages } = schema;
type ChatbotDb = NodePgDatabase<typeof schema>;

export type ChatbotMessageRole = "user" | "assistant";
export type TicketStatus = "new" | "closed";
export type MessageContentType = "text" | "titan-ui";

export interface ChatbotRecord {
  id: string;
  companyId: string;
  title: string;
  language: string;
  welcomeMessage: string | null;
  instructions: string | null;
  generativeUiEnabled: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatbotInsert {
  title: string;
  language?: string;
  welcomeMessage?: string | null;
  instructions?: string | null;
  generativeUiEnabled?: boolean;
  active?: boolean;
}

/** Fields a caller may change. companyId and id are never patchable. */
export type ChatbotPatch = Partial<ChatbotInsert>;

export interface ConversationRecord {
  id: string;
  companyId: string;
  chatbotId: string;
  sessionId: string;
  channel: string;
  /** Set when a human agent takes over. Null while the bot is handling the chat. */
  connectAgentAt: Date | null;
  isShownOnHistory: boolean;
  ticketStatus: TicketStatus;
  pinned: boolean;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationInsert {
  chatbotId: string;
  sessionId: string;
  channel?: string;
}

/** Fields a caller may change. companyId, chatbotId and id are never patchable. */
export interface ConversationPatch {
  connectAgentAt?: Date | null;
  ticketStatus?: TicketStatus;
  pinned?: boolean;
  lastActivityAt?: Date;
  isShownOnHistory?: boolean;
}

export interface MessageRecord {
  id: string;
  companyId: string;
  conversationId: string;
  role: ChatbotMessageRole;
  message: string;
  contentType: MessageContentType;
  uiSpec: Record<string, unknown> | null;
  mediaUrl: string | null;
  mediaName: string | null;
  isInternalNote: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface MessageInsert {
  conversationId: string;
  role: ChatbotMessageRole;
  message: string;
  contentType?: MessageContentType;
  uiSpec?: Record<string, unknown> | null;
  mediaUrl?: string | null;
  mediaName?: string | null;
  isInternalNote?: boolean;
  createdAt: Date;
}

export interface ChatbotStorage {
  insertChatbot(companyId: string, input: ChatbotInsert, now: Date): Promise<ChatbotRecord>;
  findChatbot(companyId: string, id: string): Promise<ChatbotRecord | null>;
  listChatbots(companyId: string): Promise<ChatbotRecord[]>;
  updateChatbot(companyId: string, id: string, patch: ChatbotPatch, now: Date): Promise<ChatbotRecord | null>;

  insertConversation(companyId: string, input: ConversationInsert, now: Date): Promise<ConversationRecord>;
  findConversation(companyId: string, id: string): Promise<ConversationRecord | null>;
  listConversations(companyId: string): Promise<ConversationRecord[]>;
  updateConversation(
    companyId: string,
    id: string,
    patch: ConversationPatch,
    now: Date,
  ): Promise<ConversationRecord | null>;

  /** Returns null when the conversation does not belong to companyId. */
  insertMessage(companyId: string, input: MessageInsert): Promise<MessageRecord | null>;
  listMessages(companyId: string, conversationId: string): Promise<MessageRecord[]>;
  /** Sets read_at on the user messages of one conversation. Returns how many rows changed. */
  markUserMessagesRead(companyId: string, conversationId: string, readAt: Date): Promise<number>;
}

/** Copies a record so callers cannot mutate stored state. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryChatbotStorage(): ChatbotStorage {
  // Outer key is companyId. Every lookup starts there, so rows are isolated by tenant.
  const chatbots = new Map<string, Map<string, ChatbotRecord>>();
  const conversations = new Map<string, Map<string, ConversationRecord>>();
  const messages = new Map<string, Map<string, MessageRecord>>();

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

  return {
    async insertChatbot(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      const record: ChatbotRecord = {
        id: randomUUID(),
        companyId: scope,
        title: input.title,
        language: input.language ?? "en",
        welcomeMessage: input.welcomeMessage ?? null,
        instructions: input.instructions ?? null,
        generativeUiEnabled: input.generativeUiEnabled ?? true,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      };
      bucket(chatbots, scope).set(record.id, record);
      return copy(record);
    },

    async findChatbot(companyId, id) {
      const row = readBucket(chatbots, requireCompanyId(companyId)).get(id);
      return row ? copy(row) : null;
    },

    async listChatbots(companyId) {
      return [...readBucket(chatbots, requireCompanyId(companyId)).values()].map(copy);
    },

    async updateChatbot(companyId, id, patch, now) {
      const rows = bucket(chatbots, requireCompanyId(companyId));
      const row = rows.get(id);
      if (!row) return null;
      // Explicit allow-list: a patch can never move a row to another company.
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.language !== undefined) row.language = patch.language;
      if (patch.welcomeMessage !== undefined) row.welcomeMessage = patch.welcomeMessage;
      if (patch.instructions !== undefined) row.instructions = patch.instructions;
      if (patch.generativeUiEnabled !== undefined) row.generativeUiEnabled = patch.generativeUiEnabled;
      if (patch.active !== undefined) row.active = patch.active;
      row.updatedAt = now;
      return copy(row);
    },

    async insertConversation(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      const record: ConversationRecord = {
        id: randomUUID(),
        companyId: scope,
        chatbotId: input.chatbotId,
        sessionId: input.sessionId,
        channel: input.channel ?? "web",
        connectAgentAt: null,
        isShownOnHistory: true,
        ticketStatus: "new",
        pinned: false,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      };
      bucket(conversations, scope).set(record.id, record);
      return copy(record);
    },

    async findConversation(companyId, id) {
      const row = readBucket(conversations, requireCompanyId(companyId)).get(id);
      return row ? copy(row) : null;
    },

    async listConversations(companyId) {
      return [...readBucket(conversations, requireCompanyId(companyId)).values()].map(copy);
    },

    async updateConversation(companyId, id, patch, now) {
      const rows = bucket(conversations, requireCompanyId(companyId));
      const row = rows.get(id);
      if (!row) return null;
      if (patch.connectAgentAt !== undefined) row.connectAgentAt = patch.connectAgentAt;
      if (patch.ticketStatus !== undefined) row.ticketStatus = patch.ticketStatus;
      if (patch.pinned !== undefined) row.pinned = patch.pinned;
      if (patch.lastActivityAt !== undefined) row.lastActivityAt = patch.lastActivityAt;
      if (patch.isShownOnHistory !== undefined) row.isShownOnHistory = patch.isShownOnHistory;
      row.updatedAt = now;
      return copy(row);
    },

    async insertMessage(companyId, input) {
      const scope = requireCompanyId(companyId);
      if (!readBucket(conversations, scope).has(input.conversationId)) return null;
      const record: MessageRecord = {
        id: randomUUID(),
        companyId: scope,
        conversationId: input.conversationId,
        role: input.role,
        message: input.message,
        contentType: input.contentType ?? "text",
        uiSpec: input.uiSpec ? structuredClone(input.uiSpec) : null,
        mediaUrl: input.mediaUrl ?? null,
        mediaName: input.mediaName ?? null,
        isInternalNote: input.isInternalNote ?? false,
        readAt: null,
        createdAt: input.createdAt,
      };
      bucket(messages, scope).set(record.id, record);
      return copy(record);
    },

    async listMessages(companyId, conversationId) {
      return [...readBucket(messages, requireCompanyId(companyId)).values()]
        .filter((row) => row.conversationId === conversationId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(copy);
    },

    async markUserMessagesRead(companyId, conversationId, readAt) {
      let changed = 0;
      for (const row of readBucket(messages, requireCompanyId(companyId)).values()) {
        if (row.conversationId === conversationId && row.role === "user" && row.readAt === null) {
          row.readAt = readAt;
          changed += 1;
        }
      }
      return changed;
    },
  };
}

/**
 * Drizzle implementation of ChatbotStorage, backed by the chatbot tables in shared/schema.ts.
 *
 * Every query filters on company_id first. companyId comes from the verified request scope and is never
 * read from a body, query or params value. The database handle is resolved on first use, so importing
 * this module (for example in tests) does not require DATABASE_URL.
 */
export function createDrizzleChatbotStorage(database?: ChatbotDb): ChatbotStorage {
  let resolved: Promise<ChatbotDb> | undefined = database ? Promise.resolve(database) : undefined;
  const db = (): Promise<ChatbotDb> => {
    resolved ??= import("../../db.ts").then((mod) => mod.db as ChatbotDb);
    return resolved;
  };

  return {
    async insertChatbot(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      const [row] = await (await db())
        .insert(chatbots)
        .values({
          companyId: scope,
          title: input.title,
          language: input.language ?? "en",
          welcomeMessage: input.welcomeMessage ?? null,
          instructions: input.instructions ?? null,
          generativeUiEnabled: input.generativeUiEnabled ?? true,
          active: input.active ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toChatbot(row);
    },

    async findChatbot(companyId, id) {
      const [row] = await (await db())
        .select()
        .from(chatbots)
        .where(and(eq(chatbots.companyId, requireCompanyId(companyId)), eq(chatbots.id, id)))
        .limit(1);
      return row ? toChatbot(row) : null;
    },

    async listChatbots(companyId) {
      const rows = await (await db())
        .select()
        .from(chatbots)
        .where(eq(chatbots.companyId, requireCompanyId(companyId)))
        .orderBy(asc(chatbots.createdAt));
      return rows.map(toChatbot);
    },

    async updateChatbot(companyId, id, patch, now) {
      // Explicit allow-list: companyId and id are never written, so a patch cannot move a row to another company.
      const set: Partial<typeof chatbots.$inferInsert> = { updatedAt: now };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.language !== undefined) set.language = patch.language;
      if (patch.welcomeMessage !== undefined) set.welcomeMessage = patch.welcomeMessage;
      if (patch.instructions !== undefined) set.instructions = patch.instructions;
      if (patch.generativeUiEnabled !== undefined) set.generativeUiEnabled = patch.generativeUiEnabled;
      if (patch.active !== undefined) set.active = patch.active;
      const [row] = await (await db())
        .update(chatbots)
        .set(set)
        .where(and(eq(chatbots.companyId, requireCompanyId(companyId)), eq(chatbots.id, id)))
        .returning();
      return row ? toChatbot(row) : null;
    },

    async insertConversation(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      const [row] = await (await db())
        .insert(chatbotConversations)
        .values({
          companyId: scope,
          chatbotId: input.chatbotId,
          sessionId: input.sessionId,
          channel: input.channel ?? "web",
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toConversation(row);
    },

    async findConversation(companyId, id) {
      const [row] = await (await db())
        .select()
        .from(chatbotConversations)
        .where(and(eq(chatbotConversations.companyId, requireCompanyId(companyId)), eq(chatbotConversations.id, id)))
        .limit(1);
      return row ? toConversation(row) : null;
    },

    async listConversations(companyId) {
      const rows = await (await db())
        .select()
        .from(chatbotConversations)
        .where(eq(chatbotConversations.companyId, requireCompanyId(companyId)))
        .orderBy(asc(chatbotConversations.createdAt));
      return rows.map(toConversation);
    },

    async updateConversation(companyId, id, patch, now) {
      const set: Partial<typeof chatbotConversations.$inferInsert> = { updatedAt: now };
      if (patch.connectAgentAt !== undefined) set.connectAgentAt = patch.connectAgentAt;
      if (patch.ticketStatus !== undefined) set.ticketStatus = patch.ticketStatus;
      if (patch.pinned !== undefined) set.pinned = patch.pinned;
      if (patch.lastActivityAt !== undefined) set.lastActivityAt = patch.lastActivityAt;
      if (patch.isShownOnHistory !== undefined) set.isShownOnHistory = patch.isShownOnHistory;
      const [row] = await (await db())
        .update(chatbotConversations)
        .set(set)
        .where(and(eq(chatbotConversations.companyId, requireCompanyId(companyId)), eq(chatbotConversations.id, id)))
        .returning();
      return row ? toConversation(row) : null;
    },

    async insertMessage(companyId, input) {
      const scope = requireCompanyId(companyId);
      const database = await db();
      // Check ownership first so a foreign conversation returns null, not a foreign-key error.
      const [conversation] = await database
        .select({ id: chatbotConversations.id })
        .from(chatbotConversations)
        .where(and(eq(chatbotConversations.companyId, scope), eq(chatbotConversations.id, input.conversationId)))
        .limit(1);
      if (!conversation) return null;
      const [row] = await database
        .insert(chatbotMessages)
        .values({
          companyId: scope,
          conversationId: input.conversationId,
          role: input.role,
          message: input.message,
          contentType: input.contentType ?? "text",
          uiSpec: input.uiSpec ? structuredClone(input.uiSpec) : null,
          mediaUrl: input.mediaUrl ?? null,
          mediaName: input.mediaName ?? null,
          isInternalNote: input.isInternalNote ?? false,
          createdAt: input.createdAt,
        })
        .returning();
      return toMessage(row);
    },

    async listMessages(companyId, conversationId) {
      const rows = await (await db())
        .select()
        .from(chatbotMessages)
        .where(
          and(
            eq(chatbotMessages.companyId, requireCompanyId(companyId)),
            eq(chatbotMessages.conversationId, conversationId),
          ),
        )
        .orderBy(asc(chatbotMessages.createdAt));
      return rows.map(toMessage);
    },

    async markUserMessagesRead(companyId, conversationId, readAt) {
      const updated = await (await db())
        .update(chatbotMessages)
        .set({ readAt })
        .where(
          and(
            eq(chatbotMessages.companyId, requireCompanyId(companyId)),
            eq(chatbotMessages.conversationId, conversationId),
            eq(chatbotMessages.role, "user"),
            isNull(chatbotMessages.readAt),
          ),
        )
        .returning({ id: chatbotMessages.id });
      return updated.length;
    },
  };
}

type ChatbotRow = typeof chatbots.$inferSelect;
type ConversationDbRow = typeof chatbotConversations.$inferSelect;
type MessageDbRow = typeof chatbotMessages.$inferSelect;

function toChatbot(row: ChatbotRow): ChatbotRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    language: row.language,
    welcomeMessage: row.welcomeMessage,
    instructions: row.instructions,
    generativeUiEnabled: row.generativeUiEnabled,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConversation(row: ConversationDbRow): ConversationRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    sessionId: row.sessionId,
    channel: row.channel,
    connectAgentAt: row.connectAgentAt,
    isShownOnHistory: row.isShownOnHistory,
    ticketStatus: row.ticketStatus as TicketStatus,
    pinned: row.pinned,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: MessageDbRow): MessageRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    conversationId: row.conversationId,
    role: row.role as ChatbotMessageRole,
    message: row.message,
    contentType: row.contentType as MessageContentType,
    uiSpec: row.uiSpec,
    mediaUrl: row.mediaUrl,
    mediaName: row.mediaName,
    isInternalNote: row.isInternalNote,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
