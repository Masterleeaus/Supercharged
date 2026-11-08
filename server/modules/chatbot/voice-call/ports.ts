/**
 * Ports for the voice-call service. Every method that reads or writes tenant data takes companyId first and
 * treats a row from another company as absent (CONVENTIONS.md section 2).
 */
import type { CallSessionStatus, HttpClient } from "../contracts/index.ts";

export type CallDirection = "inbound" | "outbound";

export type CallEndReason = "completed" | "limit_reached" | "provider_error" | "failed";

/** Stored call row. Phone numbers are stored in full because the provider needs them. Outputs and logs mask them. */
export interface VoiceCallRecord {
  id: string;
  companyId: string;
  chatbotId: string;
  conversationId: string | null;
  direction: CallDirection;
  provider: string;
  /** Null from the moment the row is reserved until the provider returns its call id. */
  providerCallId: string | null;
  idempotencyKey: string | null;
  status: CallSessionStatus;
  endReason: CallEndReason | null;
  fromNumber: string;
  toNumber: string;
  /** Server-side cap for this call in seconds, taken from the plan at start. Null means no cap. */
  maxSeconds: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** Billable seconds, computed from server timestamps and capped at maxSeconds. Null until the call ends. */
  durationSeconds: number | null;
  createdAt: Date;
}

export type NewVoiceCall = Omit<VoiceCallRecord, "id" | "createdAt" | "endReason" | "startedAt" | "endedAt" | "durationSeconds"> & {
  id?: string;
};

export type VoiceCallPatch = Partial<
  Pick<VoiceCallRecord, "status" | "endReason" | "providerCallId" | "startedAt" | "endedAt" | "durationSeconds" | "maxSeconds">
>;

export interface VoiceCallUsage {
  /** Sum of durationSeconds for calls that ended since the window start. */
  completedSeconds: number;
  /** Sum of maxSeconds for calls still ringing or in progress, so concurrent starts cannot overrun the quota. */
  reservedSeconds: number;
}

export interface VoiceCallStorage {
  findById(companyId: string, chatbotId: string, id: string): Promise<VoiceCallRecord | null>;
  findByIdempotencyKey(companyId: string, chatbotId: string, key: string): Promise<VoiceCallRecord | null>;
  findByProviderCallId(companyId: string, provider: string, providerCallId: string): Promise<VoiceCallRecord | null>;
  listActive(companyId: string, chatbotId: string): Promise<VoiceCallRecord[]>;
  /** Inserts a row. Throws a "duplicate" error when an idempotency key or provider call id already exists in the company. */
  insert(companyId: string, call: NewVoiceCall): Promise<VoiceCallRecord>;
  /**
   * Updates a row only while its status still equals expectedStatus. Returns null on a mismatch or a row from
   * another company. The conditional write is what keeps two webhook deliveries from applying twice.
   */
  update(companyId: string, id: string, expectedStatus: CallSessionStatus, patch: VoiceCallPatch): Promise<VoiceCallRecord | null>;
  usage(companyId: string, chatbotId: string, since: Date): Promise<VoiceCallUsage>;
  /** In-progress calls of one company, across chatbots, oldest first. Used by the limit sweep. Limit caps the batch. */
  listInProgressForCompany(companyId: string, limit: number): Promise<VoiceCallRecord[]>;
}

/**
 * Credit for the chatbot owner's calls. PHP checks the balance when a call starts and charges the owner for each
 * transcript at call end. Here the charge is made per transcript event as it arrives, because transcript text is not
 * stored. The meter measures the text and keeps no copy of it.
 */
export interface CreditLedger {
  /** True when the owner can pay for a call now. Anything other than true, or a throw, refuses the start. */
  hasBalance(companyId: string, chatbotId: string): Promise<boolean>;
  /**
   * Charges for one transcript of one call. The idempotencyKey is stable across redeliveries of the same webhook, so
   * a retried delivery does not charge twice. Throws when the charge cannot be recorded.
   */
  chargeTranscript(companyId: string, chatbotId: string, input: { callId: string; text: string; idempotencyKey: string }): Promise<void>;
}

/** Plan lookup. Returns -1 (unlimited), 0 (not in plan), a positive monthly cap, or null when the chatbot is not in this company. */
export interface CallQuotaPort {
  secondsLimitFor(companyId: string, chatbotId: string): Promise<number | null>;
}

export interface ChatbotGate {
  exists(companyId: string, chatbotId: string): Promise<boolean>;
}

/** Returns the provider credentials for a chatbot, or null when none are configured (the service fails closed). */
export interface CredentialSource {
  load(companyId: string, chatbotId: string): Promise<Readonly<Record<string, string>> | null>;
}

export interface VoiceLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type { HttpClient };
