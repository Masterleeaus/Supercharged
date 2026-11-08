/**
 * In-memory HireStorage for tests and local runs. The Drizzle version is in drizzle-queries.ts. In production the
 * booking overlap is guarded again by the exclusion constraint in db/migrations-draft, so two processes cannot
 * both insert an overlapping booking.
 */
import type { HireBooking, HireItem, HireStorage } from "./rental-hire.ts";

export function createMemoryHireStorage(items: readonly HireItem[]): HireStorage & { readonly bookings: ReadonlyMap<string, HireBooking> } {
  const itemMap = new Map<string, HireItem>(items.map((item) => [`${item.companyId}\u0000${item.id}`, item]));
  const bookings = new Map<string, HireBooking>();
  const scoped = (companyId: string, id: string): string => `${companyId}\u0000${id}`;

  return {
    bookings,
    async getItem(companyId, itemId) {
      const item = itemMap.get(scoped(companyId, itemId));
      return item && item.companyId === companyId ? item : null;
    },
    async holdingBookings(companyId, itemId) {
      return [...bookings.values()].filter((booking) =>
        booking.companyId === companyId
        && booking.itemId === itemId
        && (booking.status === "reserved" || booking.status === "active"),
      );
    },
    async findBookingByKey(companyId, idempotencyKey) {
      for (const booking of bookings.values()) {
        if (booking.companyId === companyId && booking.idempotencyKey === idempotencyKey) {
          return booking;
        }
      }
      return null;
    },
    async getBooking(companyId, id) {
      const booking = bookings.get(scoped(companyId, id));
      return booking && booking.companyId === companyId ? booking : null;
    },
    async insertBooking(booking) {
      for (const existing of bookings.values()) {
        if (existing.companyId === booking.companyId && existing.idempotencyKey === booking.idempotencyKey) {
          return false;
        }
      }
      bookings.set(scoped(booking.companyId, booking.id), booking);
      return true;
    },
    async updateBooking(companyId, id, expectedVersion, patch, now) {
      const booking = bookings.get(scoped(companyId, id));
      if (!booking || booking.companyId !== companyId || booking.version !== expectedVersion) {
        return false;
      }
      if (patch.status !== undefined) booking.status = patch.status;
      if (patch.returnedOn !== undefined) booking.returnedOn = patch.returnedOn;
      if (patch.lateDays !== undefined) booking.lateDays = patch.lateDays;
      if (patch.lateFeeMinor !== undefined) booking.lateFeeMinor = patch.lateFeeMinor;
      if (patch.depositReturnedMinor !== undefined) booking.depositReturnedMinor = patch.depositReturnedMinor;
      if (patch.amountDueMinor !== undefined) booking.amountDueMinor = patch.amountDueMinor;
      booking.version = expectedVersion + 1;
      booking.updatedAt = now;
      return true;
    },
  };
}
