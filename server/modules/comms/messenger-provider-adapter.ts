// Messenger outbound adapter. It composes meta-send (request build and send) with two gates that
// run before any network call:
//
//   1. Consent. An opted-out contact is refused. checkConsent is used for the decision, with the
//      recipient's messenger handle set to the recipient id. Contacts with no consent records and
//      contacts with records that grant no channel opt-in are still allowed, because a Messenger
//      user who has messaged the page has not opted in through a separate record. A missing
//      contact or a malformed consent record fails closed.
//
//   2. Messaging window. Messenger needs its own window check. The rule is the same 24-hour
//      window as WhatsApp (see whatsapp-window.ts, reused here through canSendFreeForm), but a
//      closed window has no template fallback. Meta only accepts RESPONSE sends inside the window,
//      so a closed window is always refused.
//
//   Purpose. A MARKETING send additionally needs a recorded Messenger opt-in: a contact with no
//   consent record, or with records that grant no Messenger opt-in, is refused ('opt_in_required').
//   A TRANSACTIONAL reply (the default) is not refused by this rule and keeps the rules above.
//
// The HTTP client is injected. The access token goes only to sendMeta and never to a refusal or
// error result. This module never throws.

import { buildMetaMessageRequest, sendMeta, type MetaHttpClient, type MetaBuildFailure } from './meta-send.ts';
import { checkConsent, type Contact, type QuietHours } from './consent.ts';
import { canSendFreeForm, type WindowTime } from './whatsapp-window.ts';
import {
  NO_SEND_AUDIT,
  openSendAudit,
  type CommsEventSink,
  type CommsSendAudit,
  type CommsSendAuditOutcome,
} from './audit-sink.ts';

/** 'marketing' needs a recorded Messenger opt-in. 'transactional' (the default) does not. */
export type MessengerMessagePurpose = 'marketing' | 'transactional';

export interface MessengerSendInput {
  accessToken: string;
  recipientId: string;
  text: string;
  contact: Contact | null | undefined;
  lastInboundAt: WindowTime | null | undefined;
  now: WindowTime;
  http: MetaHttpClient;
  purpose?: MessengerMessagePurpose;
  /** Company quiet-hours window. It is read in the contact's own timezone (contact.timezone). */
  quietHours?: QuietHours | null;
  /** Company the send belongs to. Without it, no audit event is recorded. */
  companyId?: string | null;
  /** Human or system actor for the audit event. Without it, no event is recorded. */
  actorId?: string | null;
  /** Optional comms audit sink. When absent, a send is still made and nothing is recorded. */
  auditSink?: CommsEventSink;
}

export type MessengerRefusal =
  | MetaBuildFailure
  | 'opted_out'
  | 'opt_in_required'
  | 'quiet_hours'
  | 'invalid_purpose'
  | 'contact_invalid'
  | 'window_closed'
  | 'no_inbound'
  | 'clock_skew'
  | 'invalid_time'
  | 'audit_unavailable'
  | 'provider_error';

/** Results of a send that reached the audit gate carry auditRecorded. Earlier refusals do not. */
export type MessengerSendResult = (
  | { ok: true; messageId: string }
  | { ok: false; reason: MessengerRefusal }
) &
  Partial<CommsSendAuditOutcome>;

function isUsableTime(value: WindowTime): boolean {
  const ms = value instanceof Date ? value.getTime() : value;
  return typeof ms === 'number' && Number.isFinite(ms);
}

export async function sendMessengerReply(input: MessengerSendInput): Promise<MessengerSendResult> {
  try {
    const { accessToken, recipientId, text, contact, lastInboundAt, now, http } = input;
    const purpose = input.purpose ?? 'transactional';
    if (purpose !== 'marketing' && purpose !== 'transactional') {
      return { ok: false, reason: 'invalid_purpose' };
    }

    // Purpose, contact and window inputs go to the builder too, so its marketing gate applies on this path.
    const built = buildMetaMessageRequest({
      channel: 'messenger',
      recipientId,
      text,
      purpose,
      contact,
      lastInboundAt,
      now,
    });
    if (!built.ok) {
      return { ok: false, reason: built.reason };
    }

    // Consent gate. The recipient's own id is the handle being checked.
    if (!contact || typeof contact !== 'object' || !isUsableTime(now)) {
      return { ok: false, reason: isUsableTime(now) ? 'contact_invalid' : 'invalid_time' };
    }
    // Quiet hours are read in the contact's own timezone (contact.timezone), not the company's.
    const consent = checkConsent({
      channel: 'messenger',
      contact: { ...contact, handles: { ...(contact.handles ?? {}), messenger: recipientId } },
      now,
      quietHours: input.quietHours,
    });
    if (!consent.allowed && consent.reason === 'opted_out') {
      return { ok: false, reason: 'opted_out' };
    }
    if (!consent.allowed && consent.reason === 'invalid_contact') {
      return { ok: false, reason: 'contact_invalid' };
    }
    if (!consent.allowed && consent.reason === 'quiet_hours') {
      return { ok: false, reason: 'quiet_hours' };
    }
    // Marketing needs a Messenger opt-in on record. Here the remaining refusals are no_consent and
    // channel_not_consented, and each one means no usable opt-in.
    if (purpose === 'marketing' && !consent.allowed) {
      return { ok: false, reason: 'opt_in_required' };
    }

    // Messaging window gate. Free-form only, no template fallback.
    const window = canSendFreeForm({ lastInboundAt, now });
    if (!window.freeForm) {
      return { ok: false, reason: window.reason };
    }

    // The pending audit event is written before the provider is called. If it cannot be written, nothing is sent.
    let audit: CommsSendAudit | null;
    try {
      audit = await openSendAudit(input.auditSink, {
        companyId: input.companyId ?? '',
        actorId: input.actorId,
        channel: 'messenger',
        now: () => now,
      });
    } catch {
      return { ok: false, reason: 'audit_unavailable', auditRecorded: false };
    }

    const sent = await sendMeta({ accessToken, request: built.request, http });
    if (!sent.ok) {
      const failed = audit ? await audit.finish('provider_error') : NO_SEND_AUDIT;
      return { ok: false, reason: 'provider_error', ...failed };
    }
    const outcome = audit ? await audit.finish('sent') : NO_SEND_AUDIT;
    return { ok: true, messageId: sent.messageId, ...outcome };
  } catch {
    return { ok: false, reason: 'provider_error' };
  }
}
