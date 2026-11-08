// Telegram bot webhook helpers: secret token check, update parsing and identity keys.
// Pure functions only: no network, no database, no clock reads, no Telegram API calls.

import { timingSafeEqual } from 'node:crypto';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export type TelegramMediaType = 'photo' | 'video' | 'document' | 'voice' | 'audio';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'verification_failed' };

export type ParsedTelegramMessage = {
  channel: 'telegram';
  externalId: string;
  chatId: string;
  fromId: string | null;
  text: string | null;
  mediaType: TelegramMediaType | null;
  receivedAt: number;
};

export type IgnoredTelegramUpdate = {
  ignored: true;
  reason: 'unsupported_update' | 'invalid_update' | 'chat_not_allowed';
};

export type ParseTelegramOptions = {
  /**
   * When given, only messages from these chat ids are parsed; any other chat is ignored with
   * 'chat_not_allowed'. An empty array therefore ignores every chat (fail closed).
   * When omitted, no chat allowlist is applied.
   */
  allowedChatIds?: readonly (string | number)[];
};

const MEDIA_PRIORITY: TelegramMediaType[] = ['photo', 'video', 'document', 'voice', 'audio'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdLike(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  return false;
}

/**
 * Checks the X-Telegram-Bot-Api-Secret-Token header against the configured secret.
 * The secret is never included in the result.
 */
export function verifySecretToken(input: {
  header: unknown;
  expected: unknown;
}): VerifyResult {
  const { header, expected } = input ?? ({} as { header: unknown; expected: unknown });

  if (typeof expected !== 'string' || expected.length === 0) {
    return { ok: false, reason: 'not_configured' };
  }
  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, reason: 'verification_failed' };
  }

  const got = Buffer.from(header, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (got.length !== want.length) {
    return { ok: false, reason: 'verification_failed' };
  }
  return timingSafeEqual(got, want)
    ? { ok: true }
    : { ok: false, reason: 'verification_failed' };
}

/**
 * Parses a Telegram update that carries a `message` object.
 * Never throws. Updates without `message` (edited_message, callback_query, ...) are
 * reported as unsupported; malformed input is reported as invalid.
 */
export function parseTelegramUpdate(
  update: unknown,
  options?: ParseTelegramOptions,
): ParsedTelegramMessage | IgnoredTelegramUpdate {
  try {
    if (!isRecord(update)) {
      return { ignored: true, reason: 'invalid_update' };
    }

    const message = update.message;
    if (message === undefined || message === null) {
      return { ignored: true, reason: 'unsupported_update' };
    }
    if (!isRecord(message)) {
      return { ignored: true, reason: 'invalid_update' };
    }

    const chat = message.chat;
    if (!isRecord(chat) || !isIdLike(chat.id)) {
      return { ignored: true, reason: 'invalid_update' };
    }
    if (!isIdLike(update.update_id)) {
      return { ignored: true, reason: 'invalid_update' };
    }

    if (options?.allowedChatIds !== undefined) {
      const chatKey = String(chat.id);
      const allowed = options.allowedChatIds.some(
        (id) => isIdLike(id) && String(id) === chatKey,
      );
      if (!allowed) {
        return { ignored: true, reason: 'chat_not_allowed' };
      }
    }
    if (typeof message.date !== 'number' || !Number.isFinite(message.date)) {
      return { ignored: true, reason: 'invalid_update' };
    }

    let fromId: string | null = null;
    if (message.from !== undefined && message.from !== null) {
      if (!isRecord(message.from) || !isIdLike(message.from.id)) {
        return { ignored: true, reason: 'invalid_update' };
      }
      fromId = String(message.from.id);
    }

    const text = typeof message.text === 'string' ? message.text : null;

    let mediaType: TelegramMediaType | null = null;
    for (const kind of MEDIA_PRIORITY) {
      if (message[kind] !== undefined && message[kind] !== null) {
        mediaType = kind;
        break;
      }
    }

    return {
      channel: 'telegram',
      externalId: String(update.update_id),
      chatId: String(chat.id),
      fromId,
      text,
      mediaType,
      receivedAt: message.date * 1000,
    };
  } catch {
    return { ignored: true, reason: 'invalid_update' };
  }
}

/**
 * In-memory replay guard for Telegram update_id values. accept() returns true the first time an
 * id is seen and false for every repeat. Memory is bounded: the oldest ids are evicted past
 * maxEntries, so a very old replay of an evicted id would be accepted again.
 * release() forgets an id whose handling failed, so Telegram's retry is processed, not dropped.
 * Create one instance per process and keep it for the life of the webhook handler.
 */
export function createUpdateDeduplicator(maxEntries = 10_000) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive integer');
  }
  const seen = new Set<string>();
  return {
    accept(updateId: unknown): boolean {
      if (!isIdLike(updateId)) return false;
      const key = String(updateId);
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > maxEntries) {
        const oldest: string | undefined = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    release(updateId: unknown): void {
      if (!isIdLike(updateId)) return;
      seen.delete(String(updateId));
    },
  };
}

/**
 * Builds the identity-map key for a Telegram sender in a chat.
 * Returns null when chatId or fromId is missing.
 */
export function identityKey(input: { chatId: unknown; fromId: unknown }): string | null {
  const chatId = input?.chatId;
  const fromId = input?.fromId;
  if (!isIdLike(chatId) || !isIdLike(fromId)) {
    return null;
  }
  return `telegram:${String(chatId)}:${String(fromId)}`;
}
