/**
 * Telegram outbound send. Calls sendMessage through the injected HttpClient.
 *
 * The legacy PHP built a GET URL that carried the bot token and the text in the query string, and it threw on failure.
 * This port uses a JSON POST and returns a SendResult. The token is in the URL path, as Telegram requires, but the
 * error messages built here never include it.
 */
import type { ChannelCredentials, HttpClient, HttpResponse, SendResult } from "../../contracts/index.ts";
import { TELEGRAM_API_BASE, TELEGRAM_CREDENTIAL_KEYS } from "./verify.ts";

/** Telegram's published sendMessage text limit, in characters. */
export const TELEGRAM_MAX_TEXT = 4096;
export const TELEGRAM_TIMEOUT_MS = 10_000;

/** Removes the bot token and any long secret-looking value from text that may be shown or stored. */
export function redactTelegram(text: string, credentials: ChannelCredentials): string {
  let out = text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
  for (const value of Object.values(credentials)) {
    if (typeof value === "string" && value.length >= 6) out = out.split(value).join("[redacted]");
  }
  return out.slice(0, 300);
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Maps a Telegram response to a SendResult. Exported for tests. */
export function mapTelegramResponse(response: HttpResponse, credentials: ChannelCredentials): SendResult {
  const body = parseJson(response.body);
  if (response.status === 200 && body && body.ok === true) {
    const result = body.result as Record<string, unknown> | undefined;
    const id = result && typeof result.message_id === "number" ? String(result.message_id) : null;
    return id
      ? { status: "sent", externalMessageId: id }
      : { status: "failed", errorCode: "bad_response", retryable: false, message: "Telegram reply had no message id." };
  }
  const description = body && typeof body.description === "string" ? redactTelegram(body.description, credentials) : "";
  if (response.status === 429) {
    return { status: "failed", errorCode: "rate_limited", retryable: true, message: description || "Rate limited." };
  }
  if (response.status >= 500) {
    return { status: "failed", errorCode: "provider_unavailable", retryable: true, message: description || "Telegram unavailable." };
  }
  if (response.status === 401) {
    return { status: "failed", errorCode: "auth_failed", retryable: false, message: "Telegram rejected the bot token." };
  }
  if (response.status === 403) {
    return { status: "failed", errorCode: "recipient_blocked", retryable: false, message: description || "Recipient blocked the bot." };
  }
  return { status: "failed", errorCode: "rejected", retryable: false, message: description || "Telegram rejected the message." };
}

/** Reply target. The id is "<chat>:<message>", as produced by parse.ts. Only same-chat replies are kept. */
export function replyTargetFor(recipient: string, replyTo: string | null): number | null {
  if (!replyTo) return null;
  const [chat, message] = replyTo.split(":");
  if (chat !== recipient || !message || !/^\d+$/.test(message)) return null;
  return Number(message);
}

export interface TelegramTextRequest {
  recipient: string;
  text: string;
  replyTo: string | null;
}

export async function sendTelegramText(
  request: TelegramTextRequest,
  credentials: ChannelCredentials,
  http: HttpClient,
): Promise<SendResult> {
  const token = credentials[TELEGRAM_CREDENTIAL_KEYS.botToken];
  if (!token) {
    return { status: "failed", errorCode: "credentials_missing", retryable: false, message: "No bot token on this account." };
  }
  const payload: Record<string, unknown> = { chat_id: request.recipient, text: request.text };
  const replyTarget = replyTargetFor(request.recipient, request.replyTo);
  if (replyTarget !== null) payload.reply_to_message_id = replyTarget;

  let response: HttpResponse;
  try {
    response = await http({
      method: "POST",
      url: `${TELEGRAM_API_BASE}/bot${token}/sendMessage`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: TELEGRAM_TIMEOUT_MS,
    });
  } catch (error) {
    const timedOut = typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "timeout";
    return {
      status: "failed",
      errorCode: timedOut ? "timeout" : "network",
      retryable: true,
      message: "Telegram request failed or timed out.",
    };
  }
  return mapTelegramResponse(response, credentials);
}
