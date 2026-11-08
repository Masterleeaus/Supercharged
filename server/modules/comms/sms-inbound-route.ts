// Plivo SMS webhook handlers: delivery receipts (status callback) and inbound messages (STOP / START).
//
// Factory with injected stores. No database, logger, network or Express import here: the Plivo
// route file mounts these handlers behind its own signature and replay guard.
//
// Company comes from the sender number that owns the Plivo line, never from the callback body. When
// that number does not resolve to exactly one company, nothing is read or written (fail closed).
// Responses are status codes only, so no provider text, number or stack trace reaches the caller.

import { normalizePhone } from './contact-dedupe.ts';
import { canAdvanceDeliveryStatus, type SmsDeliveryStatus } from './sms-transport.ts';
import { handlePlivoDeliveryReceipt } from './sms-provider-adapter.ts';
import { consentEventForInboundKeyword, handleInboundOptOut } from './inbound-optout.ts';
import { parseOptOutKeyword, type Contact, type ConsentEvent } from './consent.ts';
import type { SuppressionList } from './suppression.ts';

/** Minimal request and response shapes. Express objects satisfy them. */
export interface SmsRouteRequest {
  body?: unknown;
}

export interface SmsRouteResponse {
  sendStatus(code: number): unknown;
}

export type SmsMessageLookup =
  | { found: false }
  | { found: true; status: SmsDeliveryStatus | null };

export interface SmsMessageStore {
  /** Reads the row matching both companyId and externalId. Never another company's row. */
  lookupDeliveryStatus(companyId: string, externalId: string): Promise<SmsMessageLookup>;
  /**
   * Writes `next` only to the row matching companyId and externalId, and only while that row still
   * holds `expected` (null when it has no status yet). Returns false when no row matched or the
   * compare failed.
   */
  compareAndSetDeliveryStatus(input: {
    companyId: string;
    externalId: string;
    expected: SmsDeliveryStatus | null;
    next: SmsDeliveryStatus;
    errorCode?: string;
  }): Promise<boolean>;
}

export interface SmsContactRecord {
  id: string;
  contact: Contact;
}

export interface SmsContactStore {
  /** The contact in this company whose phone handle is this E.164 number. Null when none. */
  findByPhone(companyId: string, phone: string): Promise<SmsContactRecord | null>;
  /** Appends one consent event to the contact's records, inside this company only. */
  appendConsentEvent(companyId: string, contactId: string, event: ConsentEvent): Promise<boolean>;
}

export interface SmsRouteDeps {
  /** Maps the Plivo number (E.164, or digits only as Plivo sends it) to its company. Null when unknown or ambiguous. */
  resolveCompanyForNumber: (phone: string) => Promise<string | null> | string | null;
  messages: SmsMessageStore;
  contacts: SmsContactStore;
  suppression: SuppressionList;
  /** Injected clock. Defaults to the current time. */
  now?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plivo sends numbers as digits with no leading plus. Adds it, then applies the shared E.164 check. */
function plivoNumber(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const candidate = /^\d+$/.test(trimmed) ? `+${trimmed}` : trimmed;
  return normalizePhone(candidate);
}

async function resolveCompany(deps: SmsRouteDeps, phone: string): Promise<string | null> {
  const companyId = await deps.resolveCompanyForNumber(phone);
  return typeof companyId === 'string' && UUID_RE.test(companyId) ? companyId : null;
}

export type SmsRouteOutcome = { code: number };

/**
 * Processes one Plivo delivery status callback.
 *
 * 404 unknown sender number, or no row for this company and MessageUUID (the send may not be stored yet, so Plivo retries).
 * 400 malformed receipt. 200 unknown status or an advance the rules refuse (nothing written).
 * 409 the row changed between read and write (retry). 503 store failure (retry). 200 written.
 */
export async function processPlivoDeliveryReceipt(
  deps: SmsRouteDeps,
  payload: unknown,
): Promise<SmsRouteOutcome> {
  try {
    const fields = (payload ?? {}) as Record<string, unknown>;
    const to = plivoNumber(fields.From);
    if (to === undefined) return { code: 404 };
    const companyId = await resolveCompany(deps, to);
    if (!companyId) return { code: 404 };

    const receipt = handlePlivoDeliveryReceipt({ companyId, payload });
    if (!receipt.ok) {
      return { code: receipt.reason === 'unknown_status' ? 200 : 400 };
    }

    const lookup = await deps.messages.lookupDeliveryStatus(companyId, receipt.externalId);
    if (!lookup.found) return { code: 404 };

    if (!canAdvanceDeliveryStatus(lookup.status, receipt.status)) return { code: 200 };

    const written = await deps.messages.compareAndSetDeliveryStatus({
      companyId,
      externalId: receipt.externalId,
      expected: lookup.status,
      next: receipt.status,
      ...(receipt.errorCode !== undefined ? { errorCode: receipt.errorCode } : {}),
    });
    return { code: written ? 200 : 409 };
  } catch {
    return { code: 503 };
  }
}

/**
 * Processes one inbound Plivo SMS. Only an exact STOP-type or START-type body changes state.
 *
 * Order: suppression first, then the SMS-only consent event. Both are idempotent, so a retry after a
 * failure in the second step still converges. A START reads the contact's opt-out record, so the
 * opt-in is recorded only while that opt-out is still on record.
 *
 * 400 malformed payload. 404 the receiving number maps to no company. 200 handled, or nothing to do.
 * 503 suppression or consent write failed (Plivo retries). The body is never echoed or logged.
 */
export async function processPlivoInboundSms(deps: SmsRouteDeps, payload: unknown): Promise<SmsRouteOutcome> {
  try {
    const fields = (payload ?? {}) as Record<string, unknown>;
    const messageUuid = fields.MessageUUID;
    if (typeof messageUuid !== 'string' || messageUuid.trim() === '') return { code: 400 };
    const text = typeof fields.Text === 'string' ? fields.Text : '';

    const to = plivoNumber(fields.To);
    if (to === undefined) return { code: 404 };
    const companyId = await resolveCompany(deps, to);
    if (!companyId) return { code: 404 };

    const from = plivoNumber(fields.From);
    if (from === undefined) return { code: 200 };

    const keyword = parseOptOutKeyword(text);
    if (!keyword.optOut && !keyword.optIn) return { code: 200 };

    const now = deps.now ? deps.now() : new Date();

    const suppression = handleInboundOptOut({
      companyId,
      channel: 'sms',
      from,
      body: text,
      suppression: deps.suppression,
      now,
    });
    if (suppression.action === 'not_changed' && suppression.reason !== 'not_opt_out') {
      return { code: 503 };
    }

    const record = await deps.contacts.findByPhone(companyId, from);
    // The contact record must belong to the sender's number, or it does not count (same rule as the adapter).
    const ownerPhone = record?.contact?.handles?.phone;
    if (!record || typeof ownerPhone !== 'string' || normalizePhone(ownerPhone) !== from) {
      return { code: 200 };
    }

    const event = consentEventForInboundKeyword({
      channel: 'sms',
      body: text,
      contact: record.contact,
      at: now,
    });
    if (event) {
      const appended = await deps.contacts.appendConsentEvent(companyId, record.id, event);
      if (!appended) return { code: 503 };
    }
    return { code: 200 };
  } catch {
    return { code: 503 };
  }
}

/** Express-compatible handler for POST /api/plivo/sms/status. Mount behind the Plivo signature guard. */
export function createSmsStatusHandler(deps: SmsRouteDeps) {
  return async (req: SmsRouteRequest, res: SmsRouteResponse): Promise<void> => {
    const outcome = await processPlivoDeliveryReceipt(deps, req.body);
    res.sendStatus(outcome.code);
  };
}

/** Express-compatible handler for POST /api/plivo/sms/inbound. Mount behind the Plivo signature guard. */
export function createSmsInboundHandler(deps: SmsRouteDeps) {
  return async (req: SmsRouteRequest, res: SmsRouteResponse): Promise<void> => {
    const outcome = await processPlivoInboundSms(deps, req.body);
    res.sendStatus(outcome.code);
  };
}
