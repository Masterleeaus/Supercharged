/**
 * In-memory attempt ledger and sealed-secret storage, for tests and local runs. Same rules as the Drizzle versions
 * in drizzle-retry-store.ts: every method takes the company id, and a row from another company is treated as absent.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CalendarProviderKey } from "../contracts/index.ts";
import type { StoredSealed } from "../secrets/sealed-form.ts";
import type {
  BookingAttemptOutcome,
  BookingAttemptRecord,
  BookingAttemptStore,
  CalendarSecretPurpose,
  CalendarSecretStorage,
} from "./types.ts";

export interface MemoryRetryStore {
  attempts: BookingAttemptStore;
  secrets: CalendarSecretStorage;
}

export function createMemoryRetryStore(): MemoryRetryStore {
  const attempts = new Map<string, BookingAttemptRecord>();
  const secrets = new Map<string, { sealed: StoredSealed; updatedAt: Date }>();

  const attemptKey = (companyId: string, provider: CalendarProviderKey, key: string) => `${companyId}|${provider}|${key}`;
  const secretKey = (companyId: string, provider: CalendarProviderKey, purpose: CalendarSecretPurpose) =>
    `${companyId}|${provider}|${purpose}`;

  const copy = (record: BookingAttemptRecord): BookingAttemptRecord => ({ ...record, updatedAt: new Date(record.updatedAt) });
  // The versioned string is a primitive and is kept as it is; a legacy contract object is copied so callers cannot mutate it.
  const copySealed = (sealed: StoredSealed): StoredSealed => (typeof sealed === "string" ? sealed : { ...sealed });

  const attemptStore: BookingAttemptStore = {
    async begin(companyId, provider, idempotencyKey, requestHash, now) {
      const scope = requireCompanyId(companyId);
      const key = attemptKey(scope, provider, idempotencyKey);
      const existing = attempts.get(key);
      if (existing) return { created: false, record: copy(existing) };
      const record: BookingAttemptRecord = {
        companyId: scope,
        provider,
        idempotencyKey,
        requestHash,
        status: "pending",
        externalBookingId: null,
        manageUrl: null,
        updatedAt: now,
      };
      attempts.set(key, record);
      return { created: true, record: copy(record) };
    },

    async reclaim(companyId, provider, idempotencyKey, now) {
      const scope = requireCompanyId(companyId);
      const record = attempts.get(attemptKey(scope, provider, idempotencyKey));
      if (!record || record.status !== "rejected") return false;
      record.status = "pending";
      record.updatedAt = now;
      return true;
    },

    async settle(companyId, provider, idempotencyKey, outcome: BookingAttemptOutcome, now) {
      const scope = requireCompanyId(companyId);
      const record = attempts.get(attemptKey(scope, provider, idempotencyKey));
      if (!record || record.status !== "pending") return false;
      record.status = outcome.status;
      record.externalBookingId = outcome.status === "booked" ? outcome.externalBookingId : null;
      record.manageUrl = outcome.status === "booked" ? outcome.manageUrl : null;
      record.updatedAt = now;
      return true;
    },
  };

  const secretStorage: CalendarSecretStorage = {
    async put(companyId, provider, purpose, sealed, now) {
      const scope = requireCompanyId(companyId);
      secrets.set(secretKey(scope, provider, purpose), { sealed: copySealed(sealed), updatedAt: now });
    },

    async get(companyId, provider, purpose) {
      const scope = requireCompanyId(companyId);
      const row = secrets.get(secretKey(scope, provider, purpose));
      return row ? copySealed(row.sealed) : null;
    },
  };

  return { attempts: attemptStore, secrets: secretStorage };
}
