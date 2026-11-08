/**
 * Telegram webhook verification and webhook setup.
 *
 * Telegram does not sign payloads. Its equivalent is the secret_token set with setWebhook: Telegram echoes it in the
 * X-Telegram-Bot-Api-Secret-Token header on every update. The legacy PHP provider accepted every request
 * (verifyWebhook returned true). This port fails closed.
 */
import { randomBytes } from "node:crypto";
import { constantTimeEqual } from "../framework.ts";
import type { ChannelCredentials, HttpRequest, RawWebhook, WebhookVerification } from "../../contracts/index.ts";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Credential keys. Names match the PHP credentials array where one existed (telegram_token). */
export const TELEGRAM_CREDENTIAL_KEYS = {
  botToken: "telegram_token",
  webhookSecret: "webhook_secret",
} as const;

/** Constant-time string comparison. Shared with every provider through the channel framework. */
export const constantTimeEqualString = constantTimeEqual;

/** Checks the secret token. Missing credentials, a missing header, or a mismatch all reject. */
export function verifyTelegramSecretToken(raw: RawWebhook, credentials: ChannelCredentials): WebhookVerification {
  const expected = credentials[TELEGRAM_CREDENTIAL_KEYS.webhookSecret];
  if (typeof expected !== "string" || expected.length === 0) {
    return { ok: false, reason: "credentials_missing" };
  }
  const provided = raw.headers[TELEGRAM_SECRET_HEADER];
  if (typeof provided !== "string" || provided.length === 0) {
    return { ok: false, reason: "signature_missing" };
  }
  return constantTimeEqualString(provided, expected) ? { ok: true } : { ok: false, reason: "signature_invalid" };
}

/** A new secret token. Telegram allows A-Z, a-z, 0-9, underscore and hyphen, up to 256 characters. */
export function generateTelegramWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Builds the setWebhook call. Sent as a JSON POST, so the webhook URL and secret stay out of the query string.
 * The caller passes the HttpClient and reads the response with parseTelegramResponse in send.ts.
 */
export function buildSetWebhookRequest(
  credentials: ChannelCredentials,
  webhookUrl: string,
  timeoutMs: number,
): HttpRequest {
  const token = credentials[TELEGRAM_CREDENTIAL_KEYS.botToken];
  const secret = credentials[TELEGRAM_CREDENTIAL_KEYS.webhookSecret];
  if (!token || !secret) {
    throw new Error("telegram: bot token and webhook secret are required to set the webhook");
  }
  return {
    method: "POST",
    url: `${TELEGRAM_API_BASE}/bot${token}/setWebhook`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ["message"] }),
    timeoutMs,
  };
}
