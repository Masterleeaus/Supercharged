/**
 * Hold, confirm, reschedule and cancel for a booking on a calendar connector (#354). Each call goes through the
 * shared runner with a stableId built from the booking and the slot, so a replay of the same operation shares
 * one idempotency key and the vendor does not see a second write. Pure apart from the runner's injected pieces.
 */
import type { ConnectorCredentials, ConnectorDefinition } from '../sdk/contract.ts';
import { runAction } from '../sdk/runner.ts';
import type { AuditSink } from '../sdk/audit.ts';
import { freeSlots, type JobProfile } from './slots.ts';

export interface Slot {
  startsAt: string;
  endsAt: string;
  timezone: string;
}

export interface BookingOpsDeps {
  definition: ConnectorDefinition;
  companyId: string;
  credentials: ConnectorCredentials;
  audit: AuditSink;
  now?: () => Date;
}

export function createBookingOps(deps: BookingOpsDeps) {
  const run = (action: string, input: unknown, stableId: string) =>
    runAction({
      definition: deps.definition,
      companyId: deps.companyId,
      action,
      input,
      credentials: deps.credentials,
      stableId,
      audit: deps.audit,
      now: deps.now,
    }).then((r) => r.value as Record<string, unknown>);

  return {
    /**
     * Free start times for a job type in a window. Reads the busy intervals through the connector's listBusy action,
     * then offers only starts whose full footprint (travel and buffers included) is clear. Times are returned in UTC.
     */
    async availability(window: { from: string; to: string }, job: JobProfile): Promise<Slot[]> {
      const fromMs = Date.parse(window.from);
      const toMs = Date.parse(window.to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) throw new RangeError('availability window is invalid');
      const result = await runAction({
        definition: deps.definition,
        companyId: deps.companyId,
        action: 'listBusy',
        input: { from: window.from, to: window.to },
        credentials: deps.credentials,
        audit: deps.audit,
        now: deps.now,
      });
      const busy = (result.value as { start: string; end: string }[]).map((b) => ({
        start: Date.parse(b.start),
        end: Date.parse(b.end),
      }));
      const free = freeSlots({ windowStart: fromMs, windowEnd: toMs, busy, job });
      return free.map((s) => ({
        startsAt: new Date(s.start).toISOString(),
        endsAt: new Date(s.end).toISOString(),
        timezone: 'UTC',
      }));
    },

    /** Holds a tentative event for the slot. A replay for the same booking and slot returns the same event. */
    async hold(bookingId: string, slot: Slot, summary: string) {
      const value = await run('createEvent', { ...slot, summary, status: 'tentative' }, `${bookingId}:hold:${slot.startsAt}`);
      return { eventId: String(value.id) };
    },

    async confirm(bookingId: string, eventId: string) {
      await run('updateEvent', { eventId, status: 'confirmed' }, `${bookingId}:confirm`);
      return { eventId, status: 'confirmed' as const };
    },

    async reschedule(bookingId: string, eventId: string, slot: Slot) {
      await run('updateEvent', { eventId, ...slot }, `${bookingId}:reschedule:${slot.startsAt}`);
      return { eventId, startsAt: slot.startsAt, endsAt: slot.endsAt };
    },

    async cancel(bookingId: string, eventId: string) {
      const value = await run('deleteEvent', { eventId }, `${bookingId}:cancel`);
      return { eventId, alreadyGone: value.alreadyGone === true };
    },
  };
}
