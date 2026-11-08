/**
 * Item hire: availability by date range, a refundable deposit, and a late-return fee.
 *
 * Not in the PHP source. Commerce Crew's RentalHireRuntime.php handles recurring rent and hire receivables
 * (agreements, charges, payments, ledger). It has no item availability, deposit or late-return logic. These rules are
 * new design for this port. See DECISIONS.md.
 *
 * Dates are calendar days (YYYY-MM-DD) and bookings are inclusive: a booking from 10 to 12 March holds the item on
 * 10, 11 and 12 March. Two bookings clash when their date ranges share at least one day. A reserved or active
 * booking holds the item. A returned or cancelled booking does not.
 *
 * Money is integer minor units. The late fee is charged per day after the grace days, up to an optional cap.
 * Deposit settlement takes the late fee from the deposit first, and only charges the customer if the fee is larger.
 */
import { randomUUID } from "node:crypto";
import type { FlagEnv } from "../../contracts/index.ts";
import { isRentalHireEnabled } from "./flags.ts";
import { assertMinor, MoneyError, multiplyMinor, normaliseCurrency } from "./money.ts";
import { createKeyedLock, hashRequest, requiredIdempotencyKey } from "./request-keys.ts";

export const RENTAL_MAX_DAYS = 365;
const DAY_MS = 86_400_000;

export interface HireItem {
  readonly companyId: string;
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly currency: string;
  readonly dailyRateMinor: number;
  readonly depositMinor: number;
  readonly lateFeePerDayMinor: number;
  /** Null means no cap on the late fee. */
  readonly lateFeeCapMinor: number | null;
  /** Days after the end date that are not charged. */
  readonly graceDays: number;
  readonly active: boolean;
}

export type HireBookingStatus = "reserved" | "active" | "returned" | "cancelled";

export interface HireBooking {
  readonly companyId: string;
  readonly id: string;
  readonly itemId: string;
  readonly customerRef: string | null;
  /** Set when the booking is one occurrence of a recurring series (see recurring-rental.ts). */
  readonly seriesId?: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly currency: string;
  readonly rentalMinor: number;
  readonly depositMinor: number;
  status: HireBookingStatus;
  returnedOn: string | null;
  lateDays: number;
  lateFeeMinor: number;
  depositReturnedMinor: number;
  amountDueMinor: number;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  version: number;
  readonly createdAt: Date;
  updatedAt: Date;
}

export interface HireStorage {
  getItem(companyId: string, itemId: string): Promise<HireItem | null>;
  /** Reserved and active bookings for one item. Other statuses do not hold the item. */
  holdingBookings(companyId: string, itemId: string): Promise<HireBooking[]>;
  findBookingByKey(companyId: string, idempotencyKey: string): Promise<HireBooking | null>;
  getBooking(companyId: string, id: string): Promise<HireBooking | null>;
  /** Returns false when the key already exists for this company. */
  insertBooking(booking: HireBooking): Promise<boolean>;
  updateBooking(companyId: string, id: string, expectedVersion: number, patch: Partial<Pick<HireBooking, "status" | "returnedOn" | "lateDays" | "lateFeeMinor" | "depositReturnedMinor" | "amountDueMinor">>, now: Date): Promise<boolean>;
}

/** Calendar date check. Rejects values that JavaScript would roll over, such as 2026-02-30. */
export function assertCalendarDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MoneyError("validation", `${field} must be a date in YYYY-MM-DD form.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MoneyError("validation", `${field} is not a real calendar date.`);
  }
  return value;
}

/** Whole days from one calendar date to another. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Inclusive day count of a booking. Starting and ending on the same day is one day. */
export function inclusiveDays(startsOn: string, endsOn: string): number {
  return daysBetween(startsOn, endsOn) + 1;
}

/** Two inclusive date ranges clash when they share at least one day. */
export function rangesOverlap(a: { startsOn: string; endsOn: string }, b: { startsOn: string; endsOn: string }): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

export interface HireQuote {
  readonly days: number;
  readonly rentalMinor: number;
  readonly depositMinor: number;
  readonly currency: string;
}

export function hireQuote(item: HireItem, startsOn: string, endsOn: string): HireQuote {
  const start = assertCalendarDate(startsOn, "Start date");
  const end = assertCalendarDate(endsOn, "End date");
  const days = inclusiveDays(start, end);
  if (days < 1) {
    throw new MoneyError("validation", "The end date cannot be before the start date.");
  }
  if (days > RENTAL_MAX_DAYS) {
    throw new MoneyError("validation", `A hire period cannot be longer than ${RENTAL_MAX_DAYS} days.`);
  }
  return {
    days,
    rentalMinor: multiplyMinor(assertMinor(item.dailyRateMinor, "Daily rate"), days),
    depositMinor: assertMinor(item.depositMinor, "Deposit"),
    currency: item.currency,
  };
}

export interface LateReturn {
  readonly lateDays: number;
  readonly lateFeeMinor: number;
}

/** Late-return fee: days past the end date beyond the grace days, times the daily fee, capped when a cap is set. */
export function lateReturnFee(item: Pick<HireItem, "lateFeePerDayMinor" | "lateFeeCapMinor" | "graceDays">, endsOn: string, returnedOn: string): LateReturn {
  const lateDays = Math.max(0, daysBetween(endsOn, returnedOn));
  const chargeableDays = Math.max(0, lateDays - Math.max(0, item.graceDays));
  let fee = multiplyMinor(assertMinor(item.lateFeePerDayMinor, "Late fee"), chargeableDays);
  if (item.lateFeeCapMinor !== null) {
    fee = Math.min(fee, assertMinor(item.lateFeeCapMinor, "Late fee cap"));
  }
  return { lateDays, lateFeeMinor: fee };
}

/** Deposit settlement. The late fee comes out of the deposit first. Any excess is due from the customer. */
export function settleDeposit(depositMinor: number, lateFeeMinor: number): { depositReturnedMinor: number; amountDueMinor: number } {
  return {
    depositReturnedMinor: Math.max(0, depositMinor - lateFeeMinor),
    amountDueMinor: Math.max(0, lateFeeMinor - depositMinor),
  };
}

export interface HireServiceOptions {
  readonly storage: HireStorage;
  readonly env: FlagEnv;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface BookInput {
  readonly companyId: string;
  readonly itemId: string;
  readonly customerRef: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly idempotencyKey: string;
}

export interface BookResult {
  readonly booking: HireBooking;
  readonly replayed: boolean;
}

export interface HireService {
  quote(companyId: string, itemId: string, startsOn: string, endsOn: string): Promise<HireQuote>;
  book(input: BookInput): Promise<BookResult>;
  collect(companyId: string, bookingId: string): Promise<HireBooking>;
  recordReturn(companyId: string, bookingId: string, returnedOn: string): Promise<HireBooking>;
  cancel(companyId: string, bookingId: string): Promise<HireBooking>;
}

function requireCompany(value: unknown): string {
  const companyId = typeof value === "string" ? value.trim() : "";
  if (companyId === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  return companyId;
}

export function createRentalHireService(options: HireServiceOptions): HireService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const withLock = createKeyedLock();

  const assertEnabled = (): void => {
    if (!isRentalHireEnabled(options.env)) {
      throw new MoneyError("disabled", "Rental and hire is not enabled.");
    }
  };

  const loadBooking = async (companyId: string, bookingId: string): Promise<HireBooking> => {
    const booking = await options.storage.getBooking(companyId, bookingId);
    if (!booking) {
      throw new MoneyError("not_found", "The hire booking was not found.");
    }
    return booking;
  };

  const transition = async (
    companyId: string,
    bookingId: string,
    allowedFrom: readonly HireBookingStatus[],
    patch: Parameters<HireStorage["updateBooking"]>[3],
    message: string,
  ): Promise<HireBooking> => {
    return withLock(`${companyId}\u0000booking\u0000${bookingId}`, async () => {
      const booking = await loadBooking(companyId, bookingId);
      if (!allowedFrom.includes(booking.status)) {
        throw new MoneyError("state", message);
      }
      const saved = await options.storage.updateBooking(companyId, bookingId, booking.version, patch, now());
      if (!saved) {
        throw new MoneyError("conflict", "The booking changed while this request ran. Retry.");
      }
      return loadBooking(companyId, bookingId);
    });
  };

  return {
    async quote(companyId, itemId, startsOn, endsOn) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      const item = await options.storage.getItem(tenant, itemId);
      if (!item || !item.active) {
        throw new MoneyError("not_found", "The item is not available for hire.");
      }
      return hireQuote(item, startsOn, endsOn);
    },

    async book(input) {
      assertEnabled();
      const companyId = requireCompany(input.companyId);
      const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
      const startsOn = assertCalendarDate(input.startsOn, "Start date");
      const endsOn = assertCalendarDate(input.endsOn, "End date");
      const customerRef = input.customerRef ?? null;
      const requestHash = hashRequest({ itemId: input.itemId, customerRef, startsOn, endsOn });

      return withLock(`${companyId}\u0000item\u0000${input.itemId}`, async (): Promise<BookResult> => {
        const stored = await options.storage.findBookingByKey(companyId, idempotencyKey);
        if (stored) {
          if (stored.requestHash !== requestHash) {
            throw new MoneyError("conflict", "The idempotency key was already used for another booking.");
          }
          return { booking: stored, replayed: true };
        }

        const item = await options.storage.getItem(companyId, input.itemId);
        if (!item || !item.active) {
          throw new MoneyError("not_found", "The item is not available for hire.");
        }
        const quote = hireQuote(item, startsOn, endsOn);
        const holding = await options.storage.holdingBookings(companyId, input.itemId);
        if (holding.some((other) => rangesOverlap(other, { startsOn, endsOn }))) {
          throw new MoneyError("conflict", "The item is already booked for overlapping dates.");
        }

        const stamp = now();
        const booking: HireBooking = {
          companyId,
          id: `hire_${newId()}`,
          itemId: input.itemId,
          customerRef,
          startsOn,
          endsOn,
          currency: normaliseCurrency(item.currency),
          rentalMinor: quote.rentalMinor,
          depositMinor: quote.depositMinor,
          status: "reserved",
          returnedOn: null,
          lateDays: 0,
          lateFeeMinor: 0,
          depositReturnedMinor: 0,
          amountDueMinor: 0,
          requestHash,
          idempotencyKey,
          version: 0,
          createdAt: stamp,
          updatedAt: stamp,
        };
        if (!(await options.storage.insertBooking(booking))) {
          throw new MoneyError("conflict", "The booking could not be stored. Retry with the same key.");
        }
        return { booking, replayed: false };
      });
    },

    async collect(companyId, bookingId) {
      assertEnabled();
      return transition(requireCompany(companyId), bookingId, ["reserved"], { status: "active" }, "Only a reserved booking can be collected.");
    },

    async recordReturn(companyId, bookingId, returnedOnInput) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      const returnedOn = assertCalendarDate(returnedOnInput, "Return date");
      return withLock(`${tenant}\u0000booking\u0000${bookingId}`, async () => {
        const booking = await loadBooking(tenant, bookingId);
        if (booking.status === "returned") {
          if (booking.returnedOn === returnedOn) {
            return booking;
          }
          throw new MoneyError("conflict", "This booking was already returned on a different date.");
        }
        if (booking.status !== "reserved" && booking.status !== "active") {
          throw new MoneyError("state", "Only a reserved or active booking can be returned.");
        }
        if (returnedOn < booking.startsOn) {
          throw new MoneyError("validation", "The return date cannot be before the start date.");
        }
        const item = await options.storage.getItem(tenant, booking.itemId);
        if (!item) {
          throw new MoneyError("not_found", "The item was not found.");
        }
        const late = lateReturnFee(item, booking.endsOn, returnedOn);
        const settled = settleDeposit(booking.depositMinor, late.lateFeeMinor);
        const saved = await options.storage.updateBooking(tenant, bookingId, booking.version, {
          status: "returned",
          returnedOn,
          lateDays: late.lateDays,
          lateFeeMinor: late.lateFeeMinor,
          depositReturnedMinor: settled.depositReturnedMinor,
          amountDueMinor: settled.amountDueMinor,
        }, now());
        if (!saved) {
          throw new MoneyError("conflict", "The booking changed while this request ran. Retry.");
        }
        return loadBooking(tenant, bookingId);
      });
    },

    async cancel(companyId, bookingId) {
      assertEnabled();
      return transition(requireCompany(companyId), bookingId, ["reserved"], { status: "cancelled" }, "Only a reserved booking can be cancelled.");
    },
  };
}
