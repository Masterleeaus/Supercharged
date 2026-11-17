/*
 * One customer message in, one stored reply out. Shared by the widget and the channel receipt store.
 *
 * Steps, per call:
 * 1. Find the conversation of this chatbot on this channel thread, or create it (ConversationRuntime.create).
 * 2. Store the customer message. With a messageKey the id is derived from it, so a redelivered webhook finds the row
 *    and stores nothing twice.
 * 3. If the conversation is open, run the reply runtime for that message. The reply runtime's turn claim makes a
 *    second run for the same message answer 'duplicate', not a second reply.
 *
 * Rules:
 * - Tenancy: every call is scoped by companyId. The chatbot id must belong to the company (create checks it).
 * - Archived or merged conversations keep the customer message but get no reply. Reason: staff must still see it.
 * - Thread creation is serialised inside this process. Two processes can still race to create a thread; that gap is
 *   recorded in the runtime decisions.
 */
import { createHash, randomUUID } from "node:crypto";
import { createKeyedLock } from "../cart/keyed-lock.ts";
import type { ChannelKind } from "../contracts/channels.ts";
import type { ConversationRecord } from "../contracts/runtime.ts";
import type { ConversationRuntime } from "./conversation-runtime.ts";
import type { ConversationStore, StoredMessage } from "./conversation-store.ts";
import type { ReplyOutcome, ReplyRuntime } from "./reply-runtime.ts";

/** Hard limit for one model call. Chosen here, not by the reply runtime. */
export const REPLY_TIMEOUT_MS = 30_000;

export interface CustomerTurnInput {
  chatbotId: string;
  channel: ChannelKind;
  /** The thread on that channel. Web uses the visitor id. */
  externalThreadId: string;
  text: string;
  /** Same key, same message. Use it for anything a provider may deliver twice. Omit for a new message. */
  messageKey?: string;
  surface: string;
}

export interface CustomerTurnResult {
  conversationId: string;
  /** The stored customer message. */
  messageId: string;
  /** Null when the conversation is not open: the message is stored, no reply is made. */
  reply: ReplyOutcome | null;
}

export interface CustomerTurns {
  run(companyId: string, input: CustomerTurnInput): Promise<CustomerTurnResult>;
}

export interface CustomerTurnDeps {
  store: Pick<ConversationStore, "findConversationByThread" | "insertMessage" | "listMessages">;
  conversations: Pick<ConversationRuntime, "create">;
  replies: Pick<ReplyRuntime, "reply">;
  now?: () => Date;
  newId?: () => string;
}

/** Stable id for a message that has a key. Scoped to the company, so keys from two companies never collide. */
export function messageIdForKey(companyId: string, messageKey: string): string {
  return `in_${createHash("sha256").update(`${companyId}\u0000${messageKey}`).digest("hex").slice(0, 32)}`;
}

export function createCustomerTurns(deps: CustomerTurnDeps): CustomerTurns {
  const lock = createKeyedLock();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  const openOrCreate = async (companyId: string, input: CustomerTurnInput): Promise<ConversationRecord> => {
    const found = await deps.store.findConversationByThread(companyId, input.chatbotId, input.channel, input.externalThreadId);
    if (found) return found;
    return deps.conversations.create(companyId, {
      chatbotId: input.chatbotId,
      channel: input.channel,
      externalThreadId: input.externalThreadId,
      customerId: null,
    });
  };

  return {
    async run(companyId, input) {
      const threadKey = `${companyId}\u0000${input.chatbotId}\u0000${input.channel}\u0000${input.externalThreadId}`;
      return lock(threadKey, async () => {
        const conversation = await openOrCreate(companyId, input);
        const messageId = input.messageKey === undefined ? newId() : messageIdForKey(companyId, input.messageKey);

        const existing = await deps.store.listMessages(companyId, conversation.id);
        if (!existing.some((message: StoredMessage) => message.id === messageId)) {
          const stored = await deps.store.insertMessage(companyId, conversation.id, {
            id: messageId,
            role: "customer",
            text: input.text,
            isInternalNote: false,
            createdAt: now(),
          });
          if (!stored) throw new Error("customer message not stored: conversation not in company");
        }

        if (conversation.status !== "open") {
          return { conversationId: conversation.id, messageId, reply: null };
        }

        const reply = await deps.replies.reply(companyId, conversation.id, {
          timeoutMs: REPLY_TIMEOUT_MS,
          surface: input.surface,
          turnKey: `msg:${messageId}`,
        });
        return { conversationId: conversation.id, messageId, reply };
      });
    },
  };
}
