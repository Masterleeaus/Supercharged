/*
 * Reply writer for the conversation store. Stores one assistant reply and, for a channel conversation, the channel
 * send row, in one unit of work (ConversationStore.insertReply). A crash cannot leave a stored reply with no send.
 *
 * Rules:
 * - Tenancy: the conversation is read by companyId. A conversation of another company is treated as absent.
 * - Send key: the outbox idempotency key is "reply:<message id>". The send is derived from the message id, so a
 *   retry of the same reply cannot send twice.
 * - Lock: calls for one conversation run one at a time through `lock`. The default is an in-process keyed lock
 *   (memory deployment). A database deployment passes passThroughLock, because the row locks in the transaction
 *   carry the guarantee across processes.
 * - Composition: this writer stores the text it is given. The generative-UI composer stays in ChatbotService.
 */
import { randomUUID } from "node:crypto";
import { createKeyedLock, type KeyedLock } from "../cart/keyed-lock.ts";
import type { ChannelOutbox } from "../channels/outbox.ts";
import type { OutboundMessage } from "../contracts/channels.ts";
import type { ConversationRecord } from "../contracts/runtime.ts";
import type { ConversationStore } from "./conversation-store.ts";
import type { ReplyWriter } from "./types.ts";

export type ReplyWriteErrorCode = "conversation_not_found" | "outbox_missing";

export class ReplyWriteError extends Error {
  readonly code: ReplyWriteErrorCode;

  constructor(code: ReplyWriteErrorCode) {
    super(code);
    this.name = "ReplyWriteError";
    this.code = code;
  }
}

export interface ConversationReplyWriterDeps {
  store: ConversationStore;
  /** Required when buildSend returns a message. The send row is written through it, in the reply transaction. */
  channelOutbox?: ChannelOutbox;
  /**
   * Returns the channel send for this reply, or null for no send (web chat). The writer overwrites the idempotency
   * key with "reply:<message id>".
   */
  buildSend?: (conversation: ConversationRecord, text: string, messageId: string) => OutboundMessage | null;
  /** Serialises calls per conversation. Defaults to an in-process keyed lock. Pass passThroughLock in a database deployment. */
  lock?: KeyedLock;
  now?: () => Date;
  newId?: () => string;
}

export function createConversationReplyWriter(deps: ConversationReplyWriterDeps): ReplyWriter {
  const { store } = deps;
  const lock = deps.lock ?? createKeyedLock();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  return {
    async recordAssistantReply(companyId, conversationId, text, _surface) {
      return lock(`${companyId}:${conversationId}`, async () => {
        const conversation = await store.findConversation(companyId, conversationId);
        if (!conversation) throw new ReplyWriteError("conversation_not_found");

        const messageId = newId();
        const built = deps.buildSend?.(conversation, text, messageId) ?? null;
        if (built && !deps.channelOutbox) throw new ReplyWriteError("outbox_missing");

        const send: OutboundMessage | null = built ? { ...built, idempotencyKey: `reply:${messageId}` } : null;
        const enqueueSend = send && deps.channelOutbox
          ? (tx: unknown) => deps.channelOutbox!.enqueue(tx, companyId, send)
          : null;

        const stored = await store.insertReply(
          companyId,
          conversationId,
          { id: messageId, role: "assistant", text, isInternalNote: false, createdAt: now() },
          enqueueSend,
        );
        if (!stored) throw new ReplyWriteError("conversation_not_found");
        return { message: { id: stored.id }, accepted: true };
      });
    },
  };
}
