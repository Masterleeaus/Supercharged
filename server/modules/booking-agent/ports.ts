/*
 * Ports for the booking agent. Desk supplies real implementations later (see
 * PORT-MAP.md). Every method takes companyId as its first argument and must scope
 * all reads and writes to it.
 */

export interface BookingCreateRequest {
  slot: string;
  name: string;
  email: string;
  timezone: string;
  phone?: string;
}

/**
 * Calendar side: the external calendar or booking provider. In PHP this is
 * BookingProviderInterface (Cal.com, Calendly). A null or false return means the
 * provider refused the action; the dispatcher turns that into the source's failure
 * message.
 */
export interface BookingCalendar {
  createBooking(companyId: string, request: BookingCreateRequest): Promise<{ uid: string } | null>;
  cancelBooking(companyId: string, bookingUid: string, reason?: string): Promise<boolean>;
  rescheduleBooking(companyId: string, bookingUid: string, newSlot: string): Promise<{ uid: string } | null>;
}

export type BookingRecordStatus = 'scheduled' | 'cancelled' | 'rescheduled';

export interface BookingRecord {
  companyId: string;
  uid: string;
  status: BookingRecordStatus;
  slot: string;
  name: string;
  email: string;
  timezone: string;
  phone: string | null;
  cancelReason: string | null;
  replacesUid: string | null;
  createdAt: string;
}

/** Local booking storage. Desk's appointments table is the intended backing (see PORT-MAP.md). */
export interface BookingStore {
  recordBooking(companyId: string, record: BookingRecord): Promise<void>;
  markCancelled(companyId: string, bookingUid: string, reason: string | null): Promise<boolean>;
  markRescheduled(companyId: string, oldUid: string, newUid: string, newSlot: string): Promise<boolean>;
  listBookings(companyId: string): Promise<BookingRecord[]>;
}
