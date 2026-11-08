/**
 * Outbound Instagram text. Goes through the injected HttpClient with a timeout and a Bearer header.
 * Text only: media, templates and buttons are refused as unsupported, not sent as a fallback.
 * Failures map to SendResult with a retryable flag. Error bodies from Meta are not copied into the message.
 */
import type { ChannelCredentials, HttpClient, OutboundMessage, SendResult } from "../../contracts/index.ts";
import { requireCompanyId } from "../../chatbot-scope.ts";
import { INSTAGRAM_API_VERSION, INSTAGRAM_CHANNEL_KIND, INSTAGRAM_GRAPH_HOST, INSTAGRAM_TEXT_MAX_LENGTH } from "./config.ts";
import { graphRequest } from "./http.ts";

function failed(errorCode: string, retryable: boolean, message: string): SendResult {
  return { status: "failed", errorCode, retryable, message };
}

export async function sendInstagramMessage(
  companyId: string,
  message: OutboundMessage,
  credentials: ChannelCredentials,
  http: HttpClient,
): Promise<SendResult> {
  requireCompanyId(companyId);

  if (message.channel !== INSTAGRAM_CHANNEL_KIND) {
    return failed("wrong_channel", false, "Message is not for the Instagram channel.");
  }
  const igId = credentials.instagram_id;
  const token = credentials.access_token;
  if (!igId || !token) {
    return failed("credentials_missing", false, "Instagram account credentials are missing.");
  }
  if (message.accountId !== igId) {
    return failed("account_mismatch", false, "Message account does not match the credentials.");
  }
  if (message.contentKind !== "text") {
    return failed("unsupported_content", false, "Instagram sending supports text only in this build.");
  }
  const text = message.text ?? "";
  if (text.trim().length === 0) {
    return failed("empty_text", false, "Message text is empty.");
  }
  if (text.length > INSTAGRAM_TEXT_MAX_LENGTH) {
    return failed("text_too_long", false, `Instagram text is limited to ${INSTAGRAM_TEXT_MAX_LENGTH} characters.`);
  }
  if (!message.recipient) {
    return failed("recipient_missing", false, "Recipient is missing.");
  }

  const result = await graphRequest(http, {
    method: "POST",
    url: instagramMessagesUrl(igId),
    bearer: token,
    json: {
      messaging_product: "instagram",
      messaging_type: "RESPONSE",
      recipient: { id: message.recipient },
      message: { text },
    },
  });

  if (!result.ok) {
    if (result.code === "timeout" || result.code === "network") {
      return failed(result.code, true, "Instagram could not be reached.");
    }
    if (result.code === "bad_json") {
      return failed("unexpected_response", false, "Instagram returned an unreadable response.");
    }
    const retryable = result.status === 429 || result.status >= 500;
    return failed(`http_${result.status}`, retryable, `Instagram rejected the message (HTTP ${result.status}).`);
  }

  const id = typeof result.json.message_id === "string" ? result.json.message_id : null;
  if (!id) {
    return failed("unexpected_response", false, "Instagram accepted the request without a message id.");
  }
  return { status: "sent", externalMessageId: id };
}

/** Exported for tests that check the URL shape without a network call. */
export function instagramMessagesUrl(igId: string): string {
  return `${INSTAGRAM_GRAPH_HOST}/${INSTAGRAM_API_VERSION}/${encodeURIComponent(igId)}/messages`;
}

