/**
 * Telegram ChannelProvider. Implements the contract in contracts/channels.ts.
 * The provider touches no storage directly. The send ledger is injected so the idempotency rule holds.
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
import { parseTelegramUpdate } from "./parse.ts";
import { sendTelegramText, TELEGRAM_MAX_TEXT } from "./send.ts";
import { verifyTelegramSecretToken } from "./verify.ts";

/** Outcome of claiming an outbound idempotency key. */
export type LedgerClaim =
  | { kind: "claimed" }
  | { kind: "duplicate"; done: boolean; externalMessageId: string | null };

/** Outbound idempotency ledger. Backed by chatbot_channel_send_keys in production. */
export interface SendLedger {
  claim(companyId: string, accountId: string, key: string): Promise<LedgerClaim>;
  complete(companyId: string, accountId: string, key: string, externalMessageId: string | null): Promise<void>;
  release(companyId: string, accountId: string, key: string): Promise<void>;
}

export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  templates: false,
  attachments: false,
  deliveryReceipts: false,
  readReceipts: false,
  typingIndicator: false,
  interactiveButtons: false,
  maxTextLength: TELEGRAM_MAX_TEXT,
  sessionWindowHours: null,
};

/** Header the route layer fills from the account path segment. Verification still uses that account's own secret. */
export const TELEGRAM_ACCOUNT_HEADER = "x-chatbot-account-id";

export interface TelegramProviderDeps {
  ledger: SendLedger;
}

export function createTelegramProvider(deps: TelegramProviderDeps): ChannelProvider {
  return {
    kind: "telegram",

    capabilities(): ChannelCapabilities {
      return TELEGRAM_CAPABILITIES;
    },

    resolveAccount(raw: RawWebhook): string | null {
      const value = raw.headers[TELEGRAM_ACCOUNT_HEADER];
      return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
    },

    async verifyWebhook(
      _companyId: string,
      _accountId: string,
      raw: RawWebhook,
      credentials: ChannelCredentials,
    ): Promise<WebhookVerification> {
      return verifyTelegramSecretToken(raw, credentials);
    },

    parseInbound(raw: RawWebhook, accountId: string): InboundParseResult[] {
      return parseTelegramUpdate(raw, accountId);
    },

    async send(
      companyId: string,
      message: OutboundMessage,
      credentials: ChannelCredentials,
      http: HttpClient,
    ): Promise<SendResult> {
      if (message.contentKind !== "text" || message.text === null) {
        return { status: "failed", errorCode: "unsupported_content", retryable: false, message: "Telegram send supports text only." };
      }
      if (message.text.length > TELEGRAM_MAX_TEXT) {
        return { status: "failed", errorCode: "text_too_long", retryable: false, message: "Text exceeds the Telegram limit." };
      }
      const claim = await deps.ledger.claim(companyId, message.accountId, message.idempotencyKey);
      if (claim.kind === "duplicate") {
        return claim.done && claim.externalMessageId
          ? { status: "sent", externalMessageId: claim.externalMessageId }
          : { status: "queued", externalMessageId: null };
      }
      const result = await sendTelegramText(
        { recipient: message.recipient, text: message.text, replyTo: message.replyToExternalMessageId },
        credentials,
        http,
      );
      if (result.status === "sent") {
        await deps.ledger.complete(companyId, message.accountId, message.idempotencyKey, result.externalMessageId);
      } else {
        await deps.ledger.release(companyId, message.accountId, message.idempotencyKey);
      }
      return result;
    },
  };
}

