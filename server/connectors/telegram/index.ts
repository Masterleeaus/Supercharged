/**
 * Telegram Bot API send as a ConnectorDefinition (#357).
 *
 * One write action, sendMessage. The credential is an api_key holding the bot token. Request building and the
 * provider call come from server/modules/comms/telegram-send.ts, so the existing refusal and 'uncertain' rules
 * are kept as they are. This file only maps those results onto the SDK taxonomy.
 *
 * Decision: Telegram puts the bot token in the request path (https://api.telegram.org/bot<token>/sendMessage).
 * That is the Bot API's design, so the token is in the URL here. Errors from the transport are never forwarded,
 * because they can echo that URL.
 *
 * Sends are not idempotent at Telegram. An outcome that is 'uncertain' (timed out) maps to the non-retryable
 * 'unknown' code, so the runner never resends it. Gated callers also set maxAttempts to 1.
 */
import {
  ConnectorError,
  type ActionRequest,
  type ConnectorCredentials,
  type ConnectorDefinition,
} from '../sdk/contract.ts';
import {
  buildTelegramSendRequest,
  sendTelegram,
  type TelegramHttp,
  type TelegramSendRequest,
} from '../../modules/comms/telegram-send.ts';

export const TELEGRAM_CONNECTOR_ID = 'telegram';
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{10,}$/;

export interface SendTelegramInput {
  chatId: string | number;
  text: string;
  replyToMessageId?: number;
}

export interface SendTelegramResultValue {
  externalId: string;
}

export interface TelegramConnectorOptions {
  /** POST port. Tests inject a fake. The default uses fetch with a JSON body. */
  http?: TelegramHttp;
}

const defaultHttp: TelegramHttp = {
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => null);
  },
};

/** Builds the Telegram request. A refusal becomes a validation error with no caller data in the message. */
export function validateSendInput(input: unknown): { request: TelegramSendRequest; text: string } {
  if (typeof input !== 'object' || input === null) throw new ConnectorError('validation', 'sendMessage input must be an object');
  const { chatId, text, replyToMessageId } = input as Record<string, unknown>;
  try {
    const request = buildTelegramSendRequest({
      chatId: chatId as string | number,
      text: text as string,
      replyToMessageId: (replyToMessageId as number | undefined) ?? null,
    });
    return { request, text: text as string };
  } catch (err) {
    const reason = (err as { reason?: string }).reason ?? 'invalid';
    throw new ConnectorError('validation', `telegram send refused: ${reason}`);
  }
}

/** The vault value is the bot token. Malformed values fail as auth without echoing the value. */
export function parseTelegramToken(credentials: ConnectorCredentials): string {
  if (credentials.type !== 'api_key') throw new ConnectorError('auth', 'Telegram needs an api_key credential');
  if (!BOT_TOKEN.test(credentials.apiKey)) throw new ConnectorError('auth', 'Telegram credential is malformed');
  return credentials.apiKey;
}

export function createTelegramConnector(options: TelegramConnectorOptions = {}): ConnectorDefinition {
  const http = options.http ?? defaultHttp;

  async function execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<SendTelegramResultValue> {
    if (request.action !== 'sendMessage') throw new ConnectorError('validation', `unknown action "${request.action}"`);
    const { request: sendRequest } = validateSendInput(request.input);
    const token = parseTelegramToken(credentials);

    const result = await sendTelegram({ token, request: sendRequest, http, timeoutMs: request.timeoutMs });
    if (result.ok) return { externalId: String(result.messageId) };
    if (result.ok === false && result.reason === 'uncertain') {
      throw new ConnectorError('unknown', 'Telegram send outcome is unknown; it was not retried');
    }
    throw new ConnectorError('upstream', 'Telegram send failed');
  }

  return {
    id: TELEGRAM_CONNECTOR_ID,
    auth: 'api_key',
    capabilities: ['write'],
    entities: ['message'],
    actions: { sendMessage: { kind: 'write', entity: 'message' } },
    execute,
  };
}
