/**
 * Telephony call flow decisions for the signed-event path (issue #328).
 *
 * Pure decision logic. The caller supplies the ports: the pre-send gate (consent, opt-out, suppression,
 * quiet hours), the booking handoff to Scheduled, and the human-transfer availability. Nothing here sends a
 * message, dials a number, or commits a booking. It returns the actions the caller must perform, in order.
 *
 * Rules:
 * - Every event must be addressed to the tenant the route resolved. Any other tenant is refused.
 * - A callback or SMS follow-up is produced only when the pre-send gate allows the send. A blocked send is
 *   recorded by the gate and is never queued.
 * - A missed call or a voicemail is always recorded. It never causes an outbound contact on its own.
 * - A human transfer is offered when the caller asks for one or the call is urgent. If no human is free, the
 *   caller is sent to voicemail.
 * - A provider timeout ends the automated part of the call. It never retries a contact.
 * - A booking request is handed to Scheduled only when the customer has confirmed it in this call. The
 *   Scheduled booking engine commits it, not this module.
 */
import type { PreSendBlockReason, PreSendGate } from './presend-gate.ts';

export const CALL_EVENTS = [
  'call_answered',
  'call_missed',
  'voicemail_left',
  'human_requested',
  'urgent_reported',
  'provider_timeout',
  'booking_requested',
] as const;
export type CallEvent = (typeof CALL_EVENTS)[number];

export interface CallFlowInput {
  /** Tenant (company) the route resolved. Taken from the route, never from the body. */
  routeTenantId: string;
  /** Tenant named by the event. Must equal routeTenantId. */
  eventTenantId: string;
  event: CallEvent;
  /** Caller's phone number, normalised by the caller. */
  callerPhone: string;
  /** Customer confirmed the booking during the call. Only meaningful for booking_requested. */
  customerConfirmed?: boolean;
  /** Booking details as the customer gave them. Passed through to Scheduled as data, never executed. */
  booking?: { serviceId: string; slotStartIso: string } | null;
  /** Whether a person is free to take a transfer right now. */
  humanAvailable: boolean;
  actorId: string;
}

export type CallAction =
  | { type: 'record_voicemail'; tenantId: string; callerPhone: string }
  | { type: 'offer_transfer'; tenantId: string }
  | { type: 'queue_callback'; tenantId: string; callerPhone: string }
  | {
      type: 'handoff_booking_request';
      tenantId: string;
      callerPhone: string;
      serviceId: string;
      slotStartIso: string;
      receiptId: string;
    }
  | { type: 'end_automated_call'; tenantId: string; reason: 'provider_timeout' }
  | { type: 'none'; tenantId: string };

export type CallFlowRefusal =
  | 'wrong_tenant'
  | 'booking_not_confirmed'
  | 'booking_details_missing'
  | 'unknown_event';

export interface CallFlowDeps {
  gate: PreSendGate;
  /** Hands an approved booking request to Scheduled. Returns the caller's receipt id. */
  handoffToScheduled: (request: {
    tenantId: string;
    callerPhone: string;
    serviceId: string;
    slotStartIso: string;
    actorId: string;
  }) => Promise<{ receiptId: string }>;
}

export type CallFlowOutcome =
  | { ok: true; actions: CallAction[]; blocked: PreSendBlockReason | null }
  | { ok: false; reason: CallFlowRefusal };

/** Decides what a call event does. Side effects happen only through the gate and the Scheduled handoff. */
export async function decideCallFlow(input: CallFlowInput, deps: CallFlowDeps): Promise<CallFlowOutcome> {
  if (input.eventTenantId !== input.routeTenantId) return { ok: false, reason: 'wrong_tenant' };
  if (!(CALL_EVENTS as readonly string[]).includes(input.event)) return { ok: false, reason: 'unknown_event' };
  const tenantId = input.routeTenantId;

  switch (input.event) {
    case 'call_answered':
      return { ok: true, actions: [{ type: 'none', tenantId }], blocked: null };

    case 'call_missed':
    case 'voicemail_left': {
      const actions: CallAction[] = [{ type: 'record_voicemail', tenantId, callerPhone: input.callerPhone }];
      // A callback is a new outbound contact, so it needs a fresh gate check on the sms channel.
      const decision = await deps.gate.check({
        companyId: tenantId,
        channel: 'sms',
        address: input.callerPhone,
        surface: 'inbox',
        actorId: input.actorId,
      });
      if (decision.allowed) {
        actions.push({ type: 'queue_callback', tenantId, callerPhone: input.callerPhone });
        return { ok: true, actions, blocked: null };
      }
      // The gate's check does not write the audit record. The caller must, so the block is never silent.
      await deps.gate.recordBlock(
        { companyId: tenantId, channel: 'sms', surface: 'inbox', actorId: input.actorId },
        decision.reason,
      );
      return { ok: true, actions, blocked: decision.reason };
    }

    case 'human_requested':
    case 'urgent_reported': {
      if (input.humanAvailable) return { ok: true, actions: [{ type: 'offer_transfer', tenantId }], blocked: null };
      return {
        ok: true,
        actions: [{ type: 'record_voicemail', tenantId, callerPhone: input.callerPhone }],
        blocked: null,
      };
    }

    case 'provider_timeout':
      return { ok: true, actions: [{ type: 'end_automated_call', tenantId, reason: 'provider_timeout' }], blocked: null };

    case 'booking_requested': {
      if (input.customerConfirmed !== true) return { ok: false, reason: 'booking_not_confirmed' };
      if (!input.booking?.serviceId || !input.booking.slotStartIso) return { ok: false, reason: 'booking_details_missing' };
      const receipt = await deps.handoffToScheduled({
        tenantId,
        callerPhone: input.callerPhone,
        serviceId: input.booking.serviceId,
        slotStartIso: input.booking.slotStartIso,
        actorId: input.actorId,
      });
      return {
        ok: true,
        actions: [
          {
            type: 'handoff_booking_request',
            tenantId,
            callerPhone: input.callerPhone,
            serviceId: input.booking.serviceId,
            slotStartIso: input.booking.slotStartIso,
            receiptId: receipt.receiptId,
          },
        ],
        blocked: null,
      };
    }
  }
}
