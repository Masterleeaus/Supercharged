/**
 * Connects the public send endpoint to the reply runtime.
 *
 * The runtime does the work: it stores the visitor's message, finds or opens the visitor's conversation, produces
 * the assistant reply, and returns the reply's id and text. This module only adapts that call to WidgetMessagePort.
 * The owner supplies the runtime at wiring time. The concrete runtime (MessageRuntime, DraftRuntime, StreamingRuntime
 * combined) is not chosen here.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type { WidgetMessageInput, WidgetMessagePort } from "./handlers.ts";

export interface WidgetReplyInput {
  companyId: string;
  chatbotPublicId: string;
  visitorId: string;
  text: string;
}

export interface WidgetReplyRuntime {
  /** Runs one visitor turn and returns the assistant reply. Must write only inside input.companyId. */
  reply(input: WidgetReplyInput): Promise<{ id: string; text: string }>;
}

export function createReplyRuntimeMessagePort(runtime: WidgetReplyRuntime): WidgetMessagePort {
  return {
    async send(input: WidgetMessageInput) {
      const companyId = requireCompanyId(input.companyId);
      const reply = await runtime.reply({
        companyId,
        chatbotPublicId: input.chatbotPublicId,
        visitorId: input.visitorId,
        text: input.text,
      });
      // Only id and text leave this adapter. Anything else the runtime returns is dropped.
      if (!reply || typeof reply.id !== "string" || typeof reply.text !== "string" || reply.id.length === 0) {
        throw new Error("reply runtime returned an invalid reply");
      }
      return { id: reply.id, text: reply.text };
    },
  };
}
