/*
 * StreamingRuntime over Server-Sent Events. Token deltas go to the customer on the conversation and to the
 * staff streams of the company. Persistence happens once, at the end, through the injected persistReply hook.
 *
 * Failover is not handled here. The events come from one provider stream that the caller already chose, and
 * the stream is never retried after its first delta.
 */
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import type { ModelFinishReason, ModelStreamEvent, ModelUsage } from "../contracts/ai.ts";
import type { StreamingRuntime, StreamSummary } from "../contracts/runtime.ts";
import type { SseHub } from "./hub.ts";

export interface PersistReplyInput {
  companyId: string;
  conversationId: string;
  streamId: string;
  text: string;
  finishReason: ModelFinishReason;
  usage: ModelUsage;
}

export interface SseStreamingOptions {
  hub: SseHub;
  /** Makes the stream id. Defaults to crypto.randomUUID. */
  newId?: () => string;
  /**
   * Writes the finished reply and returns the stored message id. Called once, after the last delta, and only
   * when the reply did not end in an error. Without it, the summary's messageId is the stream id.
   */
  persistReply?: (input: PersistReplyInput) => Promise<{ messageId: string }>;
}

/** Error text sent to clients. Provider messages are never forwarded, because they may carry details. */
export const STREAM_FAILED_CODE = "reply_failed";

export function createSseStreamingRuntime(options: SseStreamingOptions): StreamingRuntime {
  const { hub, persistReply } = options;
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());

  return {
    async streamReply(companyId, conversationId, events: AsyncIterable<ModelStreamEvent>): Promise<StreamSummary> {
      if (!isCompanyId(companyId)) throw new TypeError("Streaming needs a company id");

      const streamId = newId();
      let text = "";
      let deltas = 0;
      let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
      let finishReason: ModelFinishReason = "stop";

      try {
        for await (const event of events) {
          if (event.type === "text-delta") {
            if (event.text.length === 0) continue;
            text += event.text;
            deltas += 1;
            hub.routeToConversation(companyId, conversationId, "token", { streamId, index: deltas, text: event.text });
          } else if (event.type === "usage") {
            // Last report wins. Providers send running totals, so this is the final count.
            usage = { ...event.usage };
          } else if (event.type === "done") {
            finishReason = event.finishReason;
          } else if (event.type === "error") {
            finishReason = "error";
          }
          // tool-call events are not part of the text stream and are ignored here.
        }
      } catch {
        finishReason = "error";
      }

      let messageId = streamId;
      if (finishReason === "error") {
        hub.routeToConversation(companyId, conversationId, "error", { streamId, code: STREAM_FAILED_CODE });
      } else if (persistReply) {
        try {
          const saved = await persistReply({ companyId, conversationId, streamId, text, finishReason, usage });
          messageId = saved.messageId;
        } catch {
          finishReason = "error";
          hub.routeToConversation(companyId, conversationId, "error", { streamId, code: STREAM_FAILED_CODE });
        }
      }

      hub.routeToConversation(companyId, conversationId, "done", { streamId, messageId, finishReason });
      return { messageId, deltasSent: deltas, finishReason, usage };
    },

    async typing(companyId, conversationId, participantKey, active) {
      if (!isCompanyId(companyId)) throw new TypeError("Typing needs a company id");
      hub.routeToConversation(companyId, conversationId, "typing", { participantKey, active });
    },
  };
}
