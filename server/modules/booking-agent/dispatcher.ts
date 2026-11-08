import { assertCompanyId } from './company-scope.ts';
import type { BookingCalendar, BookingRecord, BookingStore } from './ports.ts';
import { BOOKING_TOOLS } from './tools.ts';
import type { CancelBookingInput, CreateBookingInput, RescheduleBookingInput } from './schemas.ts';
import {
  BOOKING_TOOL_NAMES,
  type BookingCaller,
  type BookingGate,
  type BookingOutcome,
  type BookingToolName,
} from './types.ts';

/*
 * Booking dispatcher. Ported from BookingToolHandler::handle().
 *
 * Flow for every call:
 *   1. companyId must be present (taken from the caller, never from input).
 *   2. Tool name must be one of the three booking tools.
 *   3. Input is validated by zod (strict, so unknown keys such as companyId fail).
 *   4. The approvals gate must return status 'approved'. Anything else refuses.
 *   5. Only then does the calendar port run, followed by the store port.
 *
 * This module never performs a booking by itself. Without an approved gate result,
 * the calendar and store ports are not called.
 */

export interface BookingAgentDeps {
  gate: BookingGate;
  calendar: BookingCalendar;
  store: BookingStore;
  /** How long a pending approval stays open. Defaults to 15 minutes. */
  approvalTtlMs?: number;
  now?: () => Date;
}

export interface BookingAgent {
  dispatch(caller: BookingCaller, toolName: string, rawInput: unknown): Promise<BookingOutcome>;
}

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

function isBookingToolName(name: unknown): name is BookingToolName {
  return typeof name === 'string' && (BOOKING_TOOL_NAMES as readonly string[]).includes(name);
}

export function createBookingAgent(deps: BookingAgentDeps): BookingAgent {
  const ttlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError('booking-agent: approvalTtlMs must be a positive number');
  }
  const now = deps.now ?? (() => new Date());

  function buildRecord(
    companyId: string,
    uid: string,
    status: BookingRecord['status'],
    slot: string,
    who: { name: string; email: string; timezone: string; phone?: string },
    extra: { replacesUid?: string | null; cancelReason?: string | null } = {}
  ): BookingRecord {
    return {
      companyId,
      uid,
      status,
      slot,
      name: who.name,
      email: who.email,
      timezone: who.timezone,
      phone: who.phone ?? null,
      cancelReason: extra.cancelReason ?? null,
      replacesUid: extra.replacesUid ?? null,
      createdAt: now().toISOString(),
    };
  }

  async function execute(
    companyId: string,
    toolName: BookingToolName,
    data: CreateBookingInput | CancelBookingInput | RescheduleBookingInput
  ): Promise<BookingOutcome> {
    if (toolName === 'create_booking') {
      const input = data as CreateBookingInput;
      const created = await deps.calendar.createBooking(companyId, {
        slot: input.slot,
        name: input.name,
        email: input.email,
        timezone: input.timezone,
        phone: input.phone,
      });
      const uid = created?.uid;
      if (!uid) {
        // Same outcome the PHP source returns when the provider gives no UID.
        return {
          outcome: 'failed',
          message: 'Booking failed. Please verify the slot is still available and try again.',
        };
      }
      await deps.store.recordBooking(
        companyId,
        buildRecord(companyId, uid, 'scheduled', input.slot, input)
      );
      return {
        outcome: 'executed',
        bookingUid: uid,
        message: `Booking confirmed. UID: ${uid}. A confirmation has been sent to ${input.email}.`,
      };
    }

    if (toolName === 'cancel_booking') {
      const input = data as CancelBookingInput;
      const ok = await deps.calendar.cancelBooking(companyId, input.booking_uid, input.reason);
      if (!ok) {
        return {
          outcome: 'failed',
          message: 'Failed to cancel the booking. Please verify the booking UID and try again.',
        };
      }
      await deps.store.markCancelled(companyId, input.booking_uid, input.reason ?? null);
      return {
        outcome: 'executed',
        bookingUid: input.booking_uid,
        message: 'Booking has been cancelled successfully.',
      };
    }

    // reschedule_booking
    const input = data as RescheduleBookingInput;
    const moved = await deps.calendar.rescheduleBooking(companyId, input.booking_uid, input.new_slot);
    const newUid = moved?.uid;
    if (!newUid) {
      // The PHP source reports success here even with no UID. This port reports failure.
      return {
        outcome: 'failed',
        message: 'Reschedule failed. Please verify the booking UID and the new slot, then try again.',
      };
    }
    // If the old UID is not in local storage, markRescheduled returns false. The
    // provider has still moved the booking, so this is reported to the caller and the
    // gap is covered by reconciliation (see PORT-MAP.md).
    await deps.store.markRescheduled(companyId, input.booking_uid, newUid, input.new_slot);
    return {
      outcome: 'executed',
      bookingUid: newUid,
      message: `Booking rescheduled successfully. New booking UID: ${newUid}.`,
    };
  }

  return {
    async dispatch(caller, toolName, rawInput) {
      assertCompanyId(caller?.companyId);

      if (!isBookingToolName(toolName)) {
        return { outcome: 'unknown_tool', message: `Unknown booking tool: ${String(toolName)}` };
      }

      const def = BOOKING_TOOLS[toolName];
      const parsed = def.schema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`);
        return {
          outcome: 'invalid_input',
          issues,
          message: `Cannot ${toolName}. Invalid fields: ${issues.join('; ')}. Please collect these from the caller first.`,
        };
      }

      let gate;
      try {
        gate = await deps.gate.gateAction({
          companyId: caller.companyId,
          requestedBy: caller.requestedBy,
          agentId: caller.agentId,
          action: toolName,
          params: parsed.data as Record<string, unknown>,
          context: { source: 'booking-agent' },
          urgency: 'normal',
          ttlMs: ttlMs,
        });
      } catch {
        return {
          outcome: 'refused',
          reason: 'gate_error',
          message: 'Booking not started: the approval check failed. Nothing was booked.',
        };
      }

      if (gate?.status === 'pending') {
        return {
          outcome: 'refused',
          reason: 'awaiting_approval',
          approvalId: gate.approval?.id,
          message: 'Booking is waiting for approval. Nothing was booked yet.',
        };
      }
      if (gate?.status === 'rejected' || gate?.status === 'expired') {
        return {
          outcome: 'refused',
          reason: 'gate_denied',
          message: 'Booking was not approved. Nothing was booked.',
        };
      }
      if (gate?.status !== 'approved') {
        return {
          outcome: 'refused',
          reason: 'gate_error',
          message: 'Booking not started: the approval check returned an unknown result. Nothing was booked.',
        };
      }

      try {
        return await execute(caller.companyId, toolName, parsed.data);
      } catch (e) {
        return {
          outcome: 'failed',
          message: `Booking action failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
