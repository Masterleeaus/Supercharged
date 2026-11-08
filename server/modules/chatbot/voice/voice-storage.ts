/**
 * Voice session storage: the port, an in-memory implementation for tests, and a Drizzle implementation.
 *
 * Every method takes companyId first. A row whose company_id differs is absent: get returns null, and the
 * mutating methods return null or a not_found result. Nothing here stores audio.
 *
 * The seconds limit is enforced inside reserve(), as one conditional UPDATE (Drizzle) or one synchronous check
 * (memory). Two turns that race cannot both fit in the remaining time.
 *
 * end() writes the session-ended OutboxEvent in the same transaction as the state change, and only when this call
 * is the one that ends the session. Two ends therefore write one event.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { chatbotEventOutbox } from "../db/events.ts";
import { chatbotVoiceSessions, chatbotVoiceTurns } from "../db/voice.ts";
import { buildSessionEndedEvent, type NewOutboxEvent } from "./outbox.ts";

export const VOICE_SESSION_STATUSES = ["active", "ended"] as const;
export type VoiceSessionStatus = (typeof VOICE_SESSION_STATUSES)[number];

/** customer: the caller ended it. limit_reached: the seconds ran out. failed: the turn pipeline failed. idle: no turn for the idle timeout. */
export const VOICE_END_REASONS = ["customer", "limit_reached", "failed", "idle"] as const;
export type VoiceEndReason = (typeof VOICE_END_REASONS)[number];

export interface VoiceSessionRecord {
  id: string;
  companyId: string;
  chatbotId: string;
  conversationId: string;
  status: VoiceSessionStatus;
  endReason: VoiceEndReason | null;
  /** Plan limit for this session in milliseconds. Null when unlimited. Copied from the plan at start. */
  limitMs: number | null;
  usedMs: number;
  turnCount: number;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  /** Last activity: moved by every reserve, release and end. The idle timeout is measured from it. */
  updatedAt: Date;
}

export interface NewVoiceSession {
  id: string;
  chatbotId: string;
  conversationId: string;
  limitMs: number | null;
  startedAt: Date;
}

export interface VoiceTurnRecord {
  seq: number;
  durationMs: number | null;
  customerMessageId: string;
  assistantMessageId: string | null;
}

export type ReserveFailure = "not_found" | "session_ended" | "limit_reached";

export type ReserveResult = { ok: true; seq: number; session: VoiceSessionRecord } | { ok: false; reason: ReserveFailure };

export interface VoiceSessionStorage {
  create(companyId: string, input: NewVoiceSession): Promise<VoiceSessionRecord>;
  get(companyId: string, sessionId: string): Promise<VoiceSessionRecord | null>;
  /**
   * Atomically adds durationMs to the session and takes the next turn sequence number. Fails when the session is
   * missing (not_found), already ended (session_ended), or the duration would pass the limit (limit_reached).
   * The session is not changed on failure.
   */
  reserve(companyId: string, sessionId: string, durationMs: number): Promise<ReserveResult>;
  /** Gives back durationMs taken by a reserve() whose turn did not produce a reply. Never below zero. */
  release(companyId: string, sessionId: string, durationMs: number): Promise<void>;
  /**
   * Moves an active session to ended and writes one session-ended OutboxEvent in the same transaction. An ended
   * session keeps its first endedAt and endReason. Null when missing.
   */
  end(companyId: string, sessionId: string, reason: VoiceEndReason, at: Date): Promise<VoiceSessionRecord | null>;
  /** Active sessions of one company whose last activity is at or before cutoff, oldest first. */
  listIdle(companyId: string, cutoff: Date, limit: number): Promise<VoiceSessionRecord[]>;
  recordTurn(companyId: string, sessionId: string, turn: VoiceTurnRecord): Promise<void>;
}

/** Shared rule for reasons: decided from the row as it is now. */
export function reasonForFailedReserve(row: VoiceSessionRecord | null): ReserveFailure {
  if (row === null) return "not_found";
  if (row.status === "ended") return "session_ended";
  return "limit_reached";
}

// ---------------------------------------------------------------------------
// In-memory storage (tests and local use). Keys include companyId, so cross-tenant reads miss.
// ---------------------------------------------------------------------------

export interface MemoryVoiceSessionStorageOptions {
  /** Clock for updatedAt and endedAt bookkeeping. Tests pass a fixed clock. */
  now?: () => Date;
}

export type MemoryOutboxRow = NewOutboxEvent & { id: string };

export function createMemoryVoiceSessionStorage(options: MemoryVoiceSessionStorageOptions = {}): VoiceSessionStorage & {
  turnsFor(companyId: string, sessionId: string): VoiceTurnRecord[];
  outboxEvents(companyId: string): MemoryOutboxRow[];
} {
  const sessions = new Map<string, VoiceSessionRecord>();
  const turns = new Map<string, VoiceTurnRecord[]>();
  const outbox: MemoryOutboxRow[] = [];
  const clock = options.now ?? (() => new Date());
  const key = (companyId: string, id: string) => `${companyId}\u0000${id}`;

  const readRow = (companyId: string, sessionId: string) => sessions.get(key(companyId, sessionId)) ?? null;

  return {
    async create(companyId, input) {
      const now = input.startedAt;
      const record: VoiceSessionRecord = {
        id: input.id,
        companyId,
        chatbotId: input.chatbotId,
        conversationId: input.conversationId,
        status: "active",
        endReason: null,
        limitMs: input.limitMs,
        usedMs: 0,
        turnCount: 0,
        startedAt: now,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      if (sessions.has(key(companyId, input.id))) throw new Error("voice session id already exists");
      sessions.set(key(companyId, input.id), record);
      return { ...record };
    },
    async get(companyId, sessionId) {
      const row = readRow(companyId, sessionId);
      return row ? { ...row } : null;
    },
    async reserve(companyId, sessionId, durationMs) {
      const row = readRow(companyId, sessionId);
      if (row === null) return { ok: false, reason: "not_found" };
      if (row.status !== "active") return { ok: false, reason: "session_ended" };
      if (row.limitMs !== null && row.usedMs + durationMs > row.limitMs) return { ok: false, reason: "limit_reached" };
      row.usedMs += durationMs;
      row.turnCount += 1;
      row.updatedAt = clock();
      return { ok: true, seq: row.turnCount, session: { ...row } };
    },
    async release(companyId, sessionId, durationMs) {
      const row = readRow(companyId, sessionId);
      if (row === null) return;
      row.usedMs = Math.max(0, row.usedMs - durationMs);
      row.updatedAt = clock();
    },
    async end(companyId, sessionId, reason, at) {
      const row = readRow(companyId, sessionId);
      if (row === null) return null;
      if (row.status === "active") {
        row.status = "ended";
        row.endReason = reason;
        row.endedAt = at;
        row.updatedAt = at;
        // Same transaction in this implementation: the state change and the event are written together.
        outbox.push({ ...buildSessionEndedEvent({ ...row }), id: randomUUID() });
      }
      return { ...row };
    },
    async listIdle(companyId, cutoff, limit) {
      return [...sessions.values()]
        .filter((row) => row.companyId === companyId && row.status === "active" && row.updatedAt.getTime() <= cutoff.getTime())
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async recordTurn(companyId, sessionId, turn) {
      const list = turns.get(key(companyId, sessionId)) ?? [];
      list.push({ ...turn });
      turns.set(key(companyId, sessionId), list);
    },
    turnsFor(companyId, sessionId) {
      return (turns.get(key(companyId, sessionId)) ?? []).map((t) => ({ ...t }));
    },
    outboxEvents(companyId) {
      return outbox.filter((event) => event.companyId === companyId).map((event) => ({ ...event, payload: { ...event.payload } }));
    },
  };
}

// ---------------------------------------------------------------------------
// Drizzle storage. Every statement filters on company_id. Query builders are exported so tests can render them.
// ---------------------------------------------------------------------------

type VoiceDb = PgDatabase<any, any, any>;

const s = chatbotVoiceSessions;
const t = chatbotVoiceTurns;

type SessionRow = typeof s.$inferSelect;

function toRecord(row: SessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    conversationId: row.conversationId,
    status: row.status as VoiceSessionStatus,
    endReason: (row.endReason as VoiceEndReason | null) ?? null,
    limitMs: row.limitMs ?? null,
    usedMs: Number(row.usedMs),
    turnCount: row.turnCount,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function insertVoiceSessionQuery(db: VoiceDb, companyId: string, input: NewVoiceSession) {
  return db.insert(s).values({
    companyId,
    id: input.id,
    chatbotId: input.chatbotId,
    conversationId: input.conversationId,
    status: "active",
    limitMs: input.limitMs,
    usedMs: 0,
    turnCount: 0,
    startedAt: input.startedAt,
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
  }).returning();
}

export function selectVoiceSessionQuery(db: VoiceDb, companyId: string, sessionId: string) {
  return db.select().from(s).where(and(eq(s.companyId, companyId), eq(s.id, sessionId))).limit(1);
}

/** One conditional UPDATE. Returns the row only when the reservation fit. */
export function reserveVoiceSecondsQuery(db: VoiceDb, companyId: string, sessionId: string, durationMs: number) {
  return db
    .update(s)
    .set({
      usedMs: sql`${s.usedMs} + ${durationMs}`,
      turnCount: sql`${s.turnCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(s.companyId, companyId),
        eq(s.id, sessionId),
        eq(s.status, "active"),
        or(isNull(s.limitMs), sql`${s.usedMs} + ${durationMs} <= ${s.limitMs}`),
      ),
    )
    .returning();
}

export function releaseVoiceSecondsQuery(db: VoiceDb, companyId: string, sessionId: string, durationMs: number) {
  return db
    .update(s)
    .set({ usedMs: sql`greatest(${s.usedMs} - ${durationMs}, 0)`, updatedAt: sql`now()` })
    .where(and(eq(s.companyId, companyId), eq(s.id, sessionId)));
}

/** Only an active row changes. A second end keeps the first endedAt. */
export function endVoiceSessionQuery(db: VoiceDb, companyId: string, sessionId: string, reason: VoiceEndReason, at: Date) {
  return db
    .update(s)
    .set({ status: "ended", endReason: reason, endedAt: at, updatedAt: at })
    .where(and(eq(s.companyId, companyId), eq(s.id, sessionId), eq(s.status, "active")))
    .returning();
}

export function selectIdleVoiceSessionsQuery(db: VoiceDb, companyId: string, cutoff: Date, limit: number) {
  return db
    .select()
    .from(s)
    .where(and(eq(s.companyId, companyId), eq(s.status, "active"), lt(s.updatedAt, cutoff)))
    .orderBy(asc(s.updatedAt))
    .limit(limit);
}

/** Inserts the session-ended event inside the caller's transaction. */
export function insertSessionEndedOutboxQuery(db: VoiceDb, event: NewOutboxEvent & { id: string }, createdAt: Date) {
  return db.insert(chatbotEventOutbox).values({
    companyId: event.companyId,
    id: event.id,
    topic: event.topic,
    aggregateId: event.aggregateId,
    payload: event.payload,
    dedupeKey: event.dedupeKey,
    status: "pending",
    attempts: 0,
    availableAt: event.availableAt,
    createdAt,
  });
}

export function insertVoiceTurnQuery(db: VoiceDb, companyId: string, sessionId: string, turn: VoiceTurnRecord) {
  return db.insert(t).values({
    companyId,
    sessionId,
    seq: turn.seq,
    durationMs: turn.durationMs,
    customerMessageId: turn.customerMessageId,
    assistantMessageId: turn.assistantMessageId,
  });
}

export function createDrizzleVoiceSessionStorage(db: VoiceDb): VoiceSessionStorage {
  const readOne = async (companyId: string, sessionId: string) => {
    const rows = await selectVoiceSessionQuery(db, companyId, sessionId);
    return rows[0] ? toRecord(rows[0]) : null;
  };

  return {
    async create(companyId, input) {
      const rows = await insertVoiceSessionQuery(db, companyId, input);
      return toRecord(rows[0]);
    },
    get: readOne,
    async reserve(companyId, sessionId, durationMs) {
      const rows = await reserveVoiceSecondsQuery(db, companyId, sessionId, durationMs);
      if (rows[0]) {
        const session = toRecord(rows[0]);
        return { ok: true, seq: session.turnCount, session };
      }
      return { ok: false, reason: reasonForFailedReserve(await readOne(companyId, sessionId)) };
    },
    async release(companyId, sessionId, durationMs) {
      await releaseVoiceSecondsQuery(db, companyId, sessionId, durationMs);
    },
    async end(companyId, sessionId, reason, at) {
      return db.transaction(async (tx) => {
        const rows = await endVoiceSessionQuery(tx, companyId, sessionId, reason, at);
        if (!rows[0]) return readOne(companyId, sessionId);
        const session = toRecord(rows[0]);
        await insertSessionEndedOutboxQuery(tx, { ...buildSessionEndedEvent(session), id: randomUUID() }, at);
        return session;
      });
    },
    async listIdle(companyId, cutoff, limit) {
      const rows = await selectIdleVoiceSessionsQuery(db, companyId, cutoff, limit);
      return rows.map(toRecord);
    },
    async recordTurn(companyId, sessionId, turn) {
      await insertVoiceTurnQuery(db, companyId, sessionId, turn);
    },
  };
}
