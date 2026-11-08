/**
 * ChannelProvider for Instagram. Pure parts (kind, capabilities, resolveAccount, parseInbound) take no companyId.
 * Webhook order is set by the framework: resolveAccount, load credentials, verifyWebhook, parseInbound.
 * This provider never writes to storage; the runtime does that with the parsed result.
 */
import type {
  ChannelCapabilities,
  OutboundMessage,
  RawWebhook,
  SendResult,
  WebhookVerification,
} from "../../contracts/index.ts";
import { requireCompanyId } from "../../chatbot-scope.ts";
import type { ChallengeCapableProvider, ChallengeResponse } from "../framework.ts";
import { INSTAGRAM_CHANNEL_KIND, INSTAGRAM_SESSION_WINDOW_HOURS, INSTAGRAM_TEXT_MAX_LENGTH } from "./config.ts";
import { accountIdOf, parseInstagramPayload } from "./parse.ts";
import { sendInstagramMessage } from "./send.ts";
import { answerSubscriptionChallenge, verifySignedPost } from "./webhook.ts";

export const INSTAGRAM_CAPABILITIES: ChannelCapabilities = {
  templates: false,
  attachments: false,
  deliveryReceipts: true,
  readReceipts: true,
  typingIndicator: false,
  interactiveButtons: false,
  maxTextLength: INSTAGRAM_TEXT_MAX_LENGTH,
  sessionWindowHours: INSTAGRAM_SESSION_WINDOW_HOURS,
};

export function createInstagramProvider(): ChallengeCapableProvider {
  return {
    kind: INSTAGRAM_CHANNEL_KIND,

    capabilities(): ChannelCapabilities {
      return { ...INSTAGRAM_CAPABILITIES };
    },

    answerChallenge(
      query: Readonly<Record<string, string | undefined>>,
      credentials: Readonly<Record<string, string>>,
    ): ChallengeResponse | null {
      const answer = answerSubscriptionChallenge(query, credentials.verify_token);
      return answer.ok ? { status: 200, contentType: "text/plain; charset=utf-8", body: answer.body } : null;
    },

    resolveAccount(raw: RawWebhook): string | null {
      return accountIdOf(raw.rawBody);
    },

    async verifyWebhook(
      companyId: string,
      accountId: string,
      raw: RawWebhook,
      credentials: Readonly<Record<string, string>>,
    ): Promise<WebhookVerification> {
      requireCompanyId(companyId);
      if (!credentials.instagram_id || credentials.instagram_id !== accountId) {
        return { ok: false, reason: "account_unknown" };
      }
      if (accountIdOf(raw.rawBody) !== accountId) {
        return { ok: false, reason: "account_unknown" };
      }
      return verifySignedPost(raw, credentials.app_secret);
    },

    parseInbound(raw: RawWebhook, accountId: string) {
      return parseInstagramPayload(raw, accountId);
    },

    async send(companyId, message: OutboundMessage, credentials, http): Promise<SendResult> {
      return sendInstagramMessage(companyId, message, credentials, http);
    },
  };
}
