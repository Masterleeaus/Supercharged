/*
 * Streaming runtime: turns model stream events into ordered frames for a caller-supplied publisher.
 *
 * Port of the StreamingRuntime contract. The PHP persisted every event to a replay table and sent it through a
 * Laravel event. This port keeps neither: frames go to publish(), and the reply text is persisted once, at the end,
 * through persistReply. No transport is named here.
 *
 * Rules:
 * - Each streamed reply numbers its frames 1, 2, 3 ... in the order the model produced them.
 * - A publish failure is swallowed. It never stops the stream or undoes the persisted reply.
 * - An error event, or an error thrown while streaming, sends an error frame and persists nothing.
 * - Failover is not possible here: the caller picks one provider before the stream starts.
 */
import type { ModelFinishReason, ModelStreamEvent, ModelUsage, StreamingRuntime as StreamingRuntimeContract } from "../contracts/index.ts";
import { ZERO_USAGE, type StreamOutcome, type StreamPublisher } from "./types.ts";

export type PersistReply = (companyId: string, conversationId: string, text: string) => Promise<string>;

export interface StreamingRuntimeDeps {
  publish: StreamPublisher;
  /** Used when streamReply is called without a per-call persist function. */
  persistReply?: PersistReply;
}

export interface StreamingRuntime extends StreamingRuntimeContract {
  streamReply(
    companyId: string,
    conversationId: string,
    events: AsyncIterable<ModelStreamEvent>,
    persist?: (text: string) => Promise<string>,
  ): Promise<StreamOutcome>;
}

export function createStreamingRuntime(deps: StreamingRuntimeDeps): StreamingRuntime {
  const send = async (frame: Parameters<StreamPublisher>[0]): Promise<boolean> => {
    try {
      await deps.publish(frame);
      return true;
    } catch {
      return false;
    }
  };

  return {
    async streamReply(companyId, conversationId, events, persist) {
      const persistText: ((text: string) => Promise<string>) | undefined =
        persist ?? (deps.persistReply ? (text) => deps.persistReply!(companyId, conversationId, text) : undefined);
      if (!persistText) throw new Error("streamReply needs a persist function");

      let sequence = 0;
      let deltasSent = 0;
      let text = "";
      let usage: ModelUsage = ZERO_USAGE;
      let finishReason: ModelFinishReason = "stop";
      let failed = false;

      try {
        for await (const event of events) {
          if (event.type === "text-delta") {
            if (event.text === "") continue;
            text += event.text;
            sequence += 1;
            if (await send({ kind: "chunk", companyId, conversationId, sequence, text: event.text })) deltasSent += 1;
          } else if (event.type === "usage") {
            usage = { ...event.usage };
          } else if (event.type === "done") {
            finishReason = event.finishReason;
            break;
          } else if (event.type === "error") {
            failed = true;
            break;
          }
          // tool-call events carry no reply text. The reply pipeline does not run tools.
        }
      } catch {
        failed = true;
      }

      if (failed || finishReason === "error") {
        sequence += 1;
        await send({ kind: "error", companyId, conversationId, sequence, reason: "stream_error" });
        return { messageId: "", deltasSent, finishReason: "error", usage };
      }

      if (text === "") {
        sequence += 1;
        await send({ kind: "done", companyId, conversationId, sequence, messageId: null, finishReason });
        return { messageId: "", deltasSent, finishReason, usage };
      }

      let messageId: string;
      try {
        messageId = await persistText(text);
      } catch {
        sequence += 1;
        await send({ kind: "error", companyId, conversationId, sequence, reason: "persist_error" });
        return { messageId: "", deltasSent, finishReason: "error", usage };
      }

      sequence += 1;
      await send({ kind: "done", companyId, conversationId, sequence, messageId, finishReason });
      return { messageId, deltasSent, finishReason, usage };
    },

    async typing(companyId, conversationId, participantKey, active) {
      await send({ kind: "typing", companyId, conversationId, participantKey, active });
    },
  };
}
