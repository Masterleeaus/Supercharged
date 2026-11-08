// Meta (Messenger and Instagram) outbound send request builder and sender.
// The access token is only ever placed in the Authorization header. The HTTP client is injected,
// so this module performs no network I/O on its own. sendMeta() never throws and never returns the token.

import { checkConsent, type Contact } from './consent.ts';
import { canSendFreeForm, type WindowTime } from './whatsapp-window.ts';

export const META_GRAPH_SEND_URL = 'https://graph.facebook.com/v20.0/me/messages';
export const META_TEXT_MAX_LENGTH = 1000;

export type MetaSendChannel = 'messenger' | 'instagram';

/**
 * 'marketing' is allowed only on Messenger, only with a recorded Messenger opt-in, and only
 * inside the 24-hour reply window (route 'window'). Sponsored Messages (route 'sponsored') use a
 * different send path that this module does not build, so they are refused here for now.
 * 'transactional' is the default and keeps the existing behaviour.
 */
export type MetaBuildPurpose = 'marketing' | 'transactional';
export type MetaBuildRoute = 'window' | 'sponsored';

export type MetaBuildFailure =
  | 'unsupported_channel'
  | 'invalid_recipient'
  | 'empty_text'
  | 'text_too_long'
  | 'invalid_purpose'
  | 'invalid_route'
  | 'marketing_channel_unsupported'
  | 'sponsored_unavailable'
  | 'opt_in_required'
  | 'contact_invalid'
  | 'invalid_time'
  | 'window_closed'
  | 'no_inbound'
  | 'clock_skew'
  | 'invalid_idempotency_key';

export interface MetaMessageRequest {
  url: string;
  body: {
    recipient: { id: string };
    messaging_type: 'RESPONSE';
    message: { text: string };
  };
  /** Caller-side dedupe key. Never sent to Meta. Present only when the caller supplied one. */
  idempotencyKey?: string;
}

export type MetaBuildResult =
  | { ok: true; request: MetaMessageRequest }
  | { ok: false; reason: MetaBuildFailure };

export interface MetaHttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

/**
 * 'uncertain' means the send timed out, so the message may or may not have been delivered.
 * With an idempotencyKey the caller may retry with that same key. Without one, do not retry.
 */
export type MetaSendResult =
  | { ok: true; messageId: string; idempotencyKey?: string }
  | { ok: false; reason: 'provider_error' | 'uncertain'; idempotencyKey?: string };

const CHANNELS: readonly string[] = ['messenger', 'instagram'];
const DIGITS = /^[0-9]+$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

// Unkeyed requests whose send timed out. A second send of the same request object is refused without an HTTP call.
const uncertainUnkeyed = new WeakSet<object>();

export interface MetaBuildInput {
  channel: string;
  recipientId: string;
  text: string;
  purpose?: MetaBuildPurpose;
  route?: MetaBuildRoute;
  contact?: Contact | null;
  lastInboundAt?: WindowTime | null;
  now?: WindowTime;
  /** Caller-side dedupe key (1 to 128 chars of letters, digits, . : _ -). Not sent to Meta. */
  idempotencyKey?: string | null;
}

function isUsableTime(value: unknown): value is WindowTime {
  const ms = value instanceof Date ? value.getTime() : value;
  return typeof ms === 'number' && Number.isFinite(ms);
}

// Marketing gate for Messenger. Returns null when the send may proceed, otherwise the reason.
// Fails closed: a missing contact, a missing or malformed time, or a closed window all refuse.
function marketingRefusal(input: MetaBuildInput, recipientId: string): MetaBuildFailure | null {
  if (input.channel !== 'messenger') return 'marketing_channel_unsupported';
  if (input.route === 'sponsored') return 'sponsored_unavailable';
  if (input.route !== undefined && input.route !== 'window') return 'invalid_route';

  const { contact, now, lastInboundAt } = input;
  if (!contact || typeof contact !== 'object') return 'opt_in_required';
  if (!isUsableTime(now)) return 'invalid_time';

  const consent = checkConsent({
    channel: 'messenger',
    contact: { ...contact, handles: { ...(contact.handles ?? {}), messenger: recipientId } },
    now,
  });
  if (!consent.allowed) return 'opt_in_required';

  try {
    const window = canSendFreeForm({ lastInboundAt, now });
    if (!window.freeForm) return window.reason;
  } catch {
    return 'invalid_time';
  }
  return null;
}

export function buildMetaMessageRequest(input: MetaBuildInput): MetaBuildResult {
  const { channel, recipientId, text } = input ?? ({} as MetaBuildInput);
  const key = input?.idempotencyKey;
  const hasKey = key !== undefined && key !== null;
  if (hasKey && !isValidIdempotencyKey(key)) return { ok: false, reason: 'invalid_idempotency_key' };
  if (typeof channel !== 'string' || !CHANNELS.includes(channel)) {
    return { ok: false, reason: 'unsupported_channel' };
  }
  if (typeof recipientId !== 'string' || recipientId.length === 0 || !DIGITS.test(recipientId)) {
    return { ok: false, reason: 'invalid_recipient' };
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty_text' };
  }
  if (text.length > META_TEXT_MAX_LENGTH) {
    return { ok: false, reason: 'text_too_long' };
  }
  const purpose = input.purpose ?? 'transactional';
  if (purpose !== 'marketing' && purpose !== 'transactional') {
    return { ok: false, reason: 'invalid_purpose' };
  }
  if (purpose === 'marketing') {
    const refusal = marketingRefusal(input, recipientId);
    if (refusal !== null) return { ok: false, reason: refusal };
  }
  const request: MetaMessageRequest = {
    url: META_GRAPH_SEND_URL,
    body: {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
    },
  };
  if (hasKey) request.idempotencyKey = key;
  return { ok: true, request };
}

/** Deadline for one provider send. On expiry sendMeta returns provider_error. */
export const META_PROVIDER_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol('meta-provider-timeout');

export async function sendMeta(input: {
  accessToken: string;
  request: MetaMessageRequest;
  http: MetaHttpClient;
  /** Optional send deadline in ms. Invalid values fall back to META_PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
}): Promise<MetaSendResult> {
  const requestKey = input?.request?.idempotencyKey;
  // The key is echoed on every result for a keyed request, so a retry can dedupe.
  const withKey = (result: MetaSendResult): MetaSendResult =>
    requestKey === undefined ? result : { ...result, idempotencyKey: requestKey };
  try {
    const { accessToken, request, http } = input;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return withKey({ ok: false, reason: 'provider_error' });
    }
    if (requestKey !== undefined && !isValidIdempotencyKey(requestKey)) {
      return withKey({ ok: false, reason: 'provider_error' });
    }
    // An unkeyed send that already timed out may have delivered. Never send it again.
    if (requestKey === undefined && uncertainUnkeyed.has(request)) {
      return { ok: false, reason: 'uncertain' };
    }
    const timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : META_PROVIDER_TIMEOUT_MS;
    // Race the POST against a deadline so a provider that never answers cannot hang the caller.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    let raw: unknown;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() =>
          http.post(request.url, request.body, {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          }),
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (raw === TIMED_OUT) {
      // The POST is still in flight, so the message may still be delivered.
      if (requestKey === undefined) uncertainUnkeyed.add(request);
      return withKey({ ok: false, reason: 'uncertain' });
    }
    const response = raw as { message_id?: unknown } | null | undefined;
    const messageId = response?.message_id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return withKey({ ok: false, reason: 'provider_error' });
    }
    return withKey({ ok: true, messageId });
  } catch {
    return withKey({ ok: false, reason: 'provider_error' });
  }
}
