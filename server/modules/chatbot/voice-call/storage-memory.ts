/**
 * In-memory VoiceCallStorage. Used by tests and as the behavioural reference for the Drizzle storage.
 * Enforces the same uniqueness rules as the draft migration, scoped by company.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CallSessionStatus } from "../contracts/index.ts";
import type { NewVoiceCall, VoiceCallPatch, VoiceCallRecord, VoiceCallStorage, VoiceCallUsage } from "./ports.ts";

const ACTIVE: ReadonlySet<CallSessionStatus> = new Set(["ringing", "in_progress"]);

export class DuplicateVoiceCallError extends Error {
  readonly code = "duplicate";
  constructor(message: string) {
    super(message);
    this.name = "DuplicateVoiceCallError";
  }
}

export class MemoryVoiceCallStorage implements VoiceCallStorage {
  private readonly rows = new Map<string, VoiceCallRecord>();

  private scoped(companyId: string): VoiceCallRecord[] {
    requireCompanyId(companyId);
    return [...this.rows.values()].filter((row) => row.companyId === companyId);
  }

  async findById(companyId: string, chatbotId: string, id: string): Promise<VoiceCallRecord | null> {
    return this.scoped(companyId).find((r) => r.id === id && r.chatbotId === chatbotId) ?? null;
  }

  async findByIdempotencyKey(companyId: string, chatbotId: string, key: string): Promise<VoiceCallRecord | null> {
    return this.scoped(companyId).find((r) => r.chatbotId === chatbotId && r.idempotencyKey === key) ?? null;
  }

  async findByProviderCallId(companyId: string, provider: string, providerCallId: string): Promise<VoiceCallRecord | null> {
    return this.scoped(companyId).find((r) => r.provider === provider && r.providerCallId === providerCallId) ?? null;
  }

  async listActive(companyId: string, chatbotId: string): Promise<VoiceCallRecord[]> {
    return this.scoped(companyId).filter((r) => r.chatbotId === chatbotId && ACTIVE.has(r.status));
  }

  async listInProgressForCompany(companyId: string, limit: number): Promise<VoiceCallRecord[]> {
    return this.scoped(companyId)
      .filter((r) => r.status === "in_progress")
      .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async insert(companyId: string, call: NewVoiceCall): Promise<VoiceCallRecord> {
    requireCompanyId(companyId);
    if (call.companyId !== companyId) return Promise.reject(new Error("company mismatch on insert"));
    const existing = this.scoped(companyId);
    if (call.idempotencyKey && existing.some((r) => r.chatbotId === call.chatbotId && r.idempotencyKey === call.idempotencyKey)) {
      throw new DuplicateVoiceCallError("idempotency key already used");
    }
    if (call.providerCallId && existing.some((r) => r.provider === call.provider && r.providerCallId === call.providerCallId)) {
      throw new DuplicateVoiceCallError("provider call id already stored");
    }
    const row: VoiceCallRecord = {
      ...call,
      id: call.id ?? randomUUID(),
      endReason: null,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      createdAt: new Date(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async update(companyId: string, id: string, expectedStatus: CallSessionStatus, patch: VoiceCallPatch): Promise<VoiceCallRecord | null> {
    const row = this.scoped(companyId).find((r) => r.id === id);
    if (!row || row.status !== expectedStatus) return null;
    const next: VoiceCallRecord = { ...row, ...patch };
    this.rows.set(id, next);
    return { ...next };
  }

  async usage(companyId: string, chatbotId: string, since: Date): Promise<VoiceCallUsage> {
    const rows = this.scoped(companyId).filter((r) => r.chatbotId === chatbotId);
    const completedSeconds = rows
      .filter((r) => r.endedAt !== null && r.endedAt.getTime() >= since.getTime())
      .reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0);
    const reservedSeconds = rows
      .filter((r) => ACTIVE.has(r.status))
      .reduce((sum, r) => sum + (r.maxSeconds ?? 0), 0);
    return { completedSeconds, reservedSeconds };
  }
}
