/**
 * WhatsApp channel provider (Twilio). Implements the ChannelProvider contract. Storage is not touched here: the
 * runtime stores parse results and send outcomes.
 *
 * Credential keys keep the PHP names (whatsapp_sid, whatsapp_token, whatsapp_phone, whatsapp_sandbox_phone,
 * whatsapp_environment) and add webhook_url, the exact public URL Twilio calls. Twilio signs that URL, and the
 * webhook request does not carry it, so it is stored with the account.
 */
import type {
  ChannelCapabilities,
  ChannelCredentials,
  ChannelProvider,
  HttpClient,
  InboundParseResult,
  OutboundMessage,
  RawWebhook,
  SendResult,
  WebhookVerification,
} from "../../contracts/index.ts";
import { readFlag, type FlagEnv, type ReadFlag } from "../../contracts/index.ts";
import { constantTimeEqual, formFields, parseFormEntries } from "../framework.ts";
import { parseTwilioInbound } from "./inbound.ts";
import { sendTwilioWhatsapp } from "./outbound.ts";
import {
  computeTwilioSignature,
  httpsWebhookUrl,
  normaliseWhatsappAddress,
  TWILIO_SIGNATURE_HEADER,
} from "./twilio.ts";

/**
 * The account is our WhatsApp number. On an inbound message that number is To. On a delivery status callback for
 * an outbound message, Twilio sends the customer as To and our number as From, so From is read instead.
 */
function resolveWhatsappAccount(raw: RawWebhook): string | null {
  const fields = formFields(parseFormEntries(raw.rawBody));
  const isStatusCallback = fields.has("MessageStatus") && fields.get("MessageStatus") !== "received";
  return normaliseWhatsappAddress(fields.get(isStatusCallback ? "From" : "To"));
}

/**
 * Flag that turns the WhatsApp channel on. It is not in CONTRACT_FLAGS yet (see channels/DECISIONS.md, change
 * requests). Read through readFlag, so only the exact value "true" turns it on.
 */
export const WHATSAPP_CHANNEL_FLAG = "CHATBOT_WHATSAPP_CHANNEL_ENABLED";

export function isWhatsappChannelEnabled(env: FlagEnv, reader: ReadFlag = readFlag): boolean {
  return reader(WHATSAPP_CHANNEL_FLAG, env);
}

/** Twilio's documented Body limit for a WhatsApp message. */
const WHATSAPP_MAX_TEXT_LENGTH = 1600;
/** Free-form replies are allowed for 24 hours after the customer's last inbound message. */
const WHATSAPP_SESSION_WINDOW_HOURS = 24;

const CAPABILITIES: ChannelCapabilities = {
  templates: true,
  attachments: true,
  deliveryReceipts: true,
  readReceipts: true,
  typingIndicator: false,
  interactiveButtons: false,
  maxTextLength: WHATSAPP_MAX_TEXT_LENGTH,
  sessionWindowHours: WHATSAPP_SESSION_WINDOW_HOURS,
};

export interface WhatsappProviderOptions {
  /** Bound on the idempotency cache. Defaults to the module limit. */
  maxCachedSends?: number;
}

export function createWhatsappProvider(_options: WhatsappProviderOptions = {}): ChannelProvider {
  // Per-instance cache of successful sends. The runtime outbox is the durable dedupe; this only stops a
  // duplicate call within one process.
  const sentCache = new Map<string, SendResult>();

  return {
    kind: "whatsapp",

    capabilities(): ChannelCapabilities {
      return { ...CAPABILITIES };
    },

    resolveAccount(raw: RawWebhook): string | null {
      return resolveWhatsappAccount(raw);
    },

    async verifyWebhook(
      _companyId: string,
      accountId: string,
      raw: RawWebhook,
      credentials: ChannelCredentials,
    ): Promise<WebhookVerification> {
      const authToken = credentials.whatsapp_token;
      const url = httpsWebhookUrl(credentials.webhook_url);
      // A missing secret or URL cannot be verified, so the request is refused.
      if (typeof authToken !== "string" || authToken.length === 0 || !url) {
        return { ok: false, reason: "credentials_missing" };
      }
      if (typeof raw.rawBody !== "string") {
        return { ok: false, reason: "signature_invalid" };
      }
      const header = raw.headers[TWILIO_SIGNATURE_HEADER];
      if (typeof header !== "string" || header.length === 0) {
        return { ok: false, reason: "signature_missing" };
      }
      if (resolveWhatsappAccount(raw) !== accountId) {
        return { ok: false, reason: "account_unknown" };
      }

      const expected = computeTwilioSignature(authToken, url, parseFormEntries(raw.rawBody));
      return constantTimeEqual(expected, header) ? { ok: true } : { ok: false, reason: "signature_invalid" };
    },

    parseInbound(raw: RawWebhook, accountId: string): InboundParseResult[] {
      return parseTwilioInbound(raw, accountId);
    },

    send(companyId: string, message: OutboundMessage, credentials: ChannelCredentials, http: HttpClient): Promise<SendResult> {
      return sendTwilioWhatsapp(companyId, message, credentials, http, { sentCache });
    },
  };
}
