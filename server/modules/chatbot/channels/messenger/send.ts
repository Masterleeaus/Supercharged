/**
 * Messenger outbound send through the Send API (POST /me/messages).
 *
 * The legacy PHP used raw curl with a 10 second timeout and returned a boolean (status 200 only). It discarded the
 * error body. This port maps Graph errors to a SendResult. The page token goes in the Authorization header, as the
 * PHP did, and never in the URL or in any error message.
 */
import type {
  ChannelCredentials,
  HttpClient,
  HttpResponse,
  OutboundMessage,
  SendResult,
} from "../../contracts/index.ts";
import { MESSENGER_CREDENTIAL_KEYS } from "./verify.ts";

/** Graph API version. Copied from the PHP (v18.0). Older than current Graph versions: see DECISIONS.md. */
export const MESSENGER_GRAPH_URL = "https://graph.facebook.com/v18.0/me/messages";
export const MESSENGER_MAX_TEXT = 2000;
export const MESSENGER_TIMEOUT_MS = 10_000;

/** Graph error codes that mean rate limiting or throttling. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
/** Graph error code for messaging outside the allowed window or not permitted for this recipient. */
const NOT_ALLOWED_CODE = 10;
/** Graph error code for an invalid or expired access token. */
const AUTH_CODE = 190;

export function redactMessenger(text: string, credentials: ChannelCredentials): string {
  let out = text.replace(/EAA[A-Za-z0-9_-]{10,}/g, "[redacted]");
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

/** Maps a Graph response to a SendResult. Exported for tests. */
export function mapMessengerResponse(response: HttpResponse, credentials: ChannelCredentials): SendResult {
  const body = parseJson(response.body);
  if (response.status === 200 && body) {
    const id = typeof body.message_id === "string" ? body.message_id : null;
    return id
      ? { status: "sent", externalMessageId: id }
      : { status: "failed", errorCode: "bad_response", retryable: false, message: "Graph reply had no message id." };
  }
  const error = body && typeof body.error === "object" && body.error !== null ? (body.error as Record<string, unknown>) : {};
  const code = typeof error.code === "number" ? error.code : null;
  const message = typeof error.message === "string" ? redactMessenger(error.message, credentials) : "";

  if (response.status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    return { status: "failed", errorCode: "rate_limited", retryable: true, message: message || "Rate limited." };
  }
  if (code === AUTH_CODE) {
    return { status: "failed", errorCode: "auth_failed", retryable: false, message: "Messenger rejected the page token." };
  }
  if (code === NOT_ALLOWED_CODE) {
    return { status: "failed", errorCode: "messaging_not_allowed", retryable: false, message: message || "Messaging not allowed." };
  }
  if (response.status >= 500) {
    return { status: "failed", errorCode: "provider_unavailable", retryable: true, message: message || "Messenger unavailable." };
  }
  return { status: "failed", errorCode: "rejected", retryable: false, message: message || "Messenger rejected the message." };
}

/** Builds the Send API body. Text or one media attachment. Returns a failure when the content cannot be sent. */
export function buildMessengerBody(
  message: OutboundMessage,
): { ok: true; body: Record<string, unknown> } | { ok: false; result: SendResult } {
  const base = { recipient: { id: message.recipient }, messaging_type: "RESPONSE" };
  if (message.contentKind === "text") {
    if (message.text === null || message.text.length === 0) {
      return { ok: false, result: { status: "failed", errorCode: "empty_text", retryable: false, message: "No text to send." } };
    }
    if (message.text.length > MESSENGER_MAX_TEXT) {
      return { ok: false, result: { status: "failed", errorCode: "text_too_long", retryable: false, message: "Text exceeds the Messenger limit." } };
    }
    return { ok: true, body: { ...base, message: { text: message.text } } };
  }
  if (message.contentKind === "image" || message.contentKind === "audio" || message.contentKind === "video" || message.contentKind === "file") {
    if (!message.attachmentUrl) {
      return { ok: false, result: { status: "failed", errorCode: "missing_attachment", retryable: false, message: "No attachment URL." } };
    }
    return {
      ok: true,
      body: {
        ...base,
        message: { attachment: { type: message.contentKind, payload: { url: message.attachmentUrl, is_reusable: false } } },
      },
    };
  }
  return { ok: false, result: { status: "failed", errorCode: "unsupported_content", retryable: false, message: "Messenger send does not support this content." } };
}

export async function sendMessengerMessage(
  message: OutboundMessage,
  credentials: ChannelCredentials,
  http: HttpClient,
): Promise<SendResult> {
  const token = credentials[MESSENGER_CREDENTIAL_KEYS.pageAccessToken];
  if (!token) {
    return { status: "failed", errorCode: "credentials_missing", retryable: false, message: "No page access token on this account." };
  }
  const built = buildMessengerBody(message);
  if (!built.ok) return built.result;

  let response: HttpResponse;
  try {
    response = await http({
      method: "POST",
      url: MESSENGER_GRAPH_URL,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(built.body),
      timeoutMs: MESSENGER_TIMEOUT_MS,
    });
  } catch (error) {
    const timedOut = typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "timeout";
    return {
      status: "failed",
      errorCode: timedOut ? "timeout" : "network",
      retryable: true,
      message: "Messenger request failed or timed out.",
    };
  }
  return mapMessengerResponse(response, credentials);
}
