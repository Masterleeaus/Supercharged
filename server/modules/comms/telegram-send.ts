// Telegram outbound text send helpers: request building and a provider call behind an injected http function.
// Plain text only (no parse_mode). No database, no clock reads. The only I/O is the injected http.post.

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

export type TelegramSendRefusal =
  | 'text_too_long'
  | 'empty_text'
  | 'invalid_chat_id'
  | 'invalid_reply_to_message_id'
  | 'invalid_idempotency_key';

export type TelegramSendBody = {
  chat_id: string;
  text: string;
  reply_to_message_id?: number;
};

export type TelegramSendRequest = {
  method: 'sendMessage';
  body: TelegramSendBody;
  /** Caller-side dedupe key. Never sent to Telegram. Present only when the caller supplied one. */
  idempotencyKey?: string;
};

export type TelegramHttp = {
  post: (url: string, body: unknown) => Promise<unknown> | unknown;
};

/**
 * 'uncertain' means the send timed out, so the message may or may not have been delivered.
 * With an idempotencyKey the caller may retry with that same key. Without one, do not retry.
 */
export type SendTelegramResult =
  | { ok: true; messageId: number; idempotencyKey?: string }
  | { ok: false; reason: 'provider_error'; idempotencyKey?: string }
  | { ok: false; reason: 'uncertain'; idempotencyKey?: string };

/** 1 to 128 characters: letters, digits, dot, colon, underscore, hyphen. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

// Unkeyed requests whose send timed out. A second send of the same request object is refused without an HTTP call.
const uncertainUnkeyed = new WeakSet<object>();

// Throws an Error whose message is the refusal reason (no caller data is echoed back).
function refuse(reason: TelegramSendRefusal): never {
  const error = new Error(reason) as Error & { reason: TelegramSendRefusal };
  error.reason = reason;
  throw error;
}

export function buildTelegramSendRequest(input: {
  chatId: string | number;
  text: string;
  replyToMessageId?: number | null;
  idempotencyKey?: string | null;
}): TelegramSendRequest {
  const { chatId, text, replyToMessageId, idempotencyKey } = input;

  const validChatId =
    (typeof chatId === 'string' && chatId.trim().length > 0) ||
    (typeof chatId === 'number' && Number.isSafeInteger(chatId));
  if (!validChatId) refuse('invalid_chat_id');

  if (typeof text !== 'string' || text.trim().length === 0) refuse('empty_text');
  if (text.length > TELEGRAM_MAX_TEXT_LENGTH) refuse('text_too_long');

  const body: TelegramSendBody = {
    chat_id: String(chatId),
    text,
  };

  if (replyToMessageId !== undefined && replyToMessageId !== null) {
    if (!Number.isSafeInteger(replyToMessageId) || replyToMessageId <= 0) {
      refuse('invalid_reply_to_message_id');
    }
    body.reply_to_message_id = replyToMessageId;
  }

  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (!isValidIdempotencyKey(idempotencyKey)) refuse('invalid_idempotency_key');
    return { method: 'sendMessage', body, idempotencyKey };
  }

  return { method: 'sendMessage', body };
}

/** Deadline for one provider send. On expiry sendTelegram returns provider_error. */
export const TELEGRAM_PROVIDER_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol('telegram-provider-timeout');

export async function sendTelegram(input: {
  token: string;
  request: TelegramSendRequest;
  http: TelegramHttp;
  /** Optional send deadline in ms. Invalid values fall back to TELEGRAM_PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
}): Promise<SendTelegramResult> {
  const timeoutMs =
    typeof input?.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : TELEGRAM_PROVIDER_TIMEOUT_MS;
  const requestKey = input?.request?.idempotencyKey;
  // The key is echoed on every result for a keyed request, so a retry can dedupe.
  const withKey = (result: SendTelegramResult): SendTelegramResult =>
    requestKey === undefined ? result : { ...result, idempotencyKey: requestKey };
  const providerError = withKey({ ok: false, reason: 'provider_error' });
  try {
    const { token, request, http } = input;
    if (typeof token !== 'string' || token.length === 0) return providerError;
    if (!request || request.method !== 'sendMessage') return providerError;
    if (requestKey !== undefined && !isValidIdempotencyKey(requestKey)) return providerError;
    // An unkeyed send that already timed out may have delivered. Never send it again.
    if (requestKey === undefined && uncertainUnkeyed.has(request)) {
      return { ok: false, reason: 'uncertain' };
    }

    const url = `${TELEGRAM_API_BASE}/bot${token}/${request.method}`;
    // Race the HTTP call against a deadline so a provider that never answers cannot hang the caller.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    let raw: unknown;
    try {
      raw = await Promise.race([Promise.resolve().then(() => http.post(url, request.body)), deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (raw === TIMED_OUT) {
      // The HTTP call is still in flight, so the message may still be delivered.
      if (requestKey === undefined) uncertainUnkeyed.add(request);
      return withKey({ ok: false, reason: 'uncertain' });
    }
    const response = raw as
      | { ok?: unknown; result?: { message_id?: unknown } | null }
      | null
      | undefined;

    if (!response || response.ok !== true) return providerError;
    const messageId = response.result?.message_id;
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
      return providerError;
    }
    return withKey({ ok: true, messageId });
  } catch {
    // Errors from the transport are not forwarded: they may echo the request URL, which contains the token.
    return providerError;
  }
}
