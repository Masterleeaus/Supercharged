/**
 * Drizzle query builders for the money paths that need a tenant filter, a version check, or a date-overlap check.
 * Each builder returns an unexecuted query. Callers run it inside their own transaction. Every builder filters on
 * company_id first. The tests render these with PgDialect to check that.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  commerceRentalBookings,
  commercePaymentIntents,
  commercePaymentWebhookEvents,
} from "../../db/commerce-money.ts";
import type { PaymentIntentRecord } from "./payment-storage.ts";
import type { HireBooking } from "./rental-hire.ts";

// The builders accept any Drizzle pg database or transaction. The driver type does not change the SQL.
type MoneyDb = PgDatabase<any, any, any>;

export function insertPaymentIntentQuery(db: MoneyDb, record: PaymentIntentRecord) {
  return db.insert(commercePaymentIntents).values({
    companyId: record.companyId,
    id: record.id,
    providerName: record.providerName,
    providerIntentId: record.providerIntentId,
    idempotencyKey: record.idempotencyKey,
    requestHash: record.requestHash,
    orderRef: record.orderRef,
    method: record.method,
    currency: record.currency,
    amountMinor: record.amountMinor,
    authorizedMinor: record.authorizedMinor,
    capturedMinor: record.capturedMinor,
    refundedMinor: record.refundedMinor,
    status: record.status,
    customerRef: record.customerRef,
    clientToken: record.clientToken,
    version: record.version,
  });
}

export function selectPaymentIntentByKeyQuery(db: MoneyDb, companyId: string, idempotencyKey: string) {
  return db
    .select()
    .from(commercePaymentIntents)
    .where(and(eq(commercePaymentIntents.companyId, companyId), eq(commercePaymentIntents.idempotencyKey, idempotencyKey)))
    .limit(1);
}

/** Compare-and-set on version. The update matches no row when another writer has moved the version on. */
export function updatePaymentIntentVersionQuery(
  db: MoneyDb,
  companyId: string,
  id: string,
  expectedVersion: number,
  values: { status?: string; authorizedMinor?: number; capturedMinor?: number; refundedMinor?: number },
  now: Date,
) {
  return db
    .update(commercePaymentIntents)
    .set({ ...values, version: expectedVersion + 1, updatedAt: now })
    .where(and(
      eq(commercePaymentIntents.companyId, companyId),
      eq(commercePaymentIntents.id, id),
      eq(commercePaymentIntents.version, expectedVersion),
    ));
}

export function selectWebhookEventQuery(db: MoneyDb, companyId: string, provider: string, eventKey: string) {
  return db
    .select()
    .from(commercePaymentWebhookEvents)
    .where(and(
      eq(commercePaymentWebhookEvents.companyId, companyId),
      eq(commercePaymentWebhookEvents.provider, provider),
      eq(commercePaymentWebhookEvents.eventKey, eventKey),
    ))
    .limit(1);
}

/**
 * Bookings that hold an item across a date range. Inclusive ranges overlap when each starts on or before the other ends.
 * Run it under SELECT ... FOR UPDATE in the same transaction as the insert.
 */
export function selectHoldingHireBookingsQuery(db: MoneyDb, companyId: string, itemId: string, startsOn: string, endsOn: string) {
  return db
    .select()
    .from(commerceRentalBookings)
    .where(and(
      eq(commerceRentalBookings.companyId, companyId),
      eq(commerceRentalBookings.itemId, itemId),
      inArray(commerceRentalBookings.status, ["reserved", "active"]),
      lte(commerceRentalBookings.startsOn, endsOn),
      gte(commerceRentalBookings.endsOn, startsOn),
    ))
    .for("update");
}

export function insertHireBookingQuery(db: MoneyDb, booking: HireBooking) {
  return db.insert(commerceRentalBookings).values({
    companyId: booking.companyId,
    id: booking.id,
    itemId: booking.itemId,
    customerRef: booking.customerRef,
    startsOn: booking.startsOn,
    endsOn: booking.endsOn,
    currency: booking.currency,
    rentalMinor: booking.rentalMinor,
    depositMinor: booking.depositMinor,
    status: booking.status,
    returnedOn: booking.returnedOn,
    lateDays: booking.lateDays,
    lateFeeMinor: booking.lateFeeMinor,
    depositReturnedMinor: booking.depositReturnedMinor,
    amountDueMinor: booking.amountDueMinor,
    idempotencyKey: booking.idempotencyKey,
    requestHash: booking.requestHash,
    version: booking.version,
  });
}
