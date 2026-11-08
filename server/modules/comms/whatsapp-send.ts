// WhatsApp Cloud API request builder and sender.
//
// buildWhatsAppRequest is pure: it takes the decision from decideWhatsAppSend and returns the
// URL and JSON body, or a refusal. sendWhatsApp performs one POST through an injected `http`
// function. The access token is sent only in the Authorization header. It never appears in a
// result, and no provider detail is returned. sendWhatsApp never throws.

import type { WhatsAppSendDecision } from './whatsapp-window.ts';
import { checkConsent, type Contact } from './consent.ts';

export const WHATSAPP_GRAPH_VERSION = 'v20.0';
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;
export const WHATSAPP_MAX_VARIABLE_LENGTH = 1024;

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Za-z0-9]{2,4})?$/i;
const DIGITS = /^[0-9]+$/;

/**
 * 'marketing' needs a recorded WhatsApp opt-in for the recipient's own phone number.
 * 'transactional' is the default and needs no opt-in (the adapter applies its own rules).
 */
export type WhatsAppBuildPurpose = 'marketing' | 'transactional';

export interface WhatsAppBuildInput {
  phoneNumberId: string;
  to: string;
  decision: WhatsAppSendDecision;
  templateName?: string;
  templateLanguage?: string;
  variables?: readonly string[];
  text?: string;
  purpose?: WhatsAppBuildPurpose;
  contact?: Contact | null;
  /** Caller-side dedupe key (1 to 128 chars of letters, digits, . : _ -). Not sent to WhatsApp. */
  idempotencyKey?: string | null;
}

export type WhatsAppBuildFailureReason =
  | 'template_required'
  | 'invalid_recipient'
  | 'invalid_sender'
  | 'invalid_template'
  | 'invalid_text'
  | 'invalid_variable'
  | 'invalid_purpose'
  | 'opt_in_required'
  | 'invalid_idempotency_key';

export type WhatsAppBuildResult =
  | { ok: true; url: string; body: Record<string, unknown>; idempotencyKey?: string }
  | { ok: false; reason: WhatsAppBuildFailureReason };

export interface WhatsAppHttpRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface WhatsAppHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type WhatsAppHttp = (url: string, init: WhatsAppHttpRequest) => Promise<WhatsAppHttpResponse>;

export type WhatsAppSendFailureReason =
  | WhatsAppBuildFailureReason
  | 'invalid_token'
  | 'invalid_request'
  | 'provider_error'
  /** The send timed out. With an idempotencyKey, retry with that key only. Without one, do not retry. */
  | 'uncertain';

export type WhatsAppSendResult =
  | { ok: true; externalId: string; idempotencyKey?: string }
  | { ok: false; reason: WhatsAppSendFailureReason; idempotencyKey?: string };

export interface WhatsAppSendOptions {
  accessToken: string;
  request: { url: string; body: Record<string, unknown>; idempotencyKey?: string };
  http: WhatsAppHttp;
  /** Optional send deadline in ms. Invalid values fall back to WHATSAPP_PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Deadline for one provider send. On expiry sendWhatsApp returns provider_error. */
export const WHATSAPP_PROVIDER_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol('whatsapp-provider-timeout');

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

// Unkeyed requests whose send timed out. A second send of the same request object is refused without an HTTP call.
const uncertainUnkeyed = new WeakSet<object>();

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeRecipient(to: unknown): string | null {
  if (typeof to !== 'string') return null;
  const digits = to.startsWith('+') ? to.slice(1) : to;
  return DIGITS.test(digits) ? digits : null;
}

// A marketing send needs a WhatsApp opt-in recorded on the contact whose phone handle is the
// recipient. checkConsent is called without quiet hours, so this checks the record only.
// Any refusal (no record, opted out, wrong channel, invalid contact) means no opt-in.
function hasWhatsAppMarketingOptIn(contact: Contact | null | undefined, to: string): boolean {
  if (!contact || typeof contact !== 'object') return false;
  if (normalizeRecipient(contact.handles?.phone) !== to) return false;
  return checkConsent({ channel: 'whatsapp', contact, now: 0 }).allowed === true;
}

export function buildWhatsAppRequest(input: WhatsAppBuildInput): WhatsAppBuildResult {
  const key = input.idempotencyKey;
  const hasKey = key !== undefined && key !== null;
  if (hasKey && !isValidIdempotencyKey(key)) return { ok: false, reason: 'invalid_idempotency_key' };
  const built = buildCore(input);
  if (built.ok && hasKey) return { ...built, idempotencyKey: key };
  return built;
}

function buildCore(input: WhatsAppBuildInput): WhatsAppBuildResult {
  const decision = input.decision;
  if (!decision || decision.send === 'refuse') {
    return { ok: false, reason: 'template_required' };
  }

  const purpose = input.purpose ?? 'transactional';
  if (purpose !== 'marketing' && purpose !== 'transactional') {
    return { ok: false, reason: 'invalid_purpose' };
  }

  const to = normalizeRecipient(input.to);
  if (to === null) return { ok: false, reason: 'invalid_recipient' };

  if (purpose === 'marketing' && !hasWhatsAppMarketingOptIn(input.contact, to)) {
    return { ok: false, reason: 'opt_in_required' };
  }

  const phoneNumberId = input.phoneNumberId;
  if (typeof phoneNumberId !== 'string' || !DIGITS.test(phoneNumberId)) {
    return { ok: false, reason: 'invalid_sender' };
  }

  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`;

  if (decision.send === 'free_form') {
    if (typeof input.text !== 'string' || input.text.length === 0) {
      return { ok: false, reason: 'invalid_text' };
    }
    if (codePointLength(input.text) > WHATSAPP_MAX_TEXT_LENGTH) {
      return { ok: false, reason: 'invalid_text' };
    }
    return {
      ok: true,
      url,
      body: {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: input.text },
      },
    };
  }

  // decision.send === 'template'
  if (typeof input.templateName !== 'string' || !TEMPLATE_NAME.test(input.templateName)) {
    return { ok: false, reason: 'invalid_template' };
  }
  if (typeof input.templateLanguage !== 'string' || !TEMPLATE_LANGUAGE.test(input.templateLanguage)) {
    return { ok: false, reason: 'invalid_template' };
  }

  const variables = input.variables ?? [];
  for (const value of variables) {
    if (typeof value !== 'string' || codePointLength(value) > WHATSAPP_MAX_VARIABLE_LENGTH) {
      return { ok: false, reason: 'invalid_variable' };
    }
  }

  const template: Record<string, unknown> = {
    name: input.templateName,
    language: { code: input.templateLanguage },
  };
  if (variables.length > 0) {
    template.components = [
      {
        type: 'body',
        parameters: variables.map((value) => ({ type: 'text', text: value })),
      },
    ];
  }

  return {
    ok: true,
    url,
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template,
    },
  };
}

function isBuiltRequest(value: unknown): value is { url: string; body: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { url?: unknown; body?: unknown };
  return (
    typeof candidate.url === 'string' &&
    candidate.url.startsWith(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/`) &&
    !!candidate.body &&
    typeof candidate.body === 'object'
  );
}

export async function sendWhatsApp(options: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
  const requestKey = options?.request?.idempotencyKey;
  // The key is echoed on every result for a keyed request, so a retry can dedupe.
  const withKey = (result: WhatsAppSendResult): WhatsAppSendResult =>
    requestKey === undefined ? result : { ...result, idempotencyKey: requestKey };
  try {
    const { accessToken, request, http } = options ?? ({} as WhatsAppSendOptions);
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return withKey({ ok: false, reason: 'invalid_token' });
    }
    if (!isBuiltRequest(request) || typeof http !== 'function') {
      return withKey({ ok: false, reason: 'invalid_request' });
    }
    if (requestKey !== undefined && !isValidIdempotencyKey(requestKey)) {
      return withKey({ ok: false, reason: 'invalid_request' });
    }
    // An unkeyed send that already timed out may have delivered. Never send it again.
    if (requestKey === undefined && uncertainUnkeyed.has(request)) {
      return { ok: false, reason: 'uncertain' };
    }

    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : WHATSAPP_PROVIDER_TIMEOUT_MS;
    // Race the POST against a deadline so a provider that never answers cannot hang the caller.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    let response: WhatsAppHttpResponse | typeof TIMED_OUT;
    try {
      response = await Promise.race([
        Promise.resolve().then(() =>
          http(request.url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(request.body),
          }),
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (response === TIMED_OUT) {
      // The POST is still in flight, so the message may still be delivered.
      if (requestKey === undefined) uncertainUnkeyed.add(request);
      return withKey({ ok: false, reason: 'uncertain' });
    }
    if (!response || response.ok !== true) {
      return withKey({ ok: false, reason: 'provider_error' });
    }

    const payload = await response.json();
    const messages = (payload as { messages?: unknown } | null)?.messages;
    const id = Array.isArray(messages) ? (messages[0] as { id?: unknown } | undefined)?.id : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      return withKey({ ok: false, reason: 'provider_error' });
    }
    return withKey({ ok: true, externalId: id });
  } catch {
    return withKey({ ok: false, reason: 'provider_error' });
  }
}
