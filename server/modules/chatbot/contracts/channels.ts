/**
 * Channel port. One ChannelProvider per channel kind. Providers parse inbound webhooks, verify their signatures,
 * and send outbound messages. They do not write to storage: the runtime layer does that with the parsed result.
 *
 * Webhook order is fixed: (1) resolveAccount on the raw request, which is a pure read of the payload;
 * (2) load that account's credentials for the company; (3) verifyWebhook; (4) parseInbound. Parsing before
 * verification is a contract violation.
 *
 * Companies: methods that touch tenant data take companyId first. Pure functions (kind, capabilities,
 * resolveAccount, parseInbound) do not touch storage and take no companyId.
 */
import type { HttpClient } from "./http.ts";

export const CHANNEL_KINDS = ["whatsapp", "telegram", "messenger", "instagram", "voice", "web"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * A raw inbound request. The body must be the exact bytes received, because signatures are computed over them.
 * Header names are lower-cased by the route layer before they reach a provider.
 */
export interface RawWebhook {
  headers: Readonly<Record<string, string>>;
  rawBody: string;
  receivedAt: Date;
  /**
   * Full public URL the channel called, including the query string. Signatures that cover the URL (Twilio) need it.
   * Optional so existing callers compile. Added by change request 2 (channels slice).
   */
  url?: string;
}

/**
 * Subscription challenge for a GET request (for example Meta's hub.mode, hub.verify_token, hub.challenge).
 * Query keys keep their dots. Added by the Messenger change request (framework hook).
 */
export type ChannelVerificationQuery = Readonly<Record<string, string>>;

/** Discriminated result of verification. Anything other than ok: true must reject the request. */
export type WebhookVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "signature_missing"
        | "signature_invalid"
        | "timestamp_stale"
        | "account_unknown"
        | "credentials_missing";
    };

/** Credentials for one channel account, already decrypted. Held in memory for one call only. Never logged. */
export type ChannelCredentials = Readonly<Record<string, string>>;

/** Loads and decrypts the credentials for one channel account, scoped to a company. */
export interface ChannelCredentialSource {
  load(companyId: string, kind: ChannelKind, accountId: string): Promise<ChannelCredentials | null>;
}

export interface InboundSender {
  /** The channel's own id for the sender: a phone number, chat id, page-scoped id, and so on. */
  externalId: string;
  displayName: string | null;
}

export type InboundContentKind = "text" | "image" | "audio" | "video" | "file" | "location" | "interactive" | "unknown";

export interface InboundAttachment {
  kind: Exclude<InboundContentKind, "text" | "interactive" | "unknown">;
  /** The channel's media id or URL. Fetched later through the channel's HttpClient, never inline here. */
  externalRef: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface InboundMessage {
  channel: ChannelKind;
  accountId: string;
  externalThreadId: string;
  externalMessageId: string;
  sender: InboundSender;
  contentKind: InboundContentKind;
  text: string | null;
  attachments: InboundAttachment[];
  sentAt: Date;
  /**
   * Label of the button a customer tapped, for interactive replies. Null or absent otherwise. Added by change
   * request 3 (channels slice), so the text of an interactive reply is not lost.
   */
  buttonText?: string | null;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface DeliveryStatusUpdate {
  channel: ChannelKind;
  accountId: string;
  externalMessageId: string;
  status: DeliveryStatus;
  /** Channel error text for failed status. Non-secret. */
  reason: string | null;
  occurredAt: Date;
}

/** One webhook can carry several events. The parser returns one result per event, in order. */
export type InboundParseResult =
  | { kind: "message"; message: InboundMessage }
  | { kind: "status"; update: DeliveryStatusUpdate }
  | { kind: "ignored"; reason: string };

export interface OutboundMessage {
  channel: ChannelKind;
  accountId: string;
  recipient: string;
  contentKind: "text" | "image" | "audio" | "video" | "file" | "template";
  text: string | null;
  attachmentUrl: string | null;
  /** Required on WhatsApp outside the 24 hour session window, and on other channels when the provider needs it. */
  templateName: string | null;
  templateParams: Record<string, string> | null;
  replyToExternalMessageId: string | null;
  /** Same key sent twice must not send twice. The runtime derives it from the message id. */
  idempotencyKey: string;
}

export type SendResult =
  | { status: "sent"; externalMessageId: string }
  | { status: "queued"; externalMessageId: null }
  | { status: "failed"; errorCode: string; retryable: boolean; message: string };

export interface ChannelCapabilities {
  templates: boolean;
  attachments: boolean;
  deliveryReceipts: boolean;
  readReceipts: boolean;
  typingIndicator: boolean;
  interactiveButtons: boolean;
  /** Null means no published limit. */
  maxTextLength: number | null;
  /** Hours a free-form reply is allowed after the customer's last message. Null means no window. */
  sessionWindowHours: number | null;
}

export interface ChannelProvider {
  readonly kind: ChannelKind;
  capabilities(): ChannelCapabilities;

  /** Pure read of the payload that names the channel account. Returns null when the payload has no account. */
  resolveAccount(raw: RawWebhook): string | null;

  /**
   * Checks the request signature against the account's secret. Must fail closed: an absent secret, a missing
   * header, or a bad comparison all return ok: false. Comparisons must be constant time.
   * Note: the legacy voice provider returns true unconditionally. That is not allowed in this contract.
   */
  verifyWebhook(
    companyId: string,
    accountId: string,
    raw: RawWebhook,
    credentials: ChannelCredentials,
  ): Promise<WebhookVerification>;

  /** Parses a verified payload. Pure: no network, no storage. */
  parseInbound(raw: RawWebhook, accountId: string): InboundParseResult[];

  /**
   * Optional. Answers a GET subscription challenge (Messenger, Instagram). Returns the text to echo back, or null
   * to refuse (the route answers 403). It must compare the verify token in constant time, and a missing expected
   * token must refuse. Pure: no network, no storage. Lets the framework route GET requests through the provider.
   * Added by the Messenger change request (framework hook).
   */
  answerVerification?(query: ChannelVerificationQuery, credentials: ChannelCredentials): string | null;

  send(
    companyId: string,
    message: OutboundMessage,
    credentials: ChannelCredentials,
    http: HttpClient,
  ): Promise<SendResult>;
}
