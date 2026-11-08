/**
 * Drizzle implementation of VoiceCallStorage (see ./storage-memory.ts for the reference behaviour).
 *
 * DRAFT. Not wired to a live database. Tests render the queries with PgDialect and check the company_id predicate.
 * Every statement filters by company_id, and every method takes companyId first and calls requireCompanyId.
 * The optional onQuery hook receives each query builder before it runs. It exists for tests only.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CallSessionStatus } from "../contracts/index.ts";
import { chatbotVoiceCalls, type ChatbotVoiceCallRow } from "../db/voice-call.ts";
import type { CallDirection, CallEndReason, NewVoiceCall, VoiceCallPatch, VoiceCallRecord, VoiceCallStorage, VoiceCallUsage } from "./ports.ts";

export type VoiceCallPgDatabase = PgDatabase<PgQueryResultHKT>;

export interface DrizzleVoiceCallStorageOptions {
  /** Test seam. Receives each query builder before it runs. Leave unset in production. */
  onQuery?: (query: { getSQL(): SQL }) => void;
}

const ACTIVE: CallSessionStatus[] = ["ringing", "in_progress"];

/** Company-wide sweep query. Every predicate starts with company_id. */
export function listInProgressForCompanyQuery(db: VoiceCallPgDatabase, companyId: string, limit: number) {
  const t = chatbotVoiceCalls;
  return db
    .select()
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.status, "in_progress")))
    .orderBy(asc(t.startedAt))
    .limit(limit);
}

function toRecord(row: ChatbotVoiceCallRow): VoiceCallRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    conversationId: row.conversationId,
    direction: row.direction as CallDirection,
    provider: row.provider,
    providerCallId: row.providerCallId,
    idempotencyKey: row.idempotencyKey,
    status: row.status as CallSessionStatus,
    endReason: row.endReason as CallEndReason | null,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    maxSeconds: row.maxSeconds,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt,
  };
}

export class DrizzleVoiceCallStorage implements VoiceCallStorage {
  private readonly db: VoiceCallPgDatabase;
  private readonly options: DrizzleVoiceCallStorageOptions;

  constructor(db: VoiceCallPgDatabase, options: DrizzleVoiceCallStorageOptions = {}) {
    this.db = db;
    this.options = options;
  }

  private track<Q extends { getSQL(): SQL }>(query: Q): Q {
    this.options.onQuery?.(query);
    return query;
  }

  async findById(companyId: string, chatbotId: string, id: string): Promise<VoiceCallRecord | null> {
    requireCompanyId(companyId);
    const t = chatbotVoiceCalls;
    const rows = await this.track(
      this.db
        .select()
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), eq(t.id, id)))
        .limit(1),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(companyId: string, chatbotId: string, key: string): Promise<VoiceCallRecord | null> {
    requireCompanyId(companyId);
    const t = chatbotVoiceCalls;
    const rows = await this.track(
      this.db
        .select()
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), eq(t.idempotencyKey, key)))
        .limit(1),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByProviderCallId(companyId: string, provider: string, providerCallId: string): Promise<VoiceCallRecord | null> {
    requireCompanyId(companyId);
    const t = chatbotVoiceCalls;
    const rows = await this.track(
      this.db
        .select()
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.provider, provider), eq(t.providerCallId, providerCallId)))
        .limit(1),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listActive(companyId: string, chatbotId: string): Promise<VoiceCallRecord[]> {
    requireCompanyId(companyId);
    const t = chatbotVoiceCalls;
    const rows = await this.track(
      this.db
        .select()
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), inArray(t.status, ACTIVE))),
    );
    return rows.map(toRecord);
  }

  async listInProgressForCompany(companyId: string, limit: number): Promise<VoiceCallRecord[]> {
    requireCompanyId(companyId);
    const rows = await this.track(listInProgressForCompanyQuery(this.db, companyId, limit));
    return rows.map(toRecord);
  }

  async insert(companyId: string, call: NewVoiceCall): Promise<VoiceCallRecord> {
    requireCompanyId(companyId);
    if (call.companyId !== companyId) throw new Error("company mismatch on insert");
    const t = chatbotVoiceCalls;
    const rows = await this.track(
      this.db
        .insert(t)
        .values({
          id: call.id ?? randomUUID(),
          companyId,
          chatbotId: call.chatbotId,
          conversationId: call.conversationId,
          direction: call.direction,
          provider: call.provider,
          providerCallId: call.providerCallId,
          idempotencyKey: call.idempotencyKey,
          status: call.status,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          maxSeconds: call.maxSeconds,
        })
        .returning(),
    );
    return toRecord(rows[0]);
  }

  async update(companyId: string, id: string, expectedStatus: CallSessionStatus, patch: VoiceCallPatch): Promise<VoiceCallRecord | null> {
    requireCompanyId(companyId);
    const t = chatbotVoiceCalls;
    const set: Partial<typeof t.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.endReason !== undefined) set.endReason = patch.endReason;
    if (patch.providerCallId !== undefined) set.providerCallId = patch.providerCallId;
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
    if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
    if (patch.durationSeconds !== undefined) set.durationSeconds = patch.durationSeconds;
    if (patch.maxSeconds !== undefined) set.maxSeconds = patch.maxSeconds;
    const rows = await this.track(
      this.db
        .update(t)
        .set(set)
        .where(and(eq(t.companyId, companyId), eq(t.id, id), eq(t.status, expectedStatus)))
        .returning(),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async usage(companyId: string, chatbotId: string, since: Date): Promise<VoiceCallUsage> {
    requireCompanyId(companyId);
    const t = chatbotVoiceCalls;
    const completed = await this.track(
      this.db
        .select({ total: sql<number>`coalesce(sum(${t.durationSeconds}), 0)::int` })
        .from(t)
        .where(
          and(
            eq(t.companyId, companyId),
            eq(t.chatbotId, chatbotId),
            isNotNull(t.endedAt),
            gte(t.endedAt, since),
          ),
        ),
    );
    const reserved = await this.track(
      this.db
        .select({ total: sql<number>`coalesce(sum(${t.maxSeconds}), 0)::int` })
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), inArray(t.status, ACTIVE))),
    );
    return {
      completedSeconds: Number(completed[0]?.total ?? 0),
      reservedSeconds: Number(reserved[0]?.total ?? 0),
    };
  }
}
