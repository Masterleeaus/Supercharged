// Inbound STOP / START handling. An inbound message that is exactly an opt-out keyword suppresses
// the sender on that channel. An exact START or YES lifts an 'unsubscribed' suppression only;
// every other stored reason stays in place.
// Pure orchestration: no database, no network. The suppression list is passed in, never created.

import { parseOptOutKeyword, type Channel, type Contact, type ConsentEvent, type DateInput } from './consent.ts';
import type { SuppressionList } from './suppression.ts';

export interface InboundConsentEventInput {
  /** Channel the message arrived on. The event covers this channel only (never 'all'). */
  channel: Channel;
  body: unknown;
  /** The contact that owns the sender on this channel. Null or undefined yields no event. */
  contact: Contact | null | undefined;
  /** Time of the inbound message. Must be after an earlier opt-out for a START to reinstate. */
  at: DateInput;
}

/**
 * Consent event for an inbound STOP or START, to append to the contact's consent records.
 *
 * - STOP, UNSUBSCRIBE, END, CANCEL, QUIT: opt_out on this channel only, source 'contact'.
 * - START, YES: opt_in on this channel, source 'contact', only when the contact has an opt-out
 *   covering this channel. With no opt-out on record, nothing is granted (fail closed).
 * - Anything else, or no contact: null.
 *
 * Per channel only: an SMS STOP never blocks email or WhatsApp (checkConsent filters by channel).
 * The caller persists the event; this function reads and writes nothing.
 */
export function consentEventForInboundKeyword(input: InboundConsentEventInput): ConsentEvent | null {
  const { channel, body, contact, at } = input;
  if (!contact || typeof contact !== 'object') return null;

  const keyword = parseOptOutKeyword(body);
  if (keyword.optOut) {
    return { channel, action: 'opt_out', at, source: 'contact' };
  }
  if (keyword.optIn) {
    const hasOptOut = (contact.consents ?? []).some(
      (e) => e.action === 'opt_out' && (e.channel === channel || e.channel === 'all'),
    );
    if (!hasOptOut) return null;
    return { channel, action: 'opt_in', at, source: 'contact' };
  }
  return null;
}

export type InboundOptOutResult =
  | { action: 'suppressed' }
  | { action: 'unsuppressed' }
  | { action: 'not_changed'; reason: string }
  | { action: 'none' };

export interface InboundOptOutInput {
  companyId: string;
  channel: Channel;
  from: string | null | undefined;
  body: unknown;
  suppression: SuppressionList;
  // Accepted for call-site symmetry with other comms functions. The suppression list has no
  // time-based rules, so `now` does not change the outcome.
  now?: Date | number | string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apply an inbound message's consent keyword to the suppression list.
 *
 * - STOP, UNSUBSCRIBE, END, CANCEL, QUIT: suppress `from` as 'unsubscribed'.
 * - START, YES: read the stored reason first. Only 'unsubscribed' is lifted, through unsuppress.
 *   Any other reason (soft_bounce_count, bounce_hard, complaint, invalid_address) and an address
 *   that is not suppressed return { action: 'not_changed', reason: 'not_opt_out' } and unsuppress
 *   is not called.
 * - Any other body, or a missing `from`: no change, returns { action: 'none' }.
 * - A non-UUID companyId is refused with reason 'invalid_company'.
 */
export function handleInboundOptOut(input: InboundOptOutInput): InboundOptOutResult {
  const { companyId, channel, from, body, suppression } = input;

  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    return { action: 'not_changed', reason: 'invalid_company' };
  }

  if (typeof from !== 'string' || from.trim() === '') return { action: 'none' };

  const keyword = parseOptOutKeyword(body);

  if (keyword.optOut) {
    const result = suppression.suppress(companyId, {
      address: from,
      channel,
      reason: 'unsubscribed',
    });
    if (!result.ok) return { action: 'not_changed', reason: result.error };
    return { action: 'suppressed' };
  }

  if (keyword.optIn) {
    const reason = suppression.reasonFor(companyId, { address: from, channel });
    if (reason !== 'unsubscribed') return { action: 'not_changed', reason: 'not_opt_out' };
    const result = suppression.unsuppress(companyId, { address: from, channel });
    if (!result.ok) return { action: 'not_changed', reason: result.error };
    return { action: 'unsuppressed' };
  }

  return { action: 'none' };
}
