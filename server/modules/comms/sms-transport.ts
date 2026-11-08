// Provider-agnostic SMS send, status and inbound parsing. The real provider (Twilio or Plivo) is
// injected through the `provider` option, so this module imports no provider SDK.
// Pure apart from the injected provider call. Never throws from send().

import { createHash } from 'node:crypto';
import { normalizePhone } from './contact-dedupe.ts';

export const SMS_MAX_BODY_LENGTH = 1600;

/** Deadline for one provider send. On expiry send() returns provider_error and nothing is marked sent. */
export const SMS_PROVIDER_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol('sms-provider-timeout');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SmsProviderSendRequest {
  to: string;
  body: string;
  idempotencyKey: string;
}

export interface SmsProviderSendResult {
  externalId: string;
}

export interface SmsProvider {
  send(request: SmsProviderSendRequest): Promise<SmsProviderSendResult>;
}

export interface SmsTransportOptions {
  provider: SmsProvider;
  /** Injected clock. Reserved for callers that need a timestamp; no method here reads it. */
  now?: () => number;
  /** Provider send deadline in ms. Defaults to SMS_PROVIDER_TIMEOUT_MS; invalid values fall back to it. */
  timeoutMs?: number;
}

export interface SmsSendInput {
  companyId: string;
  to: string;
  body: string;
}

export type SmsSendFailureReason =
  | 'invalid_company'
  | 'invalid_body'
  | 'body_too_long'
  | 'invalid_number'
  | 'provider_error'
  // Consent and send-window refusals raised by the provider adapter before any provider call.
  | 'invalid_contact'
  | 'opted_out'
  | 'no_consent'
  | 'channel_not_consented'
  | 'quiet_hours';

export type SmsSendResult =
  | { ok: true; externalId: string }
  | { ok: false; reason: SmsSendFailureReason };

export type SmsDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered';

export interface SmsInboundPayload {
  from: unknown;
  to: unknown;
  body: unknown;
  providerMessageId: unknown;
}

export interface SmsInboundMessage {
  channel: 'sms';
  from: string;
  to: string;
  body: string;
  externalId: string;
}

export type SmsInboundResult =
  | { ok: true; message: SmsInboundMessage }
  | { ok: false; reason: 'invalid_inbound' };

export interface SmsTransport {
  send(input: SmsSendInput): Promise<SmsSendResult>;
  mapStatus(providerStatus: unknown): SmsDeliveryStatus | 'unknown';
  inbound(payload: SmsInboundPayload | unknown): SmsInboundResult;
}

/** Only exact provider status strings are mapped. Anything else is 'unknown'; nothing is guessed. */
const STATUS_MAP: Readonly<Record<string, SmsDeliveryStatus>> = {
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  undelivered: 'undelivered',
};

/** Maps a provider status string to a delivery status. Unknown or non-string input gives 'unknown'. */
export function mapSmsDeliveryStatus(providerStatus: unknown): SmsDeliveryStatus | 'unknown' {
  if (typeof providerStatus !== 'string') return 'unknown';
  const key = providerStatus.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, key) ? STATUS_MAP[key] : 'unknown';
}

// Ranks for delivery receipts, which can arrive out of order. queued < sent < any final status.
// The first final status wins: a later 'failed' does not replace an earlier 'delivered'.
const DELIVERY_RANK: Readonly<Record<SmsDeliveryStatus, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
  undelivered: 2,
};

/**
 * True when `next` may be written over `current`. A missing current status accepts anything.
 * Repeating the same status is allowed. A lower rank, or a different final status, is refused.
 */
export function canAdvanceDeliveryStatus(
  current: SmsDeliveryStatus | null | undefined,
  next: SmsDeliveryStatus,
): boolean {
  if (current === null || current === undefined) return true;
  if (current === next) return true;
  if (DELIVERY_RANK[current] >= 2) return false;
  return DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function createSmsTransport(options: SmsTransportOptions): SmsTransport {
  const { provider } = options;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : SMS_PROVIDER_TIMEOUT_MS;

  async function send(input: SmsSendInput): Promise<SmsSendResult> {
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

      const idempotencyKey = `sms:${companyId}:${to}:${sha256Hex(body)}`;

      // Race the provider call against a deadline. A late provider settlement after the deadline is
      // ignored here; the idempotency key stops a retry from sending a duplicate.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      let result: SmsProviderSendResult | typeof TIMED_OUT;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => provider.send({ to, body, idempotencyKey })),
          deadline,
        ]);
      } catch {
        // The provider error text is dropped on purpose: it may contain the number.
        return { ok: false, reason: 'provider_error' };
      } finally {
        clearTimeout(timer);
      }
      if (result === TIMED_OUT) {
        return { ok: false, reason: 'provider_error' };
      }

      const externalId = result?.externalId;
      if (!isNonEmptyString(externalId)) {
        return { ok: false, reason: 'provider_error' };
      }
      return { ok: true, externalId };
    } catch {
      return { ok: false, reason: 'provider_error' };
    }
  }

  function mapStatus(providerStatus: unknown): SmsDeliveryStatus | 'unknown' {
    return mapSmsDeliveryStatus(providerStatus);
  }

  function inbound(payload: SmsInboundPayload | unknown): SmsInboundResult {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: 'invalid_inbound' };
    }
    const p = payload as Record<string, unknown>;
    if (
      !isNonEmptyString(p.from) ||
      !isNonEmptyString(p.to) ||
      typeof p.body !== 'string' ||
      !isNonEmptyString(p.providerMessageId)
    ) {
      return { ok: false, reason: 'invalid_inbound' };
    }
    return {
      ok: true,
      message: {
        channel: 'sms',
        from: p.from,
        to: p.to,
        body: p.body,
        externalId: p.providerMessageId,
      },
    };
  }

  return { send, mapStatus, inbound };
}
