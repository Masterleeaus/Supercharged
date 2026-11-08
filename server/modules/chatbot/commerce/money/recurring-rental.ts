/**
 * Recurring rental bookings: one item hired again and again on a fixed spacing, for example every week for ten weeks.
 *
 * Source note: RentalHireRuntime.php models recurring rent as agreements that raise charges per billing period. It
 * has no item availability, so it cannot say whether two recurring rentals clash. This module is new design and
 * books the item. Each occurrence is an ordinary hire booking (see rental-hire.ts) with a seriesId, so collect, return
 * and late-fee rules apply to each occurrence. See DECISIONS.md.
 *
 * Rules:
 * - Occurrence n starts n * intervalDays after the first start, and lasts durationDays inclusive.
 * - The interval must be at least the duration, so occurrences of one series never overlap each other.
 * - Every occurrence is checked against the item's holding bookings (reserved or active), from any series or single hire.
 *   If any occurrence clashes, the whole series is refused and nothing is written.
 * - The series and all its occurrences are written in one storage transaction. The Drizzle store also relies on the
 *   exclusion constraint for bookings, so two processes cannot both store an overlapping occurrence.
 */
import { randomUUID } from "node:crypto";
import type { FlagEnv } from "../../contracts/index.ts";
import type { HireBooking, HireItem } from "./rental-hire.ts";
import { assertCalendarDate, hireQuote, rangesOverlap, RENTAL_MAX_DAYS } from "./rental-hire.ts";
import { isRentalHireEnabled } from "./flags.ts";
import { MoneyError, normaliseCurrency } from "./money.ts";
import { createKeyedLock, hashRequest, requiredIdempotencyKey } from "./request-keys.ts";

export const RECURRING_FREQUENCIES = ["weekly", "fortnightly", "custom"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const RECURRING_MAX_OCCURRENCES = 52;
const MAX_CUSTOM_INTERVAL_DAYS = 365;
const DAY_MS = 86_400_000;

export interface RecurringSeries {
  readonly companyId: string;
  readonly id: string;
  readonly itemId: string;
  readonly customerRef: string | null;
  readonly startsOn: string;
  readonly frequency: RecurringFrequency;
  readonly intervalDays: number;
  readonly durationDays: number;
  readonly occurrences: number;
  readonly currency: string;
  readonly status: "active" | "cancelled";
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly createdAt: Date;
}

export interface RecurringRentalInput {
  readonly companyId: string;
  readonly itemId: string;
  readonly customerRef: string | null;
  readonly startsOn: string;
  readonly frequency: RecurringFrequency;
  /** Required for the custom frequency, from 1 to 365 days. Ignored otherwise. */
  readonly customIntervalDays?: number | null;
  readonly durationDays: number;
  readonly occurrences: number;
  readonly idempotencyKey: string;
}

export interface RecurringStorage {
  getItem(companyId: string, itemId: string): Promise<HireItem | null>;
  /** Reserved and active bookings for one item, from any series or single hire. */
  holdingBookings(companyId: string, itemId: string): Promise<HireBooking[]>;
  findSeriesByKey(companyId: string, idempotencyKey: string): Promise<{ series: RecurringSeries; bookings: HireBooking[] } | null>;
  /**
   * Stores the series and every occurrence in one transaction. Returns "duplicate_key" when the key is taken, and
   * "overlap" when the database refuses an occurrence that clashes. Nothing is stored in either case.
   */
  insertSeries(series: RecurringSeries, bookings: readonly HireBooking[]): Promise<"stored" | "duplicate_key" | "overlap">;
  /**
   * Cancels a series in one transaction: marks it cancelled and cancels its occurrences that are still reserved.
   * Active and returned occurrences are left alone. A series that is already cancelled is returned unchanged with no
   * cancelled ids. Returns null when the series does not exist for this company.
   */
  cancelSeries(companyId: string, seriesId: string): Promise<RecurringCancelResult | null>;
}

export interface RecurringCancelResult {
  readonly series: RecurringSeries;
  readonly bookings: HireBooking[];
  /** Ids of the occurrences this call cancelled. Empty on a repeat call. */
  readonly cancelledBookingIds: string[];
}

export interface RecurringBookResult {
  readonly series: RecurringSeries;
  readonly bookings: readonly HireBooking[];
  readonly replayed: boolean;
  readonly totalRentalMinor: number;
  readonly totalDepositMinor: number;
}

export interface RecurringRentalOptions {
  readonly storage: RecurringStorage;
  readonly env: FlagEnv;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface RecurringRentalService {
  book(input: RecurringRentalInput): Promise<RecurringBookResult>;
  /** Cancels a series and its reserved occurrences. Returns null when the series is not found for this company. */
  cancel(companyId: string, seriesId: string): Promise<RecurringCancelResult | null>;
}

export function recurrenceIntervalDays(frequency: RecurringFrequency, customIntervalDays: number | null | undefined): number {
  if (frequency === "weekly") return 7;
  if (frequency === "fortnightly") return 14;
  if (!Number.isSafeInteger(customIntervalDays) || (customIntervalDays as number) < 1 || (customIntervalDays as number) > MAX_CUSTOM_INTERVAL_DAYS) {
    throw new MoneyError("validation", `A custom interval must be a whole number of days from 1 to ${MAX_CUSTOM_INTERVAL_DAYS}.`);
  }
  return customIntervalDays as number;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive start and end dates for each occurrence. Pure. */
export function occurrenceDates(startsOn: string, intervalDays: number, durationDays: number, occurrences: number): Array<{ startsOn: string; endsOn: string }> {
  const rows: Array<{ startsOn: string; endsOn: string }> = [];
  for (let index = 0; index < occurrences; index += 1) {
    const start = addDays(startsOn, index * intervalDays);
    rows.push({ startsOn: start, endsOn: addDays(start, durationDays - 1) });
  }
  return rows;
}

function requireCompany(value: unknown): string {
  const companyId = typeof value === "string" ? value.trim() : "";
  if (companyId === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  return companyId;
}

function boundedInteger(value: unknown, min: number, max: number, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new MoneyError("validation", message);
  }
  return value as number;
}

export function createRecurringRentalService(options: RecurringRentalOptions): RecurringRentalService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const withLock = createKeyedLock();

  return {
    async book(input) {
      if (!isRentalHireEnabled(options.env)) {
        throw new MoneyError("disabled", "Rental and hire is not enabled.");
      }
      const companyId = requireCompany(input.companyId);
      const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
      const itemId = typeof input.itemId === "string" ? input.itemId.trim() : "";
      if (itemId === "") {
        throw new MoneyError("validation", "An item is required.");
      }
      if (!(RECURRING_FREQUENCIES as readonly string[]).includes(input.frequency)) {
        throw new MoneyError("validation", "The recurring frequency is not supported.");
      }
      const startsOn = assertCalendarDate(input.startsOn, "Start date");
      const durationDays = boundedInteger(input.durationDays, 1, RENTAL_MAX_DAYS, `A rental period must be from 1 to ${RENTAL_MAX_DAYS} days.`);
      const occurrences = boundedInteger(input.occurrences, 1, RECURRING_MAX_OCCURRENCES, `A recurring rental has from 1 to ${RECURRING_MAX_OCCURRENCES} occurrences.`);
      const intervalDays = recurrenceIntervalDays(input.frequency, input.customIntervalDays);
      if (intervalDays < durationDays) {
        throw new MoneyError("validation", "The interval must be at least as long as the rental, so occurrences do not overlap.");
      }
      const customerRef = input.customerRef ?? null;
      const requestHash = hashRequest({ itemId, customerRef, startsOn, frequency: input.frequency, intervalDays, durationDays, occurrences });
      const dates = occurrenceDates(startsOn, intervalDays, durationDays, occurrences);

      return withLock(`${companyId}\u0000item\u0000${itemId}`, async (): Promise<RecurringBookResult> => {
        const stored = await options.storage.findSeriesByKey(companyId, idempotencyKey);
        if (stored) {
          if (stored.series.requestHash !== requestHash) {
            throw new MoneyError("conflict", "The idempotency key was already used for another recurring booking.");
          }
          return summarise(stored.series, stored.bookings, true);
        }

        const item = await options.storage.getItem(companyId, itemId);
        if (!item || !item.active) {
          throw new MoneyError("not_found", "The item is not available for hire.");
        }
        const currency = normaliseCurrency(item.currency);
        const quotes = dates.map((range) => hireQuote(item, range.startsOn, range.endsOn));

        const holding = await options.storage.holdingBookings(companyId, itemId);
        for (const dateRange of dates) {
          if (holding.some((other) => rangesOverlap(other, dateRange))) {
            throw new MoneyError("conflict", `The item is already booked for ${dateRange.startsOn} to ${dateRange.endsOn}.`);
          }
        }

        const stamp = now();
        const seriesId = `rser_${newId()}`;
        const series: RecurringSeries = {
          companyId,
          id: seriesId,
          itemId,
          customerRef,
          startsOn,
          frequency: input.frequency,
          intervalDays,
          durationDays,
          occurrences,
          currency,
          status: "active",
          idempotencyKey,
          requestHash,
          createdAt: stamp,
        };
        const bookings: HireBooking[] = dates.map((dateRange, index) => ({
          companyId,
          id: `hire_${newId()}`,
          itemId,
          customerRef,
          seriesId,
          startsOn: dateRange.startsOn,
          endsOn: dateRange.endsOn,
          currency,
          rentalMinor: quotes[index].rentalMinor,
          depositMinor: quotes[index].depositMinor,
          status: "reserved",
          returnedOn: null,
          lateDays: 0,
          lateFeeMinor: 0,
          depositReturnedMinor: 0,
          amountDueMinor: 0,
          requestHash,
          idempotencyKey: `${idempotencyKey}#${index + 1}`,
          version: 0,
          createdAt: stamp,
          updatedAt: stamp,
        }));

        const outcome = await options.storage.insertSeries(series, bookings);
        if (outcome === "overlap") {
          throw new MoneyError("conflict", "The item is already booked for overlapping dates.");
        }
        if (outcome === "duplicate_key") {
          throw new MoneyError("conflict", "The recurring booking could not be stored. Retry with the same key.");
        }
        return summarise(series, bookings, false);
      });
    },
    async cancel(companyId, seriesId) {
      if (typeof companyId !== "string" || companyId.length === 0) {
        throw new MoneyError("validation", "A company is required.");
      }
      return options.storage.cancelSeries(companyId, seriesId);
    },
  };
}

function summarise(series: RecurringSeries, bookings: readonly HireBooking[], replayed: boolean): RecurringBookResult {
  return {
    series,
    bookings,
    replayed,
    totalRentalMinor: bookings.reduce((sum, booking) => sum + booking.rentalMinor, 0),
    totalDepositMinor: bookings.reduce((sum, booking) => sum + booking.depositMinor, 0),
  };
}

/** In-memory RecurringStorage for tests and local runs. */
export function createMemoryRecurringStorage(items: readonly HireItem[]): RecurringStorage & {
  readonly series: ReadonlyMap<string, RecurringSeries>;
  readonly bookings: ReadonlyMap<string, HireBooking>;
} {
  const itemMap = new Map<string, HireItem>(items.map((item) => [`${item.companyId}\u0000${item.id}`, item]));
  const seriesMap = new Map<string, RecurringSeries>();
  const keyIndex = new Map<string, string>();
  const bookingMap = new Map<string, HireBooking>();
  const scoped = (companyId: string, id: string): string => `${companyId}\u0000${id}`;
  const holding = (booking: HireBooking): boolean => booking.status === "reserved" || booking.status === "active";

  return {
    series: seriesMap,
    bookings: bookingMap,
    async getItem(companyId, itemId) {
      const item = itemMap.get(scoped(companyId, itemId));
      return item && item.companyId === companyId ? item : null;
    },
    async holdingBookings(companyId, itemId) {
      return [...bookingMap.values()].filter((booking) => booking.companyId === companyId && booking.itemId === itemId && holding(booking));
    },
    async findSeriesByKey(companyId, idempotencyKey) {
      const seriesId = keyIndex.get(scoped(companyId, idempotencyKey));
      const series = seriesId ? seriesMap.get(scoped(companyId, seriesId)) : undefined;
      if (!series) return null;
      const bookings = [...bookingMap.values()].filter((booking) => booking.companyId === companyId && booking.seriesId === series.id);
      return { series, bookings };
    },
    async insertSeries(series, bookings) {
      if (keyIndex.has(scoped(series.companyId, series.idempotencyKey))) {
        return "duplicate_key";
      }
      const current = [...bookingMap.values()].filter((booking) => booking.companyId === series.companyId && booking.itemId === series.itemId && holding(booking));
      for (const booking of bookings) {
        if (current.some((other) => rangesOverlap(other, booking))) {
          return "overlap";
        }
      }
      seriesMap.set(scoped(series.companyId, series.id), series);
      keyIndex.set(scoped(series.companyId, series.idempotencyKey), series.id);
      for (const booking of bookings) {
        bookingMap.set(scoped(booking.companyId, booking.id), booking);
      }
      return "stored";
    },
    async cancelSeries(companyId, seriesId) {
      const key = scoped(companyId, seriesId);
      const existing = seriesMap.get(key);
      if (!existing || existing.companyId !== companyId) return null;
      const cancelledBookingIds: string[] = [];
      if (existing.status === "active") {
        seriesMap.set(key, { ...existing, status: "cancelled" });
        for (const booking of bookingMap.values()) {
          if (booking.companyId === companyId && booking.seriesId === seriesId && booking.status === "reserved") {
            bookingMap.set(scoped(companyId, booking.id), { ...booking, status: "cancelled" });
            cancelledBookingIds.push(booking.id);
          }
        }
      }
      const bookings = [...bookingMap.values()].filter((booking) => booking.companyId === companyId && booking.seriesId === seriesId);
      return { series: seriesMap.get(key) as RecurringSeries, bookings, cancelledBookingIds };
    },
  };
}
