/*
 * Delivery status persistence for outbound messages: sent, delivered, failed, and retry. One record per message.
 *
 * The transition rules come from delivery-rules.ts (port of the MessageRuntime.php rank table). This module adds the
 * storage: a compare-and-set write, so two workers cannot both move the same message from the same state.
 *
 * Tenancy: a message of another company is absent. Failure reasons are stored as codes only. Provider text is never kept.
 */
import type { MessageStatus } from "../contracts/runtime.ts";
import type { ConversationStore } from "./conversation-store.ts";
import { advanceDelivery, markFailedDelivery, retryDelivery } from "./delivery-rules.ts";

export const DELIVERY_CAS_ATTEMPTS = 3;
export const FAILURE_CODE_MAX_CHARS = 80;
/** Stored when a caller passes something that is not a code, such as a raw provider message. */
export const UNKNOWN_FAILURE_CODE = "unknown_failure";

export interface DeliveryRecord {
  companyId: string;
  messageId: string;
  conversationId: string;
  status: MessageStatus;
  externalMessageId: string | null;
  failureReason: string | null;
  retryCount: number;
  updatedAt: Date;
}

export interface DeliveryStatusStore {
  find(companyId: string, messageId: string): Promise<DeliveryRecord | null>;
  /**
   * Writes next only when the stored status equals expected. expected null means "no record yet".
   * Returns false when the stored status moved, so the caller re-reads and tries again.
   */
  compareAndSet(companyId: string, next: DeliveryRecord, expected: MessageStatus | null): Promise<boolean>;
}

export class DeliveryConflictError extends Error {
  constructor() {
    super("delivery_conflict");
    this.name = "DeliveryConflictError";
  }
}

/** Keeps only a short code such as "provider_timeout" or "channel:131047". Anything else becomes unknown_failure. */
export function toFailureCode(reason: string): string {
  const candidate = reason.trim();
  if (candidate.length > 0 && candidate.length <= FAILURE_CODE_MAX_CHARS && /^[a-z][a-z0-9_:.-]*$/.test(candidate)) {
    return candidate;
  }
  return UNKNOWN_FAILURE_CODE;
}

export interface DeliveryStatusRuntime {
  get(companyId: string, messageId: string): Promise<DeliveryRecord | null>;
  markSent(companyId: string, messageId: string, externalMessageId: string | null): Promise<DeliveryRecord | null>;
  markDelivered(companyId: string, messageId: string, externalMessageId: string | null): Promise<DeliveryRecord | null>;
  markFailed(companyId: string, messageId: string, reason: string): Promise<DeliveryRecord | null>;
  /** Only a failed message can be retried. Throws DeliveryError otherwise. */
  retry(companyId: string, messageId: string): Promise<DeliveryRecord | null>;
}

export interface DeliveryStatusDeps {
  store: DeliveryStatusStore;
  /** Looks up which conversation owns a message. Null means the message is absent for this company. */
  messages: Pick<ConversationStore, "conversationOfMessage">;
  now?: () => Date;
}

type Step = (current: DeliveryRecord) => { record: DeliveryRecord; changed: boolean };

export function createDeliveryStatusRuntime(deps: DeliveryStatusDeps): DeliveryStatusRuntime {
  const { store, messages } = deps;
  const now = deps.now ?? (() => new Date());

  async function update(companyId: string, messageId: string, step: Step): Promise<DeliveryRecord | null> {
    for (let attempt = 0; attempt < DELIVERY_CAS_ATTEMPTS; attempt += 1) {
      const conversationId = await messages.conversationOfMessage(companyId, messageId);
      if (conversationId === null) return null;

      const existing = await store.find(companyId, messageId);
      const current: DeliveryRecord = existing ?? {
        companyId,
        messageId,
        conversationId,
        status: "queued",
        externalMessageId: null,
        failureReason: null,
        retryCount: 0,
        updatedAt: now(),
      };

      const { record, changed } = step(current);
      if (!changed) return existing ?? current;

      const written = await store.compareAndSet(companyId, { ...record, updatedAt: now() }, existing ? existing.status : null);
      if (written) return { ...record, updatedAt: now() };
    }
    throw new DeliveryConflictError();
  }

  const advance = (target: "sent" | "delivered") => (companyId: string, messageId: string, externalMessageId: string | null) =>
    update(companyId, messageId, (current) => {
      const result = advanceDelivery(current.status, target);
      if (!result.changed) return { record: current, changed: false };
      return {
        record: {
          ...current,
          status: result.status,
          externalMessageId: externalMessageId ?? current.externalMessageId,
          failureReason: null,
        },
        changed: true,
      };
    });

  return {
    async get(companyId, messageId) {
      const conversationId = await messages.conversationOfMessage(companyId, messageId);
      if (conversationId === null) return null;
      return store.find(companyId, messageId);
    },

    markSent: advance("sent"),
    markDelivered: advance("delivered"),

    async markFailed(companyId, messageId, reason) {
      const code = toFailureCode(reason);
      return update(companyId, messageId, (current) => {
        const result = markFailedDelivery(current.status);
        if (!result.changed) return { record: current, changed: false };
        return { record: { ...current, status: result.status, failureReason: code }, changed: true };
      });
    },

    async retry(companyId, messageId) {
      return update(companyId, messageId, (current) => {
        const result = retryDelivery(current.status, current.retryCount);
        return {
          record: {
            ...current,
            status: result.status,
            retryCount: result.retryCount ?? current.retryCount,
            failureReason: null,
          },
          changed: result.changed,
        };
      });
    },
  };
}

/** In-memory store for tests and local use. Same compare-and-set rule as a database would apply. */
export function createMemoryDeliveryStatusStore(): DeliveryStatusStore {
  const rows = new Map<string, DeliveryRecord>();
  const keyOf = (companyId: string, messageId: string) => JSON.stringify([companyId, messageId]);

  return {
    async find(companyId, messageId) {
      const row = rows.get(keyOf(companyId, messageId));
      return row ? structuredClone(row) : null;
    },

    async compareAndSet(companyId, next, expected) {
      const key = keyOf(companyId, next.messageId);
      const current = rows.get(key);
      if (next.companyId !== companyId) return false;
      if (expected === null ? current !== undefined : current?.status !== expected) return false;
      rows.set(key, structuredClone(next));
      return true;
    },
  };
}
