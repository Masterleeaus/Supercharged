// SMS provider adapter. Implements the send path of the SMS transport over an injected HTTP client.
//
// Before any request leaves, send() checks consent and company quiet hours through checkConsent.
// A refused recipient never reaches the HTTP client. Provider failures collapse to 'provider_error'
// with no provider text, so the account token and the recipient number cannot leak into a result.
// mapStatus and inbound are pure and come from createSmsTransport. The HTTP client is the only I/O.

import { checkConsent, type Contact, type QuietHours } from './consent.ts';
import {
  createSmsTransport,
  mapSmsDeliveryStatus,
  SMS_MAX_BODY_LENGTH,
  type SmsDeliveryStatus,
  type SmsInboundPayload,
  type SmsSendFailureReason,
  type SmsSendInput,
} from './sms-transport.ts';
import { normalizePhone } from './contact-dedupe.ts';
import type { SuppressionList } from './suppression.ts';
import {
  NO_SEND_AUDIT,
  openSendAudit,
  type CommsEventSink,
  type CommsSendAudit,
  type CommsSendAuditOutcome,
} from './audit-sink.ts';

// Plivo Messages API, the same provider host the Plivo voice engine uses (server/engines/plivo/config).
export const SMS_PROVIDER_BASE_URL = 'https://api.plivo.com/v1';

export interface SmsAdapterHttpRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface SmsAdapterHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type SmsAdapterHttp = (url: string, init: SmsAdapterHttpRequest) => Promise<SmsAdapterHttpResponse>;

/** Quiet hours for the company. They are read in each recipient's own timezone (contact.timezone). */
export interface SmsCompanyPolicy {
  quietHours: QuietHours | null;
}

export interface SmsProviderAdapterOptions {
  /** Plivo account identifier (auth_id). */
  accountId: string;
  /** Plivo auth token. Sent only in the Authorization header. Never returned or logged. */
  authToken: string;
  /** Sender number in any form normalizePhone accepts. */
  fromNumber: string;
  http: SmsAdapterHttp;
  /** Resolves a company's quiet hours. Return null when the company is unknown. */
  resolveCompany: (companyId: string) => SmsCompanyPolicy | null | Promise<SmsCompanyPolicy | null>;
  /** Resolves the contact that owns this E.164 number in this company. Return null when none exists. */
  resolveContact: (companyId: string, phone: string) => Contact | null | undefined | Promise<Contact | null | undefined>;
  /** Injected clock. Defaults to Date.now. */
  now?: () => number;
  /** Override for the API base URL. Defaults to SMS_PROVIDER_BASE_URL. */
  baseUrl?: string;
  /**
   * Company suppression list (bounces, complaints, unsubscribes). When wired, staff sends are
   * checked against it before any consent check or request. Production wiring must pass it.
   */
  suppression?: SuppressionList;
  /** Optional comms audit sink. When absent, a send is still made and nothing is recorded. */
  auditSink?: CommsEventSink;
}

/** Every refusal is in the typed list in sms-transport.ts, plus 'suppressed' for the suppression list. */
export type SmsAdapterSendFailureReason = SmsSendFailureReason | 'suppressed' | 'audit_unavailable';

/** Results of a send that reached the audit gate carry auditRecorded. Earlier refusals do not. */
export type SmsAdapterSendResult = (
  | { ok: true; externalId: string }
  | { ok: false; reason: SmsAdapterSendFailureReason }
) &
  Partial<CommsSendAuditOutcome>;

/** A send input plus the actor for the audit event. Without actorId, no event is recorded. */
export type SmsAdapterSendInput = SmsSendInput & { actorId?: string | null };

export interface SmsProviderAdapter {
  send(input: SmsAdapterSendInput): Promise<SmsAdapterSendResult>;
  mapStatus(providerStatus: unknown): SmsDeliveryStatus | 'unknown';
  inbound(payload: SmsInboundPayload | unknown): ReturnType<ReturnType<typeof createSmsTransport>['inbound']>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function basicAuth(accountId: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountId}:${authToken}`, 'utf8').toString('base64')}`;
}

export interface PlivoDeliveryReceiptInput {
  /** Company from the verified session or the route's own lookup. Never from the callback body. */
  companyId: unknown;
  /** Parsed Plivo status callback fields (form or JSON). Uses MessageUUID, Status, ErrorCode. */
  payload: unknown;
}

export type PlivoDeliveryReceiptResult =
  | {
      ok: true;
      companyId: string;
      externalId: string;
      status: SmsDeliveryStatus;
      errorCode?: string;
    }
  | { ok: false; reason: 'invalid_company' | 'invalid_receipt' | 'unknown_status' };

/**
 * Maps one Plivo delivery status callback to a delivery status. Pure: it reads no store and makes
 * no call. The caller writes the result only to the message row that matches both companyId and
 * externalId, and only when canAdvanceDeliveryStatus allows it.
 *
 * Unknown or missing status returns ok:false, so nothing is written. Only the numeric ErrorCode is
 * kept; any other value is dropped.
 */
export function handlePlivoDeliveryReceipt(input: PlivoDeliveryReceiptInput): PlivoDeliveryReceiptResult {
  const companyId = input?.companyId;
  if (typeof companyId !== 'string' || !UUID.test(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }

  const payload = input.payload as Record<string, unknown> | null | undefined;
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'invalid_receipt' };
  }

  const externalId = payload.MessageUUID;
  if (typeof externalId !== 'string' || externalId.trim() === '') {
    return { ok: false, reason: 'invalid_receipt' };
  }

  const status = mapSmsDeliveryStatus(payload.Status);
  if (status === 'unknown') return { ok: false, reason: 'unknown_status' };

  const rawError = payload.ErrorCode;
  const errorCode =
    (typeof rawError === 'string' || typeof rawError === 'number') && /^\d{1,10}$/.test(String(rawError))
      ? String(rawError)
      : undefined;

  return {
    ok: true,
    companyId,
    externalId: externalId.trim(),
    status,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

export function createSmsProviderAdapter(options: SmsProviderAdapterOptions): SmsProviderAdapter {
  const { accountId, authToken, http, resolveCompany, resolveContact } = options;
  const now = options.now ?? (() => Date.now());
  const baseUrl = (options.baseUrl ?? SMS_PROVIDER_BASE_URL).replace(/\/+$/, '');

  const fromNumber = normalizePhone(options.fromNumber);
  if (fromNumber === undefined) throw new RangeError('fromNumber must be a valid phone number');
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new RangeError('accountId is required');
  }
  if (typeof authToken !== 'string' || authToken.trim() === '') {
    throw new RangeError('authToken is required');
  }

  // Inbound parsing and status mapping do not touch the provider. Their provider is never called.
  const pure = createSmsTransport({
    provider: {
      send: async () => {
        throw new Error('not used');
      },
    },
  });

  async function send(input: SmsAdapterSendInput): Promise<SmsAdapterSendResult> {
    try {
      const companyId = input?.companyId;
      if (typeof companyId !== 'string' || !UUID.test(companyId)) {
        return { ok: false, reason: 'invalid_company' };
      }

      const body = input.body;
      if (typeof body !== 'string' || body.length === 0) {
        return { ok: false, reason: 'invalid_body' };
      }
      if (body.length > SMS_MAX_BODY_LENGTH) {
        return { ok: false, reason: 'body_too_long' };
      }

      const to = normalizePhone(input.to);
      if (to === undefined) {
        return { ok: false, reason: 'invalid_number' };
      }

      if (options.suppression && options.suppression.isSuppressed(companyId, { address: to, channel: 'sms' })) {
        return { ok: false, reason: 'suppressed' };
      }

      const policy = await resolveCompany(companyId);
      if (!policy) return { ok: false, reason: 'invalid_company' };

      const contact = await resolveContact(companyId, to);
      // The consent record must belong to the number being sent to, or it does not count.
      const ownerPhone = contact?.handles?.phone;
      if (!contact || typeof ownerPhone !== 'string' || normalizePhone(ownerPhone) !== to) {
        return { ok: false, reason: 'invalid_contact' };
      }

      // Quiet hours are read in the contact's own timezone (contact.timezone), not the company's.
      const decision = checkConsent({
        channel: 'sms',
        contact,
        now: now(),
        quietHours: policy.quietHours,
      });
      if (!decision.allowed) return { ok: false, reason: decision.reason };

      // Plivo takes E.164 digits without the leading '+' in src and dst.
      const url = `${baseUrl}/Account/${encodeURIComponent(accountId)}/Message/`;
      const requestBody = JSON.stringify({
        src: fromNumber.replace(/^\+/, ''),
        dst: to.replace(/^\+/, ''),
        text: body,
      });

      // The pending audit event is written before the provider is called. If it cannot be written, nothing is sent.
      let audit: CommsSendAudit | null;
      try {
        audit = await openSendAudit(options.auditSink, {
          companyId,
          actorId: input.actorId,
          channel: 'sms',
          now,
        });
      } catch {
        return { ok: false, reason: 'audit_unavailable', auditRecorded: false };
      }
      const finish = (status: 'sent' | 'provider_error'): Promise<CommsSendAuditOutcome> =>
        audit ? audit.finish(status) : Promise.resolve(NO_SEND_AUDIT);

      let response: SmsAdapterHttpResponse;
      try {
        response = await http(url, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(accountId, authToken),
            'Content-Type': 'application/json',
          },
          body: requestBody,
        });
      } catch {
        // Transport-level error text may echo the URL or credentials. It is dropped.
        return { ok: false, reason: 'provider_error', ...(await finish('provider_error')) };
      }

      if (!response || !response.ok) {
        return { ok: false, reason: 'provider_error', ...(await finish('provider_error')) };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: 'provider_error', ...(await finish('provider_error')) };
      }

      // Plivo answers 202 with message_uuid as an array of ids, one per message part.
      const uuids = (payload as { message_uuid?: unknown } | null)?.message_uuid;
      const externalId = Array.isArray(uuids) ? uuids[0] : undefined;
      if (typeof externalId !== 'string' || externalId.trim() === '') {
        return { ok: false, reason: 'provider_error', ...(await finish('provider_error')) };
      }
      return { ok: true, externalId, ...(await finish('sent')) };
    } catch {
      // Covers a bad quiet-hours or timezone value thrown by checkConsent. No detail is returned.
      return { ok: false, reason: 'provider_error' };
    }
  }

  return {
    send,
    mapStatus: pure.mapStatus,
    inbound: pure.inbound,
  };
}
