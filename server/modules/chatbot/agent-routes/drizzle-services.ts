/*
 * Drizzle implementation of the staff reply store, and the adapter that connects the inbox service to the
 * agent router. Replaces the in-memory services in production wiring. memory-services.ts keeps its
 * interfaces and is still used by the tests.
 *
 * Tenancy: every query filters on company_id, and companyId is the first argument of every method.
 * Customer reads go through customerVisibleMessages, so internal notes are dropped in SQL and again in code.
 *
 * Writes that go through the inbox service (handoff, handback, close) keep the inbox's rules and events.
 * The inbox service does not know the staff member who handled the chat, so the staff id is written to the
 * side table after the inbox call (see DECISIONS.md, Drizzle section, for the non-atomic gap).
 *
 * Only type imports come from ../inbox. The adapter needs InboxService and nothing else from it at runtime.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../shared/schema.ts";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import { chatbotInboxConversationStates, chatbotInboxMessageStaff } from "../db/inbox.ts";
import {
  buildSelectConversation,
  buildUpsertConversationState,
  mapConversation,
  type ConversationJoinRow,
  type InboxDb,
} from "../inbox/drizzle-storage.ts";
import type { InboxConversation } from "../inbox/types.ts";
import type { InboxService } from "../inbox/inbox-service.ts";
import { customerVisibleMessages, type CustomerMessageView } from "./customer-view.ts";
import type {
  AgentConversation,
  AgentConversationService,
  AgentHandler,
  AgentInboxService,
  AgentMessage,
  ConversationWithMessages,
  InboxPage,
  InboxQuery,
  StaffMessageInput,
} from "./contracts.ts";

const { chatbotConversations, chatbotMessages } = schema;
const messageStaff = chatbotInboxMessageStaff;
const stateTable = chatbotInboxConversationStates;

type FullDb = NodePgDatabase<typeof schema>;
type MessageRow = typeof chatbotMessages.$inferSelect;
export type MessageJoinRow = { msg: MessageRow; staffId: string | null };

/** The reads and writes the adapter needs. Implemented by createDrizzleAgentStore. */
export interface AgentConversationStore {
  /** Staff view: includes internal notes, each flagged. Null when the conversation is not in this company. */
  getConversation(companyId: string, conversationId: string): Promise<ConversationWithMessages | null>;
  /** Conversation without messages. Null when the conversation is not in this company. */
  getConversationHeader(companyId: string, conversationId: string): Promise<AgentConversation | null>;
  /** Customer-facing read. Internal notes are excluded in SQL and again by customerVisibleMessages. */
  readCustomerView(companyId: string, conversationId: string): Promise<CustomerMessageView[]>;
  appendStaffMessage(companyId: string, input: StaffMessageInput): Promise<AgentMessage | null>;
  /** Records the staff member who holds the chat. Null clears it. A conversation outside the company is ignored. */
  setHandlerStaff(companyId: string, conversationId: string, staffId: string | null): Promise<void>;
  /** Handler staff id per conversation id, for the ids in this company. Missing ids map to null. */
  handlerStaffIds(companyId: string, conversationIds: readonly string[]): Promise<Map<string, string | null>>;
}

// ---------- builders (pure, rendered to SQL in the tests) ----------

/** Messages of one conversation, oldest first. customerOnly adds the internal-note predicate. */
export function buildSelectMessages(db: InboxDb, companyId: string, conversationId: string, customerOnly: boolean) {
  const conditions = [eq(chatbotMessages.companyId, companyId), eq(chatbotMessages.conversationId, conversationId)];
  if (customerOnly) conditions.push(eq(chatbotMessages.isInternalNote, false));
  return db
    .select({ msg: chatbotMessages, staffId: messageStaff.staffId })
    .from(chatbotMessages)
    .leftJoin(
      messageStaff,
      and(eq(messageStaff.companyId, chatbotMessages.companyId), eq(messageStaff.messageId, chatbotMessages.id)),
    )
    .where(and(...conditions))
    .orderBy(asc(chatbotMessages.createdAt), asc(chatbotMessages.id));
}

export function buildHandlerStaffIds(db: InboxDb, companyId: string, conversationIds: readonly string[]) {
  return db
    .select({ id: chatbotConversations.id, handlerStaffId: stateTable.handlerStaffId })
    .from(chatbotConversations)
    .leftJoin(
      stateTable,
      and(
        eq(stateTable.companyId, chatbotConversations.companyId),
        eq(stateTable.conversationId, chatbotConversations.id),
      ),
    )
    .where(and(eq(chatbotConversations.companyId, companyId), inArray(chatbotConversations.id, [...conversationIds])));
}

// ---------- row mapping ----------

export function toAgentMessage(row: MessageJoinRow): AgentMessage {
  return {
    id: row.msg.id,
    conversationId: row.msg.conversationId,
    role: row.msg.role as AgentMessage["role"],
    message: row.msg.message,
    isInternalNote: row.msg.isInternalNote,
    staffId: row.staffId,
    createdAt: row.msg.createdAt,
  };
}

/** Customer read path: the SQL predicate has already dropped notes, and customerVisibleMessages drops them again. */
export function mapCustomerRows(rows: readonly MessageJoinRow[]): CustomerMessageView[] {
  return customerVisibleMessages(rows.map(toAgentMessage));
}

function toAgentConversation(row: ConversationJoinRow): AgentConversation {
  return {
    id: row.conv.id,
    companyId: row.conv.companyId,
    chatbotId: row.conv.chatbotId,
    channel: row.conv.channel,
    handler: row.conv.connectAgentAt === null ? "ai" : "human",
    ticketStatus: row.conv.ticketStatus as AgentConversation["ticketStatus"],
    handlerStaffId: row.state?.handlerStaffId ?? null,
    updatedAt: row.conv.updatedAt,
  };
}

function fromInboxConversation(conv: InboxConversation, handlerStaffId: string | null): AgentConversation {
  return {
    id: conv.id,
    companyId: conv.companyId,
    chatbotId: conv.chatbotId,
    channel: conv.channel,
    handler: conv.connectAgentAt === null ? "ai" : "human",
    ticketStatus: conv.ticketStatus,
    handlerStaffId,
    updatedAt: conv.lastActivityAt,
  };
}

// ---------- store ----------

let cachedDb: Promise<FullDb> | undefined;

export function createDrizzleAgentStore(database?: FullDb): AgentConversationStore {
  const db = (): Promise<FullDb> => {
    if (database) return Promise.resolve(database);
    cachedDb ??= import("../../../db.ts").then((mod) => mod.db as FullDb);
    return cachedDb;
  };

  async function header(companyId: string, conversationId: string): Promise<AgentConversation | null> {
    const rows = await buildSelectConversation(await db(), companyId, conversationId);
    return rows[0] ? toAgentConversation(rows[0]) : null;
  }

  return {
    async getConversation(companyIdRaw, conversationId) {
      const companyId = requireCompanyId(companyIdRaw);
      const d = await db();
      const found = await buildSelectConversation(d, companyId, conversationId);
      if (!found[0]) return null;
      const rows = await buildSelectMessages(d, companyId, conversationId, false);
      return { conversation: toAgentConversation(found[0]), messages: rows.map(toAgentMessage) };
    },

    async getConversationHeader(companyIdRaw, conversationId) {
      return header(requireCompanyId(companyIdRaw), conversationId);
    },

    async readCustomerView(companyIdRaw, conversationId) {
      const rows = await buildSelectMessages(await db(), requireCompanyId(companyIdRaw), conversationId, true);
      return mapCustomerRows(rows);
    },

    async appendStaffMessage(companyIdRaw, input) {
      const companyId = requireCompanyId(companyIdRaw);
      const d = await db();
      // One transaction, so the message, its staff row and the activity time are written together or not at all.
      return d.transaction(async (tx) => {
        const found = await buildSelectConversation(tx, companyId, input.conversationId);
        if (!found[0]) return null;
        const now = new Date();
        const [created] = await tx
          .insert(chatbotMessages)
          .values({
            companyId,
            conversationId: input.conversationId,
            role: "assistant",
            message: input.message,
            isInternalNote: input.isInternalNote,
            createdAt: now,
          })
          .returning();
        await tx.insert(messageStaff).values({
          companyId,
          conversationId: input.conversationId,
          messageId: created.id,
          staffId: input.staffId,
        });
        await tx
          .update(chatbotConversations)
          .set({ lastActivityAt: now, updatedAt: now })
          .where(and(eq(chatbotConversations.companyId, companyId), eq(chatbotConversations.id, input.conversationId)));
        return toAgentMessage({ msg: created, staffId: input.staffId });
      });
    },

    async setHandlerStaff(companyIdRaw, conversationId, staffId) {
      const companyId = requireCompanyId(companyIdRaw);
      const d = await db();
      if (!(await buildSelectConversation(d, companyId, conversationId))[0]) return;
      await buildUpsertConversationState(d, companyId, conversationId, { handlerStaffId: staffId });
    },

    async handlerStaffIds(companyIdRaw, conversationIds) {
      const companyId = requireCompanyId(companyIdRaw);
      const result = new Map<string, string | null>();
      if (conversationIds.length === 0) return result;
      const rows = await buildHandlerStaffIds(await db(), companyId, conversationIds);
      for (const row of rows) result.set(row.id, row.handlerStaffId ?? null);
      return result;
    },
  };
}

// ---------- adapter: inbox service -> agent router ----------

export interface InboxAgentServicesDeps {
  /** The inbox service. It must be created with enabled: true, otherwise every call answers 503. */
  inbox: Pick<InboxService, "query" | "handoffToHuman" | "handBackToAi" | "setTicketStatus">;
  store: AgentConversationStore;
}

export interface InboxAgentServices {
  inbox: AgentInboxService;
  conversations: AgentConversationService;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ChatbotError && err.status === 404;
}

/**
 * Builds the two services the agent router takes. Inbox reads and handoff or close writes go through the
 * inbox service, so its rules, its conditional writes and its events all apply. Message reads and writes go
 * through the store. A conversation that is not in the company resolves to null, as the router expects.
 */
export function createInboxAgentServices(deps: InboxAgentServicesDeps): InboxAgentServices {
  const inbox: AgentInboxService = {
    async listInbox(companyId: string, query: InboxQuery): Promise<InboxPage> {
      const page = await deps.inbox.query(companyId, {
        handler: query.handler,
        status: query.ticketStatus ?? "all",
        q: query.search,
        page: query.page,
        perPage: query.perPage,
      });
      const staff = await deps.store.handlerStaffIds(
        companyId,
        page.data.map((conv) => conv.id),
      );
      return {
        items: page.data.map((conv) => fromInboxConversation(conv, staff.get(conv.id) ?? null)),
        page: page.page,
        perPage: page.perPage,
        total: page.total,
      };
    },
  };

  const conversations: AgentConversationService = {
    getConversation(companyId, conversationId) {
      return deps.store.getConversation(companyId, conversationId);
    },

    appendStaffMessage(companyId, input) {
      return deps.store.appendStaffMessage(companyId, input);
    },

    async setHandler(companyId: string, conversationId: string, handler: AgentHandler, staffId: string) {
      try {
        if (handler === "human") {
          await deps.inbox.handoffToHuman(companyId, conversationId, { id: staffId });
        } else {
          await deps.inbox.handBackToAi(companyId, conversationId, { id: staffId });
        }
      } catch (err: unknown) {
        if (isNotFound(err)) return null;
        throw err;
      }
      // The inbox service does not record who handled the chat, so the store does. Runs even when the state
      // did not change, so the latest staff member is recorded, as the in-memory service does.
      await deps.store.setHandlerStaff(companyId, conversationId, handler === "human" ? staffId : null);
      return deps.store.getConversationHeader(companyId, conversationId);
    },

    async setTicketStatus(companyId: string, conversationId: string, status: "closed", staffId: string) {
      try {
        await deps.inbox.setTicketStatus(companyId, conversationId, status, { id: staffId });
      } catch (err: unknown) {
        if (isNotFound(err)) return null;
        throw err;
      }
      return deps.store.getConversationHeader(companyId, conversationId);
    },
  };

  return { inbox, conversations };
}
