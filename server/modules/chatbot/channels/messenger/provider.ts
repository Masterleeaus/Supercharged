/**
 * Messenger ChannelProvider. Implements the contract in contracts/channels.ts.
 * The provider touches no storage. The send ledger is injected so the idempotency rule holds.
 *
 * The GET subscription challenge is served through the framework's answerChallenge hook, which calls
 * answerChallenge below (see channels/DECISIONS.md, Messenger section).
 */
import type {
  ChannelCapabilities,
  ChannelCredentials,
  HttpClient,
  InboundParseResult,
  OutboundMessage,
  RawWebhook,
  SendResult,
  WebhookVerification,
} from "../../contracts/index.ts";
import type { ChallengeCapableProvider, ChallengeResponse } from "../framework.ts";
import { messengerPageId, parseMessengerEvents } from "./parse.ts";
import { MESSENGER_MAX_TEXT, sendMessengerMessage } from "./send.ts";
import { answerMessengerChallenge, verifyMessengerSignature } from "./verify.ts";

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

/**
 * Messenger's standard messaging window is 24 hours after the user's last message. The provider cannot see that
 * time, so the runtime must check it before send. This value is informational.
 */
export const MESSENGER_CAPABILITIES: ChannelCapabilities = {
  templates: false,
  attachments: true,
  deliveryReceipts: true,
  readReceipts: false,
  typingIndicator: false,
  interactiveButtons: false,
  maxTextLength: MESSENGER_MAX_TEXT,
  sessionWindowHours: 24,
};

export interface MessengerProviderDeps {
  ledger: SendLedger;
}

export function createMessengerProvider(deps: MessengerProviderDeps): ChallengeCapableProvider {
  return {
    kind: "messenger",

    capabilities(): ChannelCapabilities {
      return MESSENGER_CAPABILITIES;
    },

    answerChallenge(
      query: Readonly<Record<string, string | undefined>>,
      credentials: ChannelCredentials,
    ): ChallengeResponse | null {
      return answerMessengerChallenge(query, credentials);
    },

    resolveAccount(raw: RawWebhook): string | null {
      return messengerPageId(raw.rawBody);
    },

    async verifyWebhook(
      _companyId: string,
      _accountId: string,
      raw: RawWebhook,
      credentials: ChannelCredentials,
    ): Promise<WebhookVerification> {
      return verifyMessengerSignature(raw, credentials);
    },

    parseInbound(raw: RawWebhook, accountId: string): InboundParseResult[] {
      return parseMessengerEvents(raw, accountId);
    },

    async send(
      companyId: string,
      message: OutboundMessage,
      credentials: ChannelCredentials,
      http: HttpClient,
    ): Promise<SendResult> {
      const claim = await deps.ledger.claim(companyId, message.accountId, message.idempotencyKey);
      if (claim.kind === "duplicate") {
        return claim.done && claim.externalMessageId
          ? { status: "sent", externalMessageId: claim.externalMessageId }
          : { status: "queued", externalMessageId: null };
      }
      const result = await sendMessengerMessage(message, credentials, http);
      if (result.status === "sent") {
        await deps.ledger.complete(companyId, message.accountId, message.idempotencyKey, result.externalMessageId);
      } else {
        await deps.ledger.release(companyId, message.accountId, message.idempotencyKey);
      }
      return result;
    },
  };
}
