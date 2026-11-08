/**
 * Storage port for payment intents, operations (authorise, capture, refund, cancel) and webhook events.
 * The in-memory implementation is for tests and local runs. The Drizzle implementation lives in
 * drizzle-queries.ts and uses the tables in db/commerce-money.ts.
 *
 * Tenancy: every method takes companyId. A row that belongs to another company is treated as absent.
 */
import type { PaymentStatus } from "../../contracts/index.ts";

export interface PaymentIntentRecord {
  readonly companyId: string;
  readonly id: string;
  readonly providerName: string;
  readonly providerIntentId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly orderRef: string;
  readonly method: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly customerRef: string | null;
  status: PaymentStatus;
  authorizedMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  clientToken: string | null;
  version: number;
  readonly createdAt: Date;
  updatedAt: Date;
}

export type PaymentOperationKind = "authorize" | "capture" | "refund" | "cancel";

export interface PaymentOperationRecord {
  readonly companyId: string;
  readonly intentId: string;
  readonly operation: PaymentOperationKind;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly amountMinor: number | null;
  /** Result returned to the caller on a replay. Never holds credentials. */
  readonly result: Readonly<Record<string, string | number | null>>;
  readonly createdAt: Date;
}

export type PaymentWebhookOutcome = "processed" | "ignored" | "unmatched";

export interface PaymentWebhookRecord {
  readonly companyId: string;
  readonly provider: string;
  readonly eventKey: string;
  readonly providerEventId: string | null;
  readonly eventType: string | null;
  readonly intentId: string | null;
  readonly outcome: PaymentWebhookOutcome;
  readonly receivedAt: Date;
}

export interface PaymentIntentPatch {
  status?: PaymentStatus;
  authorizedMinor?: number;
  capturedMinor?: number;
  refundedMinor?: number;
  clientToken?: string | null;
}

export interface PaymentStorage {
  findIntentByKey(companyId: string, idempotencyKey: string): Promise<PaymentIntentRecord | null>;
  getIntent(companyId: string, id: string): Promise<PaymentIntentRecord | null>;
  findIntentByProviderId(companyId: string, providerName: string, providerIntentId: string): Promise<PaymentIntentRecord | null>;
  /** Returns false when the key or the provider intent id already exists for this company. */
  insertIntent(record: PaymentIntentRecord): Promise<boolean>;
  /** Compare-and-set on version. Returns false when the stored version is not expectedVersion. */
  updateIntent(companyId: string, id: string, expectedVersion: number, patch: PaymentIntentPatch, now: Date): Promise<boolean>;
  findOperationByKey(companyId: string, idempotencyKey: string): Promise<PaymentOperationRecord | null>;
  /** Returns false when the key already exists for this company. */
  insertOperation(record: PaymentOperationRecord): Promise<boolean>;
  findWebhookEvent(companyId: string, provider: string, eventKey: string): Promise<PaymentWebhookRecord | null>;
  saveWebhookEvent(record: PaymentWebhookRecord): Promise<void>;
}

/** In-memory PaymentStorage. Keys are scoped by company, as the SQL unique constraints are. */
export function createMemoryPaymentStorage(): PaymentStorage & { readonly intents: ReadonlyMap<string, PaymentIntentRecord> } {
  const intents = new Map<string, PaymentIntentRecord>();
  const operations = new Map<string, PaymentOperationRecord>();
  const webhooks = new Map<string, PaymentWebhookRecord>();
  const scoped = (companyId: string, value: string): string => `${companyId}\u0000${value}`;

  return {
    intents,
    async findIntentByKey(companyId, idempotencyKey) {
      for (const record of intents.values()) {
        if (record.companyId === companyId && record.idempotencyKey === idempotencyKey) {
          return record;
        }
      }
      return null;
    },
    async getIntent(companyId, id) {
      const record = intents.get(scoped(companyId, id));
      return record && record.companyId === companyId ? record : null;
    },
    async findIntentByProviderId(companyId, providerName, providerIntentId) {
      for (const record of intents.values()) {
        if (record.companyId === companyId && record.providerName === providerName && record.providerIntentId === providerIntentId) {
          return record;
        }
      }
      return null;
    },
    async insertIntent(record) {
      for (const existing of intents.values()) {
        if (existing.companyId !== record.companyId) continue;
        if (existing.idempotencyKey === record.idempotencyKey) return false;
        if (existing.providerName === record.providerName && existing.providerIntentId === record.providerIntentId) return false;
      }
      intents.set(scoped(record.companyId, record.id), record);
      return true;
    },
    async updateIntent(companyId, id, expectedVersion, patch, now) {
      const record = intents.get(scoped(companyId, id));
      if (!record || record.companyId !== companyId || record.version !== expectedVersion) {
        return false;
      }
      if (patch.status !== undefined) record.status = patch.status;
      if (patch.authorizedMinor !== undefined) record.authorizedMinor = patch.authorizedMinor;
      if (patch.capturedMinor !== undefined) record.capturedMinor = patch.capturedMinor;
      if (patch.refundedMinor !== undefined) record.refundedMinor = patch.refundedMinor;
      if (patch.clientToken !== undefined) record.clientToken = patch.clientToken;
      record.version = expectedVersion + 1;
      record.updatedAt = now;
      return true;
    },
    async findOperationByKey(companyId, idempotencyKey) {
      const record = operations.get(scoped(companyId, idempotencyKey));
      return record && record.companyId === companyId ? record : null;
    },
    async insertOperation(record) {
      const slot = scoped(record.companyId, record.idempotencyKey);
      if (operations.has(slot)) return false;
      operations.set(slot, record);
      return true;
    },
    async findWebhookEvent(companyId, provider, eventKey) {
      const record = webhooks.get(scoped(companyId, `${provider}|${eventKey}`));
      return record && record.companyId === companyId ? record : null;
    },
    async saveWebhookEvent(record) {
      webhooks.set(scoped(record.companyId, `${record.provider}|${record.eventKey}`), record);
    },
  };
}
