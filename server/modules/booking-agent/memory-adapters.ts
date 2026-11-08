import type { BookingCalendar, BookingCreateRequest, BookingRecord, BookingStore } from './ports.ts';
import { assertCompanyId } from './company-scope.ts';

/*
 * In-memory adapters for tests and local runs. Every map is keyed by companyId
 * first, so one company can never see or change another company's bookings.
 * These adapters never talk to a provider or a database.
 */

interface CalendarEntry {
  uid: string;
  slot: string;
  status: 'active' | 'cancelled' | 'rescheduled';
}

export interface CalendarCall {
  method: 'createBooking' | 'cancelBooking' | 'rescheduleBooking';
  companyId: string;
}

/**
 * Simulates a provider. A slot already held by an active booking in the same company
 * is refused (returns null), which is the same outcome the PHP source gets when the
 * provider rejects a slot.
 */
export class InMemoryBookingCalendar implements BookingCalendar {
  readonly calls: CalendarCall[] = [];
  private readonly byCompany = new Map<string, CalendarEntry[]>();
  private seq = 0;

  private entries(companyId: string): CalendarEntry[] {
    assertCompanyId(companyId);
    let list = this.byCompany.get(companyId);
    if (!list) {
      list = [];
      this.byCompany.set(companyId, list);
    }
    return list;
  }

  private slotTaken(companyId: string, slot: string): boolean {
    return this.entries(companyId).some((e) => e.status === 'active' && e.slot === slot);
  }

  private nextUid(): string {
    this.seq += 1;
    return `cal_${this.seq}`;
  }

  async createBooking(companyId: string, request: BookingCreateRequest): Promise<{ uid: string } | null> {
    this.calls.push({ method: 'createBooking', companyId });
    if (this.slotTaken(companyId, request.slot)) return null;
    const uid = this.nextUid();
    this.entries(companyId).push({ uid, slot: request.slot, status: 'active' });
    return { uid };
  }

  async cancelBooking(companyId: string, bookingUid: string): Promise<boolean> {
    this.calls.push({ method: 'cancelBooking', companyId });
    const entry = this.entries(companyId).find((e) => e.uid === bookingUid);
    if (!entry || entry.status !== 'active') return false;
    entry.status = 'cancelled';
    return true;
  }

  async rescheduleBooking(companyId: string, bookingUid: string, newSlot: string): Promise<{ uid: string } | null> {
    this.calls.push({ method: 'rescheduleBooking', companyId });
    const entry = this.entries(companyId).find((e) => e.uid === bookingUid);
    if (!entry || entry.status !== 'active') return null;
    if (this.slotTaken(companyId, newSlot)) return null;
    entry.status = 'rescheduled';
    const uid = this.nextUid();
    this.entries(companyId).push({ uid, slot: newSlot, status: 'active' });
    return { uid };
  }

  /** Active slots for one company, for assertions. */
  activeSlots(companyId: string): string[] {
    return this.entries(companyId)
      .filter((e) => e.status === 'active')
      .map((e) => e.slot);
  }
}

export class InMemoryBookingStore implements BookingStore {
  private readonly byCompany = new Map<string, BookingRecord[]>();

  private records(companyId: string): BookingRecord[] {
    assertCompanyId(companyId);
    let list = this.byCompany.get(companyId);
    if (!list) {
      list = [];
      this.byCompany.set(companyId, list);
    }
    return list;
  }

  async recordBooking(companyId: string, record: BookingRecord): Promise<void> {
    if (record.companyId !== companyId) {
      throw new Error('record companyId does not match the scoped companyId');
    }
    this.records(companyId).push({ ...record });
  }

  async markCancelled(companyId: string, bookingUid: string, reason: string | null): Promise<boolean> {
    const rec = this.records(companyId).find((r) => r.uid === bookingUid && r.status === 'scheduled');
    if (!rec) return false;
    rec.status = 'cancelled';
    rec.cancelReason = reason;
    return true;
  }

  async markRescheduled(companyId: string, oldUid: string, newUid: string, newSlot: string): Promise<boolean> {
    const old = this.records(companyId).find((r) => r.uid === oldUid && r.status === 'scheduled');
    if (!old) return false;
    old.status = 'rescheduled';
    const base = this.records(companyId).find((r) => r.uid === oldUid) as BookingRecord;
    this.records(companyId).push({
      ...base,
      uid: newUid,
      status: 'scheduled',
      slot: newSlot,
      replacesUid: oldUid,
      cancelReason: null,
    });
    return true;
  }

  async listBookings(companyId: string): Promise<BookingRecord[]> {
    return this.records(companyId).map((r) => ({ ...r }));
  }
}
