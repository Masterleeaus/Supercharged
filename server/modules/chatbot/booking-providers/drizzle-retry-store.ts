/**
 * Drizzle versions of the attempt ledger and the sealed-secret storage, over the tables in ./db.ts.
 *
 * The query builders are exported so tests can render them to SQL without a database. Every builder puts company_id
 * in its WHERE clause or its insert values. Nothing runs at import time.
 */
import { and, eq } from "drizzle-orm";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CalendarProviderKey } from "../contracts/index.ts";
import type { StoredSealed } from "../secrets/sealed-form.ts";
import { chatbotBookingAttempts, chatbotCalendarSecrets } from "./db.ts";
import type { BookingProvidersDb } from "./drizzle-store.ts";
import type {
  BookingAttemptOutcome,
  BookingAttemptRecord,
  BookingAttemptStatus,
  BookingAttemptStore,
  CalendarSecretPurpose,
  CalendarSecretStorage,
} from "./types.ts";

export const retryQueries = {
  insertAttempt(db: BookingProvidersDb, companyId: string, provider: CalendarProviderKey, key: string, requestHash: string, now: Date) {
    return db
      .insert(chatbotBookingAttempts)
      .values({
        companyId,
        provider,
        idempotencyKey: key,
        requestHash,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [chatbotBookingAttempts.companyId, chatbotBookingAttempts.provider, chatbotBookingAttempts.idempotencyKey],
      })
      .returning();
  },

  selectAttempt(db: BookingProvidersDb, companyId: string, provider: CalendarProviderKey, key: string) {
    return db
      .select()
      .from(chatbotBookingAttempts)
      .where(
        and(
          eq(chatbotBookingAttempts.companyId, companyId),
          eq(chatbotBookingAttempts.provider, provider),
          eq(chatbotBookingAttempts.idempotencyKey, key),
        ),
      )
      .limit(1);
  },

  reclaimAttempt(db: BookingProvidersDb, companyId: string, provider: CalendarProviderKey, key: string, now: Date) {
    return db
      .update(chatbotBookingAttempts)
      .set({ status: "pending", updatedAt: now })
      .where(
        and(
          eq(chatbotBookingAttempts.companyId, companyId),
          eq(chatbotBookingAttempts.provider, provider),
          eq(chatbotBookingAttempts.idempotencyKey, key),
          eq(chatbotBookingAttempts.status, "rejected"),
        ),
      )
      .returning({ id: chatbotBookingAttempts.id });
  },

  settleAttempt(
    db: BookingProvidersDb,
    companyId: string,
    provider: CalendarProviderKey,
    key: string,
    outcome: BookingAttemptOutcome,
    now: Date,
  ) {
    return db
      .update(chatbotBookingAttempts)
      .set({
        status: outcome.status,
        externalBookingId: outcome.status === "booked" ? outcome.externalBookingId : null,
        manageUrl: outcome.status === "booked" ? outcome.manageUrl : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatbotBookingAttempts.companyId, companyId),
          eq(chatbotBookingAttempts.provider, provider),
          eq(chatbotBookingAttempts.idempotencyKey, key),
          eq(chatbotBookingAttempts.status, "pending"),
        ),
      )
      .returning({ id: chatbotBookingAttempts.id });
  },

  upsertSecret(
    db: BookingProvidersDb,
    companyId: string,
    provider: CalendarProviderKey,
    purpose: CalendarSecretPurpose,
    sealed: StoredSealed,
    now: Date,
  ) {
    return db
      .insert(chatbotCalendarSecrets)
      .values({ companyId, provider, purpose, sealed, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [chatbotCalendarSecrets.companyId, chatbotCalendarSecrets.provider, chatbotCalendarSecrets.purpose],
        set: { sealed, updatedAt: now },
      });
  },

  selectSecret(db: BookingProvidersDb, companyId: string, provider: CalendarProviderKey, purpose: CalendarSecretPurpose) {
    return db
      .select({ sealed: chatbotCalendarSecrets.sealed })
      .from(chatbotCalendarSecrets)
      .where(
        and(
          eq(chatbotCalendarSecrets.companyId, companyId),
          eq(chatbotCalendarSecrets.provider, provider),
          eq(chatbotCalendarSecrets.purpose, purpose),
        ),
      )
      .limit(1);
  },
};

function toAttempt(row: typeof chatbotBookingAttempts.$inferSelect): BookingAttemptRecord {
  return {
    companyId: row.companyId,
    provider: row.provider as CalendarProviderKey,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    status: row.status as BookingAttemptStatus,
    externalBookingId: row.externalBookingId,
    manageUrl: row.manageUrl,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleRetryStore(db: BookingProvidersDb): { attempts: BookingAttemptStore; secrets: CalendarSecretStorage } {
  const attempts: BookingAttemptStore = {
    async begin(companyId, provider, idempotencyKey, requestHash, now) {
      const scope = requireCompanyId(companyId);
      const inserted = await retryQueries.insertAttempt(db, scope, provider, idempotencyKey, requestHash, now);
      if (inserted.length > 0) return { created: true, record: toAttempt(inserted[0]!) };
      const existing = await retryQueries.selectAttempt(db, scope, provider, idempotencyKey);
      if (existing.length === 0) throw new Error("attempt insert conflicted but no row was found");
      return { created: false, record: toAttempt(existing[0]!) };
    },

    async reclaim(companyId, provider, idempotencyKey, now) {
      const rows = await retryQueries.reclaimAttempt(db, requireCompanyId(companyId), provider, idempotencyKey, now);
      return rows.length > 0;
    },

    async settle(companyId, provider, idempotencyKey, outcome, now) {
      const rows = await retryQueries.settleAttempt(db, requireCompanyId(companyId), provider, idempotencyKey, outcome, now);
      return rows.length > 0;
    },
  };

  const secrets: CalendarSecretStorage = {
    async put(companyId, provider, purpose, sealed, now) {
      await retryQueries.upsertSecret(db, requireCompanyId(companyId), provider, purpose, sealed, now);
    },

    async get(companyId, provider, purpose) {
      const rows = await retryQueries.selectSecret(db, requireCompanyId(companyId), provider, purpose);
      return rows[0] ? (rows[0].sealed as StoredSealed) : null;
    },
  };

  return { attempts, secrets };
}
