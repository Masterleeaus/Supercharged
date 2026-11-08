/**
 * Outbound WhatsApp send through Twilio's Messages API. Every network call goes through the injected HttpClient
 * with a timeout. Credentials are used for the Basic auth header and the sender number, then dropped. No response
 * or error returned from here contains a credential value.
 */
import type {
  ChannelCredentials,
  HttpClient,
  HttpRequest,
  HttpResponse,
  OutboundMessage,
  SendResult,
} from "../../contracts/index.ts";
import { CHANNEL_HTTP_TIMEOUT_MS, redactSecrets, truncateProviderText } from "../framework.ts";
import {
  httpsWebhookUrl,
  isTwilioAccountSid,
  isTwilioContentSid,
  normaliseWhatsappAddress,
} from "./twilio.ts";

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Twilio error 63016: the 24-hour customer service window has closed and no approved template was sent. */
const TWILIO_OUTSIDE_WINDOW = "63016";

/** Idempotency cache bound. Oldest entries are evicted first. */
const MAX_IDEMPOTENCY_ENTRIES = 5000;

function failed(errorCode: string, message: string, retryable: boolean): SendResult {
  return { status: "failed", errorCode, retryable, message };
}

/** Picks the sender number. Sandbox channels send from the sandbox number, as the PHP code did. */
function senderFor(credentials: ChannelCredentials): string | null {
  const raw =
    credentials.whatsapp_environment === "sandbox" ? credentials.whatsapp_sandbox_phone : credentials.whatsapp_phone;
  return normaliseWhatsappAddress(raw);
}

function encodeBasic(accountSid: string, authToken: string): string {
  return Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
}

/** Builds the Twilio form body. Template sends use ContentSid, text and media use Body and MediaUrl. */
function buildForm(
  message: OutboundMessage,
  from: string,
  to: string,
  statusCallback: string | null,
): { form: URLSearchParams } | { error: SendResult } {
  const form = new URLSearchParams();
  form.set("To", `whatsapp:${to}`);
  form.set("From", `whatsapp:${from}`);
  if (statusCallback) form.set("StatusCallback", statusCallback);

  if (message.contentKind === "template") {
    if (!isTwilioContentSid(message.templateName)) {
      return { error: failed("template_not_registered", "Template is not registered with the channel", false) };
    }
    form.set("ContentSid", message.templateName);
    form.set("ContentVariables", JSON.stringify(message.templateParams ?? {}));
    return { form };
  }

  const hasText = typeof message.text === "string" && message.text.length > 0;
  const hasMedia = message.contentKind !== "text";

  if (message.contentKind === "text" && !hasText) {
    return { error: failed("empty_message", "Text message has no text", false) };
  }
  if (hasMedia) {
    const url = httpsWebhookUrl(message.attachmentUrl);
    if (!url) {
      return { error: failed("attachment_url_invalid", "Attachment must be an https URL", false) };
    }
    form.set("MediaUrl", url);
  }
  if (hasText) {
    form.set("Body", message.text as string);
  }
  return { form };
}

export interface WhatsappSendOptions {
  /** Cache of successful sends, keyed by company, sender and idempotency key. Owned by the provider instance. */
  sentCache: Map<string, SendResult>;
}

export async function sendTwilioWhatsapp(
  companyId: string,
  message: OutboundMessage,
  credentials: ChannelCredentials,
  http: HttpClient,
  options: WhatsappSendOptions,
): Promise<SendResult> {
  if (message.channel !== "whatsapp") {
    return failed("channel_mismatch", "Message channel is not WhatsApp", false);
  }

  const accountSid = credentials.whatsapp_sid;
  const authToken = credentials.whatsapp_token;
  if (!isTwilioAccountSid(accountSid) || typeof authToken !== "string" || authToken.length === 0) {
    return failed("credentials_missing", "WhatsApp credentials are incomplete", false);
  }

  const from = senderFor(credentials);
  if (!from) {
    return failed("credentials_invalid", "WhatsApp sender number is not valid", false);
  }

  const to = normaliseWhatsappAddress(message.recipient);
  if (!to) {
    return failed("recipient_invalid", "Recipient is not a valid WhatsApp number", false);
  }

  const cacheKey = `${companyId}\u0000${accountSid}\u0000${message.idempotencyKey}`;
  const cached = options.sentCache.get(cacheKey);
  if (cached) return cached;

  const built = buildForm(message, from, to, httpsWebhookUrl(credentials.webhook_url));
  if ("error" in built) return built.error;

  const request: HttpRequest = {
    method: "POST",
    url: `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`,
    headers: {
      Authorization: `Basic ${encodeBasic(accountSid, authToken)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: built.form.toString(),
    timeoutMs: CHANNEL_HTTP_TIMEOUT_MS,
  };

  let response: HttpResponse;
  try {
    response = await http(request);
  } catch (error) {
    // Only the contract's HttpTransportError shapes are mapped. Anything else is rethrown, and the framework
    // reports it as a non-retryable provider_exception.
    const kind = typeof error === "object" && error !== null ? (error as { kind?: unknown }).kind : undefined;
    // A timeout is ambiguous: Twilio may already have accepted the message, so it is not retryable.
    if (kind === "timeout") {
      return failed("transport_timeout", "The channel provider did not answer in time", false);
    }
    // A network failure is safe to retry only when the connection never opened. The contract does not say which,
    // so the port reports it as retryable. The runtime must dedupe on the idempotency key before it retries.
    if (kind === "network") {
      return failed("transport_network", "Could not reach the channel provider", true);
    }
    throw error;
  }

  const secrets = [authToken, accountSid];
  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  if (response.status >= 200 && response.status < 300 && typeof record.sid === "string" && record.sid.length > 0) {
    const result: SendResult = { status: "sent", externalMessageId: record.sid };
    options.sentCache.set(cacheKey, result);
    if (options.sentCache.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = options.sentCache.keys().next().value;
      if (oldest !== undefined) options.sentCache.delete(oldest);
    }
    return result;
  }

  const twilioCode = typeof record.code === "number" || typeof record.code === "string" ? String(record.code) : null;
  const providerText = typeof record.message === "string" ? record.message : null;
  const text = truncateProviderText(
    redactSecrets(providerText ?? `The channel provider returned status ${response.status}`, secrets),
  );

  if (twilioCode === TWILIO_OUTSIDE_WINDOW) {
    return failed("session_window_closed", text, false);
  }
  const retryable = response.status === 429 || response.status >= 500;
  const errorCode = twilioCode ? `twilio_${twilioCode}` : `http_${response.status}`;
  return failed(errorCode, text, retryable);
}
