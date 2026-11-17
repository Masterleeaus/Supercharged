/*
 * Channel side of the reply path. Two pieces:
 * - createChannelReceiptHandler: the onReceipt the webhook routers call once a webhook has passed its signature check.
 *   Each inbound text message goes through the customer turn, which stores it and makes the reply.
 * - buildChannelSend: the ReplyWriter's buildSend. A channel reply becomes a channel outbox row, written in the same
 *   transaction as the stored reply, so the reply and its send cannot be split by a crash.
 *
 * Thread encoding: a channel conversation's externalThreadId is "<accountId>|<thread id>". The account id is the
 * channel's own account id and never contains "|". The send recipient is the part after the first "|". Storing the
 * account in the thread avoids a schema change, and two accounts can share a thread id without sharing a conversation.
 *
 * Rules:
 * - Text only. Media, interactive and unknown inbound messages are stored by no one here: they are counted and skipped.
 * - The chatbot is chosen by chatbotIdFor. No chatbot means no reply and a log line, never a guess.
 * - Logs carry ids, codes and counts only. Message text and provider payloads are never logged.
 */
import type { AcceptedWebhook } from "../channels/inbound-router.ts";
import type { OutboundMessage } from "../contracts/channels.ts";
import type { ConversationRecord } from "../contracts/runtime.ts";
import { logger } from "../../../utils/logger.ts";
import type { CustomerTurns } from "./customer-turn.ts";

export const THREAD_SEPARATOR = "|";

export interface ChannelReceiptDeps {
  turns: CustomerTurns;
  /** Chatbot for this company and channel account. Null when none can be chosen. */
  chatbotIdFor(companyId: string, channel: AcceptedWebhook["channel"], accountId: string): Promise<string | null>;
}

export function channelThreadOf(accountId: string, externalThreadId: string): string {
  return `${accountId}${THREAD_SEPARATOR}${externalThreadId}`;
}

export function createChannelReceiptHandler(deps: ChannelReceiptDeps) {
  return async (companyId: string, receipt: AcceptedWebhook): Promise<void> => {
    const { channel, accountId } = receipt;
    if (accountId.includes(THREAD_SEPARATOR)) {
      logger.warn("chatbot.channels.account_id_refused", { channel });
      return;
    }
    let chatbotId: string | null | undefined;

    for (const event of receipt.events) {
      if (event.kind !== "message") continue;
      const message = event.message;
      if (message.contentKind !== "text" || message.text === null || message.text.trim() === "") {
        logger.info("chatbot.channels.non_text_skipped", { channel, contentKind: message.contentKind });
        continue;
      }
      if (message.externalThreadId.length === 0 || message.externalMessageId.length === 0) {
        logger.warn("chatbot.channels.identity_missing", { channel });
        continue;
      }
      if (chatbotId === undefined) chatbotId = await deps.chatbotIdFor(companyId, channel, accountId);
      if (chatbotId === null) {
        logger.warn("chatbot.channels.no_chatbot", { channel });
        return;
      }

      const result = await deps.turns.run(companyId, {
        chatbotId,
        channel,
        externalThreadId: channelThreadOf(accountId, message.externalThreadId),
        text: message.text,
        messageKey: `${channel}${THREAD_SEPARATOR}${accountId}${THREAD_SEPARATOR}${message.externalMessageId}`,
        surface: channel,
      });
      logger.info("chatbot.channels.turn_done", {
        channel,
        outcome: result.reply === null ? "conversation_not_open" : result.reply.status,
      });
    }
  };
}

/**
 * ReplyWriter buildSend. Web conversations have no provider to send to, so they get null. A channel conversation whose
 * thread cannot be split is refused by throwing: the reply is not stored, so nothing is left unsent.
 */
export function buildChannelSend(conversation: ConversationRecord, text: string): OutboundMessage | null {
  if (conversation.channel === "web") return null;
  const thread = conversation.externalThreadId ?? "";
  const at = thread.indexOf(THREAD_SEPARATOR);
  if (at <= 0 || at === thread.length - 1) throw new Error("channel thread is malformed");
  return {
    channel: conversation.channel,
    accountId: thread.slice(0, at),
    recipient: thread.slice(at + 1),
    contentKind: "text",
    text,
    attachmentUrl: null,
    templateName: null,
    templateParams: null,
    replyToExternalMessageId: null,
    idempotencyKey: "",
  };
}
