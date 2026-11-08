/**
 * Drizzle storage for the money domain. Each factory returns the same interface as its in-memory twin, so a service
 * takes either one without change.
 *
 * Transactions: where the PHP used DB::transaction with lockForUpdate (coupon reservation, webhook settlement, recurring
 * booking), the same steps run in one db.transaction here. Cross-process guards are the unique constraints and the
 * booking exclusion constraint. Error codes are read from the driver error (23505 unique, 23P01 exclusion) through
 * DrizzleQueryError.cause.
 *
 * Tenancy: every query filters on company_id. A company id that is not a UUID cannot match a row, so the read returns
 * null or an empty list, and the write is refused as absent.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  commerceBnplOffers,
  commercePaymentIntents,
  commercePaymentOperations,
  commercePaymentWebhookEvents,
  commerceRentalBookings,
  commerceRentalItems,
} from "../../db/commerce-money.ts";
import type { BnplOfferStatus, PaymentStatus } from "../../contracts/index.ts";
import type { BnplOfferRecord } from "./bnpl.ts";
import type { BnplLifecycleStorage } from "./bnpl-lifecycle.ts";
import { countCouponUsage, type CouponAppliesTo, type CouponRecord, type CouponStorage, type CouponType, type CouponUsageCounts, type CouponUsageRecord } from "./coupons.ts";
import { MoneyError } from "./money.ts";
import { exemptionApplies, type TaxExemptionRecord, type TaxExemptionStorage, type TaxExemptionSubject } from "./tax-exemptions.ts";
import { selectHoldingHireBookingsQuery, selectPaymentIntentByKeyQuery, selectWebhookEventQuery, insertHireBookingQuery, insertPaymentIntentQuery, updatePaymentIntentVersionQuery } from "./drizzle-queries.ts";
import type { HireBooking, HireBookingStatus, HireItem, HireStorage } from "./rental-hire.ts";
import type { PaymentIntentRecord, PaymentOperationRecord, PaymentStorage, PaymentWebhookRecord } from "./payment-storage.ts";
import type { RecurringSeries, RecurringStorage } from "./recurring-rental.ts";
import { commerceCouponUsages, commerceCoupons, commerceRentalSeries, commerceRentalSeriesBookings, commerceTaxExemptions } from "./gap-tables.ts";

// Any Drizzle pg database or transaction. The driver type does not change the SQL.
export type MoneyDb = PgDatabase<any, any, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOLDING: HireBookingStatus[] = ["reserved", "active"];

function tenantOk(companyId: string): boolean {
  return UUID.test(companyId);
}

/** Finds the driver error code, reading through DrizzleQueryError.cause when it is wrapped. */
export function driverErrorCode(error: unknown): string | null {
  let current: any = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = current.cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

type IntentRow = typeof commercePaymentIntents.$inferSelect;
type OperationRow = typeof commercePaymentOperations.$inferSelect;
type WebhookRow = typeof commercePaymentWebhookEvents.$inferSelect;

function toIntent(row: IntentRow): PaymentIntentRecord {
  return {
    companyId: row.companyId,
    id: row.id,
    providerName: row.providerName,
    providerIntentId: row.providerIntentId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    orderRef: row.orderRef,
    method: row.method,
    currency: row.currency,
    amountMinor: row.amountMinor,
    customerRef: row.customerRef,
    status: row.status as PaymentStatus,
    authorizedMinor: row.authorizedMinor,
    capturedMinor: row.capturedMinor,
    refundedMinor: row.refundedMinor,
    clientToken: row.clientToken,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOperation(row: OperationRow): PaymentOperationRecord {
  return {
    companyId: row.companyId,
    intentId: row.intentId,
    operation: row.operation as PaymentOperationRecord["operation"],
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    amountMinor: row.amountMinor,
    result: row.result,
    createdAt: row.createdAt,
  };
}

function toWebhook(row: WebhookRow): PaymentWebhookRecord {
  return {
    companyId: row.companyId,
    provider: row.provider,
    eventKey: row.eventKey,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    intentId: row.intentId,
    outcome: row.outcome as PaymentWebhookRecord["outcome"],
    receivedAt: row.receivedAt,
  };
}

export function createDrizzlePaymentStorage(db: MoneyDb): PaymentStorage {
  return {
    async findIntentByKey(companyId, idempotencyKey) {
      if (!tenantOk(companyId)) return null;
      const rows = await selectPaymentIntentByKeyQuery(db, companyId, idempotencyKey);
      return rows[0] ? toIntent(rows[0]) : null;
    },
    async getIntent(companyId, id) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commercePaymentIntents)
        .where(and(eq(commercePaymentIntents.companyId, companyId), eq(commercePaymentIntents.id, id)))
        .limit(1);
      return rows[0] ? toIntent(rows[0]) : null;
    },
    async findIntentByProviderId(companyId, providerName, providerIntentId) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commercePaymentIntents)
        .where(and(
          eq(commercePaymentIntents.companyId, companyId),
          eq(commercePaymentIntents.providerName, providerName),
          eq(commercePaymentIntents.providerIntentId, providerIntentId),
        ))
        .limit(1);
      return rows[0] ? toIntent(rows[0]) : null;
    },
    async insertIntent(record) {
      if (!tenantOk(record.companyId)) return false;
      try {
        await insertPaymentIntentQuery(db, record);
        return true;
      } catch (error) {
        if (driverErrorCode(error) === "23505") return false;
        throw error;
      }
    },
    async updateIntent(companyId, id, expectedVersion, patch, now) {
      if (!tenantOk(companyId)) return false;
      const values: { status?: string; authorizedMinor?: number; capturedMinor?: number; refundedMinor?: number } = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.authorizedMinor !== undefined) values.authorizedMinor = patch.authorizedMinor;
      if (patch.capturedMinor !== undefined) values.capturedMinor = patch.capturedMinor;
      if (patch.refundedMinor !== undefined) values.refundedMinor = patch.refundedMinor;
      const rows = await updatePaymentIntentVersionQuery(db, companyId, id, expectedVersion, values, now)
        .returning({ id: commercePaymentIntents.id });
      return rows.length > 0;
    },
    async findOperationByKey(companyId, idempotencyKey) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commercePaymentOperations)
        .where(and(eq(commercePaymentOperations.companyId, companyId), eq(commercePaymentOperations.idempotencyKey, idempotencyKey)))
        .limit(1);
      return rows[0] ? toOperation(rows[0]) : null;
    },
    async insertOperation(record) {
      if (!tenantOk(record.companyId)) return false;
      try {
        await db.insert(commercePaymentOperations).values({
          companyId: record.companyId,
          id: randomUUID(),
          intentId: record.intentId,
          operation: record.operation,
          idempotencyKey: record.idempotencyKey,
          requestHash: record.requestHash,
          amountMinor: record.amountMinor,
          result: { ...record.result },
          createdAt: record.createdAt,
        });
        return true;
      } catch (error) {
        if (driverErrorCode(error) === "23505") return false;
        throw error;
      }
    },
    async findWebhookEvent(companyId, provider, eventKey) {
      if (!tenantOk(companyId)) return null;
      const rows = await selectWebhookEventQuery(db, companyId, provider, eventKey);
      return rows[0] ? toWebhook(rows[0]) : null;
    },
    async saveWebhookEvent(record) {
      if (!tenantOk(record.companyId)) return;
      await db.insert(commercePaymentWebhookEvents).values({
        companyId: record.companyId,
        id: randomUUID(),
        provider: record.provider,
        eventKey: record.eventKey,
        providerEventId: record.providerEventId,
        eventType: record.eventType,
        intentId: record.intentId,
        outcome: record.outcome,
        receivedAt: record.receivedAt,
      }).onConflictDoNothing();
    },
  };
}

// ---------------------------------------------------------------------------
// Item hire (single bookings) and the shared item and holding reads
// ---------------------------------------------------------------------------

type ItemRow = typeof commerceRentalItems.$inferSelect;
type BookingRow = typeof commerceRentalBookings.$inferSelect;

function toItem(row: ItemRow): HireItem {
  return {
    companyId: row.companyId,
    id: row.id,
    sku: row.sku,
    name: row.name,
    currency: row.currency,
    dailyRateMinor: row.dailyRateMinor,
    depositMinor: row.depositMinor,
    lateFeePerDayMinor: row.lateFeePerDayMinor,
    lateFeeCapMinor: row.lateFeeCapMinor ?? null,
    graceDays: row.graceDays,
    active: row.active,
  };
}

function toBooking(row: BookingRow): HireBooking {
  return {
    companyId: row.companyId,
    id: row.id,
    itemId: row.itemId,
    customerRef: row.customerRef,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    currency: row.currency,
    rentalMinor: row.rentalMinor,
    depositMinor: row.depositMinor,
    status: row.status as HireBookingStatus,
    returnedOn: row.returnedOn ?? null,
    lateDays: row.lateDays,
    lateFeeMinor: row.lateFeeMinor,
    depositReturnedMinor: row.depositReturnedMinor,
    amountDueMinor: row.amountDueMinor,
    requestHash: row.requestHash,
    idempotencyKey: row.idempotencyKey,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadItem(db: MoneyDb, companyId: string, itemId: string): Promise<HireItem | null> {
  if (!tenantOk(companyId)) return null;
  const rows = await db.select().from(commerceRentalItems)
    .where(and(eq(commerceRentalItems.companyId, companyId), eq(commerceRentalItems.id, itemId)))
    .limit(1);
  return rows[0] ? toItem(rows[0]) : null;
}

async function loadHolding(db: MoneyDb, companyId: string, itemId: string): Promise<HireBooking[]> {
  if (!tenantOk(companyId)) return [];
  const rows = await db.select().from(commerceRentalBookings)
    .where(and(
      eq(commerceRentalBookings.companyId, companyId),
      eq(commerceRentalBookings.itemId, itemId),
      inArray(commerceRentalBookings.status, HOLDING),
    ));
  return rows.map(toBooking);
}

export function createDrizzleHireStorage(db: MoneyDb): HireStorage {
  return {
    getItem: (companyId, itemId) => loadItem(db, companyId, itemId),
    holdingBookings: (companyId, itemId) => loadHolding(db, companyId, itemId),
    async findBookingByKey(companyId, idempotencyKey) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commerceRentalBookings)
        .where(and(eq(commerceRentalBookings.companyId, companyId), eq(commerceRentalBookings.idempotencyKey, idempotencyKey)))
        .limit(1);
      return rows[0] ? toBooking(rows[0]) : null;
    },
    async getBooking(companyId, id) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commerceRentalBookings)
        .where(and(eq(commerceRentalBookings.companyId, companyId), eq(commerceRentalBookings.id, id)))
        .limit(1);
      return rows[0] ? toBooking(rows[0]) : null;
    },
    async insertBooking(booking) {
      if (!tenantOk(booking.companyId)) return false;
      try {
        await insertHireBookingQuery(db, booking);
        return true;
      } catch (error) {
        const code = driverErrorCode(error);
        if (code === "23505") return false;
        if (code === "23P01") {
          throw new MoneyError("conflict", "The item is already booked for overlapping dates.");
        }
        throw error;
      }
    },
    async updateBooking(companyId, id, expectedVersion, patch, now) {
      if (!tenantOk(companyId)) return false;
      const rows = await db.update(commerceRentalBookings)
        .set({ ...patch, version: expectedVersion + 1, updatedAt: now })
        .where(and(
          eq(commerceRentalBookings.companyId, companyId),
          eq(commerceRentalBookings.id, id),
          eq(commerceRentalBookings.version, expectedVersion),
        ))
        .returning({ id: commerceRentalBookings.id });
      return rows.length > 0;
    },
  };
}

/** Holding bookings for a date range. Runs under FOR UPDATE, so call it inside a transaction. */
export async function lockHoldingInRange(db: MoneyDb, companyId: string, itemId: string, startsOn: string, endsOn: string): Promise<HireBooking[]> {
  if (!tenantOk(companyId)) return [];
  const rows = await selectHoldingHireBookingsQuery(db, companyId, itemId, startsOn, endsOn);
  return rows.map(toBooking);
}

// ---------------------------------------------------------------------------
// Recurring rental series
// ---------------------------------------------------------------------------

type SeriesRow = typeof commerceRentalSeries.$inferSelect;

function toSeries(row: SeriesRow): RecurringSeries {
  return {
    companyId: row.companyId,
    id: row.id,
    itemId: row.itemId,
    customerRef: row.customerRef,
    startsOn: row.startsOn,
    frequency: row.frequency as RecurringSeries["frequency"],
    intervalDays: row.intervalDays,
    durationDays: row.durationDays,
    occurrences: row.occurrences,
    currency: row.currency,
    status: row.status as RecurringSeries["status"],
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    createdAt: row.createdAt,
  };
}

export function createDrizzleRecurringStorage(db: MoneyDb): RecurringStorage {
  const seriesBookings = async (companyId: string, seriesId: string): Promise<HireBooking[]> => {
    const rows = await db.select({ booking: commerceRentalBookings, seriesId: commerceRentalSeriesBookings.seriesId })
      .from(commerceRentalSeriesBookings)
      .innerJoin(commerceRentalBookings, and(
        eq(commerceRentalBookings.companyId, commerceRentalSeriesBookings.companyId),
        eq(commerceRentalBookings.id, commerceRentalSeriesBookings.bookingId),
      ))
      .where(and(eq(commerceRentalSeriesBookings.companyId, companyId), eq(commerceRentalSeriesBookings.seriesId, seriesId)))
      .orderBy(asc(commerceRentalSeriesBookings.ordinal));
    return rows.map((row) => ({ ...toBooking(row.booking), seriesId: row.seriesId }));
  };

  return {
    getItem: (companyId, itemId) => loadItem(db, companyId, itemId),
    holdingBookings: (companyId, itemId) => loadHolding(db, companyId, itemId),
    async findSeriesByKey(companyId, idempotencyKey) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commerceRentalSeries)
        .where(and(eq(commerceRentalSeries.companyId, companyId), eq(commerceRentalSeries.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (!rows[0]) return null;
      return { series: toSeries(rows[0]), bookings: await seriesBookings(companyId, rows[0].id) };
    },
    async insertSeries(series, bookings) {
      if (!tenantOk(series.companyId)) return "duplicate_key";
      try {
        return await db.transaction(async (tx): Promise<"stored" | "duplicate_key" | "overlap"> => {
          const existing = await tx.select({ id: commerceRentalSeries.id }).from(commerceRentalSeries)
            .where(and(eq(commerceRentalSeries.companyId, series.companyId), eq(commerceRentalSeries.idempotencyKey, series.idempotencyKey)))
            .limit(1);
          if (existing.length > 0) return "duplicate_key";

          // Lock the item's holding bookings across the whole series span, so two series cannot both pass the check.
          const first = bookings[0]?.startsOn ?? series.startsOn;
          const last = bookings[bookings.length - 1]?.endsOn ?? series.startsOn;
          const holding = await lockHoldingInRange(tx, series.companyId, series.itemId, first, last);
          for (const booking of bookings) {
            if (holding.some((other) => other.startsOn <= booking.endsOn && booking.startsOn <= other.endsOn)) {
              return "overlap";
            }
          }

          await tx.insert(commerceRentalSeries).values({
            companyId: series.companyId,
            id: series.id,
            itemId: series.itemId,
            customerRef: series.customerRef,
            startsOn: series.startsOn,
            frequency: series.frequency,
            intervalDays: series.intervalDays,
            durationDays: series.durationDays,
            occurrences: series.occurrences,
            currency: series.currency,
            status: series.status,
            idempotencyKey: series.idempotencyKey,
            requestHash: series.requestHash,
            createdAt: series.createdAt,
          });
          await tx.insert(commerceRentalBookings).values(bookings.map((booking) => ({
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
          })));
          await tx.insert(commerceRentalSeriesBookings).values(bookings.map((booking, index) => ({
            companyId: series.companyId,
            seriesId: series.id,
            bookingId: booking.id,
            ordinal: index + 1,
          })));
          return "stored";
        });
      } catch (error) {
        const code = driverErrorCode(error);
        if (code === "23P01") return "overlap";
        if (code === "23505") return "duplicate_key";
        throw error;
      }
    },
    async cancelSeries(companyId, seriesId) {
      if (!tenantOk(companyId)) return null;
      const cancelled = await db.transaction(async (tx): Promise<{ found: boolean; series: RecurringSeries | null; cancelledBookingIds: string[] }> => {
        const rows = await tx.select().from(commerceRentalSeries)
          .where(and(eq(commerceRentalSeries.companyId, companyId), eq(commerceRentalSeries.id, seriesId)))
          .limit(1)
          .for("update");
        if (!rows[0]) return { found: false, series: null, cancelledBookingIds: [] };
        const series = toSeries(rows[0]);
        if (series.status !== "active") return { found: true, series, cancelledBookingIds: [] };

        const members = await tx.select({ bookingId: commerceRentalSeriesBookings.bookingId, status: commerceRentalBookings.status })
          .from(commerceRentalSeriesBookings)
          .innerJoin(commerceRentalBookings, and(
            eq(commerceRentalBookings.companyId, commerceRentalSeriesBookings.companyId),
            eq(commerceRentalBookings.id, commerceRentalSeriesBookings.bookingId),
          ))
          .where(and(eq(commerceRentalSeriesBookings.companyId, companyId), eq(commerceRentalSeriesBookings.seriesId, seriesId)))
          .for("update");
        const reserved = members.filter((member) => member.status === "reserved").map((member) => member.bookingId);

        await tx.update(commerceRentalSeries).set({ status: "cancelled" })
          .where(and(eq(commerceRentalSeries.companyId, companyId), eq(commerceRentalSeries.id, seriesId)));
        if (reserved.length > 0) {
          await tx.update(commerceRentalBookings).set({ status: "cancelled" })
            .where(and(eq(commerceRentalBookings.companyId, companyId), inArray(commerceRentalBookings.id, reserved)));
        }
        return { found: true, series: { ...series, status: "cancelled" }, cancelledBookingIds: reserved };
      });
      if (!cancelled.found || !cancelled.series) return null;
      return {
        series: cancelled.series,
        bookings: await seriesBookings(companyId, seriesId),
        cancelledBookingIds: cancelled.cancelledBookingIds,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// BNPL offers after creation
// ---------------------------------------------------------------------------

type BnplRow = typeof commerceBnplOffers.$inferSelect;

function toBnplRecord(row: BnplRow): BnplOfferRecord {
  return {
    companyId: row.companyId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    offer: {
      id: row.id,
      companyId: row.companyId,
      orderRef: row.orderRef,
      providerCode: row.providerCode,
      status: row.status as BnplOfferStatus,
      amountMinor: row.amountMinor,
      currency: row.currency,
      installmentCount: row.installmentCount,
      hostedCheckoutUrl: row.hostedCheckoutUrl,
      createdAt: row.createdAt,
    },
    schedule: row.schedule,
    merchantFeeMinor: row.merchantFeeMinor,
  };
}

export function createDrizzleBnplLifecycleStorage(db: MoneyDb): BnplLifecycleStorage {
  const setStatus = async (executor: MoneyDb, companyId: string, offerId: string, from: readonly BnplOfferStatus[], to: BnplOfferStatus): Promise<boolean> => {
    if (from.length === 0 || !tenantOk(companyId)) return false;
    const rows = await executor.update(commerceBnplOffers)
      .set({ status: to })
      .where(and(
        eq(commerceBnplOffers.companyId, companyId),
        eq(commerceBnplOffers.id, offerId),
        inArray(commerceBnplOffers.status, [...from]),
      ))
      .returning({ id: commerceBnplOffers.id });
    return rows.length > 0;
  };

  const storage: BnplLifecycleStorage = {
    async findByKey(companyId, key) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commerceBnplOffers)
        .where(and(eq(commerceBnplOffers.companyId, companyId), eq(commerceBnplOffers.idempotencyKey, key)))
        .limit(1);
      return rows[0] ? toBnplRecord(rows[0]) : null;
    },
    async insert(record) {
      if (!tenantOk(record.companyId)) return false;
      try {
        await db.insert(commerceBnplOffers).values({
          companyId: record.companyId,
          id: record.offer.id,
          providerCode: record.offer.providerCode,
          providerOfferId: record.offer.id,
          orderRef: record.offer.orderRef,
          idempotencyKey: record.idempotencyKey,
          requestHash: record.requestHash,
          status: record.offer.status,
          amountMinor: record.offer.amountMinor,
          currency: record.offer.currency,
          installmentCount: record.offer.installmentCount,
          merchantFeeMinor: record.merchantFeeMinor,
          schedule: [...record.schedule],
          hostedCheckoutUrl: record.offer.hostedCheckoutUrl,
          createdAt: record.offer.createdAt,
        });
        return true;
      } catch (error) {
        if (driverErrorCode(error) === "23505") return false;
        throw error;
      }
    },
    async getOffer(companyId, offerId) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commerceBnplOffers)
        .where(and(eq(commerceBnplOffers.companyId, companyId), eq(commerceBnplOffers.id, offerId)))
        .limit(1);
      return rows[0] ? toBnplRecord(rows[0]) : null;
    },
    setOfferStatus: (companyId, offerId, from, to) => setStatus(db, companyId, offerId, from, to),
    async findWebhookEvent(companyId, provider, eventKey) {
      if (!tenantOk(companyId)) return null;
      const rows = await selectWebhookEventQuery(db, companyId, provider, eventKey);
      return rows[0] ? toWebhook(rows[0]) : null;
    },
    async settleWebhook(input) {
      if (!tenantOk(input.companyId)) return false;
      return db.transaction(async (tx) => {
        const moved = input.offerId !== null && input.to !== null
          ? await setStatus(tx, input.companyId, input.offerId, input.from, input.to)
          : false;
        await tx.insert(commercePaymentWebhookEvents).values({
          companyId: input.companyId,
          id: randomUUID(),
          provider: input.webhook.provider,
          eventKey: input.webhook.eventKey,
          providerEventId: input.webhook.providerEventId,
          eventType: input.webhook.eventType,
          intentId: input.webhook.intentId,
          outcome: input.webhook.outcome,
          receivedAt: input.webhook.receivedAt,
        }).onConflictDoNothing();
        return moved;
      });
    },
  };
  return storage;
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

type CouponRow = typeof commerceCoupons.$inferSelect;
type UsageRow = typeof commerceCouponUsages.$inferSelect;

function toCoupon(row: CouponRow): CouponRecord {
  return {
    companyId: row.companyId,
    id: row.id,
    code: row.code,
    type: row.type as CouponType,
    value: row.value,
    currency: row.currency ?? null,
    minimumMinor: row.minimumMinor,
    maxDiscountMinor: row.maxDiscountMinor ?? null,
    active: row.active,
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    usageLimit: row.usageLimit ?? null,
    usageLimitPerCustomer: row.usageLimitPerCustomer ?? null,
    firstOrderOnly: row.firstOrderOnly,
    channels: row.channels,
    appliesTo: row.appliesTo as CouponAppliesTo,
    targetIds: row.targetIds,
    stackable: row.stackable,
  };
}

function toUsage(row: UsageRow): CouponUsageRecord {
  return {
    companyId: row.companyId,
    id: row.id,
    couponId: row.couponId,
    cartId: row.cartId,
    customerRef: row.customerRef,
    status: row.status as CouponUsageRecord["status"],
    reservedAt: row.reservedAt,
    expiresAt: row.expiresAt ?? null,
    redeemedAt: row.redeemedAt ?? null,
    releasedAt: row.releasedAt ?? null,
  };
}

export function createDrizzleCouponStorage(db: MoneyDb): CouponStorage {
  const liveUsage = async (executor: MoneyDb, companyId: string, couponId: string, excludingCartId: string | null): Promise<UsageRow[]> => {
    const conditions = [
      eq(commerceCouponUsages.companyId, companyId),
      eq(commerceCouponUsages.couponId, couponId),
      inArray(commerceCouponUsages.status, ["reserved", "redeemed"]),
    ];
    if (excludingCartId !== null) {
      conditions.push(ne(commerceCouponUsages.cartId, excludingCartId));
    }
    return executor.select().from(commerceCouponUsages).where(and(...conditions));
  };

  return {
    async findCouponByCode(companyId, code) {
      if (!tenantOk(companyId)) return null;
      const rows = await db.select().from(commerceCoupons)
        .where(and(eq(commerceCoupons.companyId, companyId), eq(commerceCoupons.code, code)))
        .limit(1);
      return rows[0] ? toCoupon(rows[0]) : null;
    },
    async insertCoupon(record) {
      if (!tenantOk(record.companyId)) return false;
      try {
        await db.insert(commerceCoupons).values({
          companyId: record.companyId,
          id: record.id,
          code: record.code,
          type: record.type,
          value: record.value,
          currency: record.currency,
          minimumMinor: record.minimumMinor,
          maxDiscountMinor: record.maxDiscountMinor,
          active: record.active,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          usageLimit: record.usageLimit,
          usageLimitPerCustomer: record.usageLimitPerCustomer,
          firstOrderOnly: record.firstOrderOnly,
          channels: [...record.channels],
          appliesTo: record.appliesTo,
          targetIds: [...record.targetIds],
          stackable: record.stackable,
        });
        return true;
      } catch (error) {
        if (driverErrorCode(error) === "23505") return false;
        throw error;
      }
    },
    async countActiveUsage(companyId, couponId, excludingCartId, customerRef, now): Promise<CouponUsageCounts> {
      if (!tenantOk(companyId)) return { total: 0, forCustomer: 0 };
      const rows = await liveUsage(db, companyId, couponId, excludingCartId);
      return countCouponUsage(rows.map(toUsage), companyId, couponId, excludingCartId, customerRef, now);
    },
    async reserveUsage(input) {
      if (!tenantOk(input.companyId)) {
        throw new MoneyError("not_found", "The coupon was not found.");
      }
      return db.transaction(async (tx) => {
        // Lock the coupon row so two carts cannot both take the last use.
        const locked = await tx.select({ id: commerceCoupons.id }).from(commerceCoupons)
          .where(and(eq(commerceCoupons.companyId, input.companyId), eq(commerceCoupons.id, input.coupon.id)))
          .for("update");
        if (locked.length === 0) {
          throw new MoneyError("not_found", "The coupon was not found.");
        }
        const live = await liveUsage(tx, input.companyId, input.coupon.id, input.cartId);
        input.check(countCouponUsage(live.map(toUsage), input.companyId, input.coupon.id, input.cartId, input.customerRef, input.now));

        await tx.update(commerceCouponUsages)
          .set({ status: "released", releasedAt: input.now, updatedAt: input.now })
          .where(and(
            eq(commerceCouponUsages.companyId, input.companyId),
            eq(commerceCouponUsages.cartId, input.cartId),
            ne(commerceCouponUsages.couponId, input.coupon.id),
            eq(commerceCouponUsages.status, "reserved"),
          ));

        const existingRows = await tx.select().from(commerceCouponUsages)
          .where(and(
            eq(commerceCouponUsages.companyId, input.companyId),
            eq(commerceCouponUsages.couponId, input.coupon.id),
            eq(commerceCouponUsages.cartId, input.cartId),
          ))
          .limit(1)
          .for("update");
        const existing = existingRows[0];
        if (existing && existing.status === "redeemed") {
          return toUsage(existing);
        }
        if (existing) {
          const [updated] = await tx.update(commerceCouponUsages)
            .set({
              status: "reserved",
              customerRef: input.customerRef,
              expiresAt: input.expiresAt,
              releasedAt: null,
              updatedAt: input.now,
            })
            .where(and(eq(commerceCouponUsages.companyId, input.companyId), eq(commerceCouponUsages.id, existing.id)))
            .returning();
          return toUsage(updated);
        }
        const [created] = await tx.insert(commerceCouponUsages).values({
          companyId: input.companyId,
          id: randomUUID(),
          couponId: input.coupon.id,
          cartId: input.cartId,
          customerRef: input.customerRef,
          status: "reserved",
          reservedAt: input.now,
          expiresAt: input.expiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        }).returning();
        return toUsage(created);
      });
    },
    async redeemCart(companyId, cartId, now) {
      if (!tenantOk(companyId)) return 0;
      const rows = await db.update(commerceCouponUsages)
        .set({ status: "redeemed", redeemedAt: now, expiresAt: null, updatedAt: now })
        .where(and(eq(commerceCouponUsages.companyId, companyId), eq(commerceCouponUsages.cartId, cartId), eq(commerceCouponUsages.status, "reserved")))
        .returning({ id: commerceCouponUsages.id });
      return rows.length;
    },
    async releaseCart(companyId, cartId, now) {
      if (!tenantOk(companyId)) return 0;
      const rows = await db.update(commerceCouponUsages)
        .set({ status: "released", releasedAt: now, expiresAt: null, updatedAt: now })
        .where(and(eq(commerceCouponUsages.companyId, companyId), eq(commerceCouponUsages.cartId, cartId), eq(commerceCouponUsages.status, "reserved")))
        .returning({ id: commerceCouponUsages.id });
      return rows.length;
    },
    async expireDue(companyId, now, limit) {
      if (!tenantOk(companyId)) return 0;
      const due = await db.select({ id: commerceCouponUsages.id }).from(commerceCouponUsages)
        .where(and(
          eq(commerceCouponUsages.companyId, companyId),
          eq(commerceCouponUsages.status, "reserved"),
          lte(commerceCouponUsages.expiresAt, now),
        ))
        .orderBy(asc(commerceCouponUsages.reservedAt))
        .limit(limit);
      if (due.length === 0) return 0;
      const rows = await db.update(commerceCouponUsages)
        .set({ status: "expired", releasedAt: now, updatedAt: now })
        .where(and(
          eq(commerceCouponUsages.companyId, companyId),
          eq(commerceCouponUsages.status, "reserved"),
          inArray(commerceCouponUsages.id, due.map((row) => row.id)),
        ))
        .returning({ id: commerceCouponUsages.id });
      return rows.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Tax exemptions
// ---------------------------------------------------------------------------

type ExemptionRow = typeof commerceTaxExemptions.$inferSelect;

function toExemption(row: ExemptionRow): TaxExemptionRecord {
  return {
    companyId: row.companyId,
    id: row.id,
    exemptionKey: row.exemptionKey ?? null,
    customerRef: row.customerRef ?? null,
    taxClass: row.taxClass ?? null,
    reason: row.reason ?? null,
    active: row.active,
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    createdAt: row.createdAt,
  };
}

export function createDrizzleTaxExemptionStorage(db: MoneyDb): TaxExemptionStorage {
  return {
    async findMatching(companyId: string, subject: TaxExemptionSubject, at: Date): Promise<TaxExemptionRecord[]> {
      if (!tenantOk(companyId)) return [];
      const binding = [];
      if (subject.exemptionKey !== null) binding.push(eq(commerceTaxExemptions.exemptionKey, subject.exemptionKey));
      if (subject.customerRef !== null) binding.push(eq(commerceTaxExemptions.customerRef, subject.customerRef));
      if (binding.length === 0) return [];
      const rows = await db.select().from(commerceTaxExemptions)
        .where(and(
          eq(commerceTaxExemptions.companyId, companyId),
          eq(commerceTaxExemptions.active, true),
          or(isNull(commerceTaxExemptions.startsAt), lte(commerceTaxExemptions.startsAt, at)),
          or(isNull(commerceTaxExemptions.endsAt), gte(commerceTaxExemptions.endsAt, at)),
          or(...binding),
        ));
      return rows.map(toExemption).filter((record) => exemptionApplies(record, subject, at));
    },
    async insert(record) {
      if (!tenantOk(record.companyId)) return false;
      try {
        await db.insert(commerceTaxExemptions).values({
          companyId: record.companyId,
          id: record.id,
          exemptionKey: record.exemptionKey,
          customerRef: record.customerRef,
          taxClass: record.taxClass,
          reason: record.reason,
          active: record.active,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          createdAt: record.createdAt,
        });
        return true;
      } catch (error) {
        if (driverErrorCode(error) === "23505") return false;
        throw error;
      }
    },
    async deactivate(companyId, id) {
      if (!tenantOk(companyId)) return false;
      const rows = await db.update(commerceTaxExemptions)
        .set({ active: false })
        .where(and(eq(commerceTaxExemptions.companyId, companyId), eq(commerceTaxExemptions.id, id)))
        .returning({ id: commerceTaxExemptions.id });
      return rows.length > 0;
    },
  };
}

