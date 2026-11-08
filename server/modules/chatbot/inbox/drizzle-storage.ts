/*
 * Drizzle InboxStorage. Implements the same port as InMemoryInboxStorage, and the port's rules still hold:
 * every method takes companyId first, reads and writes only rows that carry it, and returns null or
 * false for a row that belongs to another company.
 *
 * Each query is built by an exported builder function. The methods run the builders, and the tests render
 * the builders to SQL with PgDialect without connecting to a database. Builders never execute.
 *
 * Parent tables come from shared/schema.ts. Assignee, priority and the handling staff member live in
 * chatbot_inbox_conversation_states (see ../db/inbox.ts).
 *
 * Differences from the in-memory store (recorded in DECISIONS.md, Drizzle section):
 *   - name and summary do not exist on chatbot_conversations, so they read as null. The q filter matches
 *     message text instead, which is what the staff agent contract searches.
 *   - Timestamps are compared at millisecond precision, so a cursor taken from a JS Date still matches its own row.
 */
import { and, asc, count, desc, eq, exists, gt, gte, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../shared/schema.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  chatbotInboxConversationStates,
  chatbotInboxParticipants,
  chatbotInboxPresence,
} from "../db/inbox.ts";
import type { ConversationStatePatch, HandlerTransition, InboxStorage } from "./ports.ts";
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

const { chatbotConversations, chatbotMessages } = schema;

type FullDb = NodePgDatabase<typeof schema>;
/** The subset of the query API the builders use. A transaction satisfies it too. */
export type InboxDb = Pick<FullDb, "select" | "insert" | "update" | "delete">;

export type ConversationRow = typeof chatbotConversations.$inferSelect;
export type ConversationStateRow = typeof chatbotInboxConversationStates.$inferSelect;
export type ConversationJoinRow = { conv: ConversationRow; state: ConversationStateRow | null };
export type ParticipantRow = typeof chatbotInboxParticipants.$inferSelect;
export type PresenceRow = typeof chatbotInboxPresence.$inferSelect;

const states = chatbotInboxConversationStates;
const participants = chatbotInboxParticipants;
const presence = chatbotInboxPresence;

/** Truncates to milliseconds so a cursor built from a JS Date compares equal to its own row. */
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${chatbotMessages.createdAt})`;

/** Binds a Date as an ISO string with an explicit cast. timestamp without time zone ignores the zone, and the stored values are UTC. */
function isoTs(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

const stateJoin = and(
  eq(states.companyId, chatbotConversations.companyId),
  eq(states.conversationId, chatbotConversations.id),
);

// ---------- read builders ----------

export function buildSelectConversation(db: InboxDb, companyId: string, conversationId: string) {
  return db
    .select({ conv: chatbotConversations, state: states })
    .from(chatbotConversations)
    .leftJoin(states, stateJoin)
    .where(and(eq(chatbotConversations.companyId, companyId), eq(chatbotConversations.id, conversationId)))
    .limit(1);
}

/** The q filter: message text, matched literally (strpos, so no LIKE wildcards). */
function messageTextMatches(db: InboxDb, needle: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(chatbotMessages)
      .where(
        and(
          eq(chatbotMessages.companyId, chatbotConversations.companyId),
          eq(chatbotMessages.conversationId, chatbotConversations.id),
          sql`strpos(lower(${chatbotMessages.message}), ${needle}) > 0`,
        ),
      ),
  );
}

/** At least one inbound (role user) message that no staff member has read, and that is not an internal note. */
function hasUnreadInbound(db: InboxDb): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(chatbotMessages)
      .where(
        and(
          eq(chatbotMessages.companyId, chatbotConversations.companyId),
          eq(chatbotMessages.conversationId, chatbotConversations.id),
          eq(chatbotMessages.role, "user"),
          isNull(chatbotMessages.readAt),
          eq(chatbotMessages.isInternalNote, false),
        ),
      ),
  );
}

function handlerCondition(handler: Handler | "all"): SQL | undefined {
  if (handler === "ai") return isNull(chatbotConversations.connectAgentAt);
  if (handler === "human") return isNotNull(chatbotConversations.connectAgentAt);
  return undefined;
}

function listConditions(db: InboxDb, companyId: string, filter: InboxFilter): SQL[] {
  const conditions: SQL[] = [eq(chatbotConversations.companyId, companyId)];
  const handler = handlerCondition(filter.handler);
  if (handler) conditions.push(handler);
  if (filter.q !== null) conditions.push(messageTextMatches(db, filter.q.toLowerCase()));
  if (filter.assignedTo !== null) conditions.push(eq(states.assignedTo, filter.assignedTo));
  if (filter.priority !== null) conditions.push(sql`coalesce(${states.priority}, 'normal') = ${filter.priority}`);
  if (filter.status !== null) conditions.push(eq(chatbotConversations.ticketStatus, filter.status));
  if (filter.unread) conditions.push(hasUnreadInbound(db));
  return conditions;
}

export function buildListConversationRows(db: InboxDb, companyId: string, filter: InboxFilter) {
  return db
    .select({ conv: chatbotConversations, state: states })
    .from(chatbotConversations)
    .leftJoin(states, stateJoin)
    .where(and(...listConditions(db, companyId, filter)))
    .orderBy(desc(chatbotConversations.lastActivityAt), asc(chatbotConversations.id))
    .limit(filter.limit)
    .offset(filter.offset);
}

export function buildCountConversations(db: InboxDb, companyId: string, filter: InboxFilter) {
  return db
    .select({ total: count() })
    .from(chatbotConversations)
    .leftJoin(states, stateJoin)
    .where(and(...listConditions(db, companyId, filter)));
}

export function buildCountUnreadConversations(db: InboxDb, companyId: string, handler: Handler | "all") {
  return db
    .select({ total: count() })
    .from(chatbotConversations)
    .where(and(eq(chatbotConversations.companyId, companyId), handlerCondition(handler), hasUnreadInbound(db)));
}

export function buildLatestMessageCursor(db: InboxDb, companyId: string, conversationId: string) {
  return db
    .select({ createdAt: createdAtMs, id: chatbotMessages.id })
    .from(chatbotMessages)
    .where(and(eq(chatbotMessages.companyId, companyId), eq(chatbotMessages.conversationId, conversationId)))
    .orderBy(desc(createdAtMs), desc(chatbotMessages.id))
    .limit(1);
}

export function buildFindMessageCursor(db: InboxDb, companyId: string, conversationId: string, messageId: string) {
  return db
    .select({ createdAt: createdAtMs, id: chatbotMessages.id })
    .from(chatbotMessages)
    .where(
      and(
        eq(chatbotMessages.companyId, companyId),
        eq(chatbotMessages.conversationId, conversationId),
        eq(chatbotMessages.id, messageId),
      ),
    )
    .limit(1);
}

export function buildCountMessagesAfter(
  db: InboxDb,
  companyId: string,
  conversationId: string,
  cursor: MessageCursor | null,
) {
  const conditions: SQL[] = [
    eq(chatbotMessages.companyId, companyId),
    eq(chatbotMessages.conversationId, conversationId),
  ];
  if (cursor !== null) {
    const after = or(
      sql`${createdAtMs} > ${isoTs(cursor.createdAt)}`,
      and(sql`${createdAtMs} = ${isoTs(cursor.createdAt)}`, gt(chatbotMessages.id, cursor.id)),
    );
    if (after) conditions.push(after);
  }
  return db
    .select({ total: count() })
    .from(chatbotMessages)
    .where(and(...conditions));
}

export function buildFindParticipantByKey(
  db: InboxDb,
  companyId: string,
  conversationId: string,
  type: string,
  reference: string | null,
) {
  return db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.companyId, companyId),
        eq(participants.conversationId, conversationId),
        eq(participants.type, type),
        // Matches the coalesce() unique index, so a null reference compares equal to another null.
        sql`coalesce(${participants.reference}, '') = ${reference ?? ""}`,
      ),
    )
    .limit(1);
}

export function buildGetParticipant(db: InboxDb, companyId: string, conversationId: string, participantId: string) {
  return db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.companyId, companyId),
        eq(participants.conversationId, conversationId),
        eq(participants.id, participantId),
      ),
    )
    .limit(1);
}

export function buildListParticipants(db: InboxDb, companyId: string, conversationId: string) {
  return db
    .select()
    .from(participants)
    .where(and(eq(participants.companyId, companyId), eq(participants.conversationId, conversationId)))
    .orderBy(asc(participants.type), asc(participants.displayName));
}

export function buildGetPresence(db: InboxDb, companyId: string, conversationId: string, participantKey: string) {
  return db
    .select()
    .from(presence)
    .where(
      and(
        eq(presence.companyId, companyId),
        eq(presence.conversationId, conversationId),
        eq(presence.participantKey, participantKey),
      ),
    )
    .limit(1);
}

export function buildListPresenceSince(db: InboxDb, companyId: string, conversationId: string, since: Date) {
  return db
    .select()
    .from(presence)
    .where(
      and(
        eq(presence.companyId, companyId),
        eq(presence.conversationId, conversationId),
        gte(presence.lastSeenAt, since),
      ),
    );
}

// ---------- write builders ----------

export function buildSetHandler(db: InboxDb, companyId: string, conversationId: string, to: Handler, connectedAt: Date) {
  const where =
    to === "human"
      ? and(
          eq(chatbotConversations.companyId, companyId),
          eq(chatbotConversations.id, conversationId),
          isNull(chatbotConversations.connectAgentAt),
        )
      : and(
          eq(chatbotConversations.companyId, companyId),
          eq(chatbotConversations.id, conversationId),
          isNotNull(chatbotConversations.connectAgentAt),
        );
  return db
    .update(chatbotConversations)
    .set({ connectAgentAt: to === "human" ? connectedAt : null, updatedAt: new Date() })
    .where(where)
    .returning({ id: chatbotConversations.id });
}

export function buildSetTicketStatus(db: InboxDb, companyId: string, conversationId: string, status: TicketStatus) {
  return db
    .update(chatbotConversations)
    .set({ ticketStatus: status, updatedAt: new Date() })
    .where(and(eq(chatbotConversations.companyId, companyId), eq(chatbotConversations.id, conversationId)))
    .returning({ id: chatbotConversations.id });
}

export interface ConversationStateWrite {
  assignedTo?: string | null;
  priority?: InboxPriority;
  handlerStaffId?: string | null;
}

/** Creates the state row on first write, then updates only the keys the caller set. */
export function buildUpsertConversationState(
  db: InboxDb,
  companyId: string,
  conversationId: string,
  patch: ConversationStateWrite,
) {
  const now = new Date();
  const set: { assignedTo?: string | null; priority?: InboxPriority; handlerStaffId?: string | null; updatedAt: Date } = {
    updatedAt: now,
  };
  if ("assignedTo" in patch) set.assignedTo = patch.assignedTo ?? null;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if ("handlerStaffId" in patch) set.handlerStaffId = patch.handlerStaffId ?? null;

  return db
    .insert(states)
    .values({
      companyId,
      conversationId,
      assignedTo: patch.assignedTo ?? null,
      priority: patch.priority ?? "normal",
      handlerStaffId: patch.handlerStaffId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: [states.companyId, states.conversationId], set });
}

export function buildUpsertParticipant(db: InboxDb, companyId: string, row: InboxParticipant) {
  const now = new Date();
  return db
    .insert(participants)
    .values({
      id: row.id,
      companyId,
      conversationId: row.conversationId,
      type: row.type,
      reference: row.reference,
      displayName: row.displayName,
      metadata: row.metadata,
      lastSeenAt: row.lastSeenAt,
      lastReadMessageId: row.lastReadMessageId,
      lastReadMessageCreatedAt: row.lastReadMessageCreatedAt,
      lastReadAt: row.lastReadAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: participants.id,
      set: {
        conversationId: row.conversationId,
        type: row.type,
        reference: row.reference,
        displayName: row.displayName,
        metadata: row.metadata,
        lastSeenAt: row.lastSeenAt,
        lastReadMessageId: row.lastReadMessageId,
        lastReadMessageCreatedAt: row.lastReadMessageCreatedAt,
        lastReadAt: row.lastReadAt,
        updatedAt: now,
      },
      // A row with this id that belongs to another company is left alone, and the caller sees zero rows back.
      setWhere: eq(participants.companyId, companyId),
    })
    .returning({ id: participants.id });
}

export function buildDeleteParticipant(db: InboxDb, companyId: string, conversationId: string, participantId: string) {
  return db
    .delete(participants)
    .where(
      and(
        eq(participants.companyId, companyId),
        eq(participants.conversationId, conversationId),
        eq(participants.id, participantId),
      ),
    )
    .returning({ id: participants.id });
}

export function buildUpsertPresence(db: InboxDb, companyId: string, row: InboxPresence) {
  return db
    .insert(presence)
    .values({
      companyId,
      conversationId: row.conversationId,
      participantKey: row.participantKey,
      state: row.state,
      lastSeenAt: row.lastSeenAt,
      metadata: row.metadata,
    })
    .onConflictDoUpdate({
      target: [presence.companyId, presence.conversationId, presence.participantKey],
      set: { state: row.state, lastSeenAt: row.lastSeenAt, metadata: row.metadata },
    });
}

// ---------- row mapping ----------

export function mapConversation(row: ConversationJoinRow): InboxConversation {
  return {
    companyId: row.conv.companyId,
    id: row.conv.id,
    chatbotId: row.conv.chatbotId,
    name: null,
    summary: null,
    channel: row.conv.channel,
    connectAgentAt: row.conv.connectAgentAt,
    ticketStatus: row.conv.ticketStatus as TicketStatus,
    assignedTo: row.state?.assignedTo ?? null,
    priority: (row.state?.priority ?? "normal") as InboxPriority,
    lastActivityAt: row.conv.lastActivityAt,
  };
}

export function mapParticipant(row: ParticipantRow): InboxParticipant {
  return {
    companyId: row.companyId,
    id: row.id,
    conversationId: row.conversationId,
    type: row.type,
    reference: row.reference,
    displayName: row.displayName,
    metadata: { ...(row.metadata ?? {}) },
    lastSeenAt: row.lastSeenAt,
    lastReadMessageId: row.lastReadMessageId,
    lastReadMessageCreatedAt: row.lastReadMessageCreatedAt,
    lastReadAt: row.lastReadAt,
  };
}

export function mapPresence(row: PresenceRow): InboxPresence {
  return {
    companyId: row.companyId,
    conversationId: row.conversationId,
    participantKey: row.participantKey,
    state: row.state as InboxPresence["state"],
    lastSeenAt: row.lastSeenAt,
    metadata: { ...(row.metadata ?? {}) },
  };
}

// ---------- storage ----------

let cachedDb: Promise<FullDb> | undefined;

/**
 * Creates the storage over a drizzle database. With no argument, the shared database from server/db.ts
 * is loaded on first use, so importing this module never connects.
 */
export function createDrizzleInboxStorage(database?: FullDb): InboxStorage {
  const db = (): Promise<FullDb> => {
    if (database) return Promise.resolve(database);
    cachedDb ??= import("../../../db.ts").then((mod) => mod.db as FullDb);
    return cachedDb;
  };

  async function loadConversation(companyId: string, conversationId: string): Promise<InboxConversation | null> {
    const rows = await buildSelectConversation(await db(), companyId, conversationId);
    return rows[0] ? mapConversation(rows[0]) : null;
  }

  return {
    async getConversation(companyIdRaw, conversationId) {
      return loadConversation(requireCompanyId(companyIdRaw), conversationId);
    },

    async transitionHandler(companyIdRaw, conversationId, to, connectedAt): Promise<HandlerTransition | null> {
      const companyId = requireCompanyId(companyIdRaw);
      const d = await db();
      const written = await buildSetHandler(d, companyId, conversationId, to, connectedAt);
      const conversation = await loadConversation(companyId, conversationId);
      if (!conversation) return null;
      if (written.length > 0) {
        return { applied: true, from: to === "human" ? "ai" : "human", conversation };
      }
      // Nothing matched the condition: the conversation was already in the requested state.
      return { applied: false, from: to, conversation };
    },

    async listConversations(companyIdRaw, filter) {
      const companyId = requireCompanyId(companyIdRaw);
      const d = await db();
      const rows = await buildListConversationRows(d, companyId, filter);
      const [totals] = await buildCountConversations(d, companyId, filter);
      return { rows: rows.map(mapConversation), total: Number(totals?.total ?? 0) };
    },

    async saveConversationState(companyIdRaw, conversationId, patch: ConversationStatePatch) {
      const companyId = requireCompanyId(companyIdRaw);
      const d = await db();
      if (!(await loadConversation(companyId, conversationId))) return null;

      if ("ticketStatus" in patch && patch.ticketStatus !== undefined) {
        await buildSetTicketStatus(d, companyId, conversationId, patch.ticketStatus);
      }
      const stateWrite: ConversationStateWrite = {};
      if ("assignedTo" in patch) stateWrite.assignedTo = patch.assignedTo ?? null;
      if (patch.priority !== undefined) stateWrite.priority = patch.priority;
      if (Object.keys(stateWrite).length > 0) {
        await buildUpsertConversationState(d, companyId, conversationId, stateWrite);
      }
      return loadConversation(companyId, conversationId);
    },

    async countConversationsWithUnreadInbound(companyIdRaw, handler) {
      const [totals] = await buildCountUnreadConversations(await db(), requireCompanyId(companyIdRaw), handler);
      return Number(totals?.total ?? 0);
    },

    async latestMessageCursor(companyIdRaw, conversationId) {
      const rows = await buildLatestMessageCursor(await db(), requireCompanyId(companyIdRaw), conversationId);
      return rows[0] ? { createdAt: rows[0].createdAt, id: rows[0].id } : null;
    },

    async findMessageCursor(companyIdRaw, conversationId, messageId) {
      const rows = await buildFindMessageCursor(await db(), requireCompanyId(companyIdRaw), conversationId, messageId);
      return rows[0] ? { createdAt: rows[0].createdAt, id: rows[0].id } : null;
    },

    async countMessagesAfter(companyIdRaw, conversationId, cursor) {
      const [totals] = await buildCountMessagesAfter(await db(), requireCompanyId(companyIdRaw), conversationId, cursor);
      return Number(totals?.total ?? 0);
    },

    async findParticipantByKey(companyIdRaw, conversationId, type, reference) {
      const rows = await buildFindParticipantByKey(await db(), requireCompanyId(companyIdRaw), conversationId, type, reference);
      return rows[0] ? mapParticipant(rows[0]) : null;
    },

    async getParticipant(companyIdRaw, conversationId, participantId) {
      const rows = await buildGetParticipant(await db(), requireCompanyId(companyIdRaw), conversationId, participantId);
      return rows[0] ? mapParticipant(rows[0]) : null;
    },

    async saveParticipant(companyIdRaw, participant) {
      const companyId = requireCompanyId(companyIdRaw);
      if (participant.companyId !== companyId) {
        throw new Error("inbox storage: participant companyId does not match the scope it was saved under");
      }
      const written = await buildUpsertParticipant(await db(), companyId, participant);
      if (written.length === 0) {
        throw new Error("inbox storage: participant id is held by another company");
      }
    },

    async listParticipants(companyIdRaw, conversationId) {
      const rows = await buildListParticipants(await db(), requireCompanyId(companyIdRaw), conversationId);
      return rows.map(mapParticipant);
    },

    async deleteParticipant(companyIdRaw, conversationId, participantId) {
      const removed = await buildDeleteParticipant(await db(), requireCompanyId(companyIdRaw), conversationId, participantId);
      return removed.length > 0;
    },

    async getPresence(companyIdRaw, conversationId, participantKey) {
      const rows = await buildGetPresence(await db(), requireCompanyId(companyIdRaw), conversationId, participantKey);
      return rows[0] ? mapPresence(rows[0]) : null;
    },

    async savePresence(companyIdRaw, row) {
      const companyId = requireCompanyId(companyIdRaw);
      if (row.companyId !== companyId) {
        throw new Error("inbox storage: presence companyId does not match the scope it was saved under");
      }
      await buildUpsertPresence(await db(), companyId, row);
    },

    async listPresenceSince(companyIdRaw, conversationId, since) {
      const rows = await buildListPresenceSince(await db(), requireCompanyId(companyIdRaw), conversationId, since);
      return rows.map(mapPresence);
    },
  };
}
