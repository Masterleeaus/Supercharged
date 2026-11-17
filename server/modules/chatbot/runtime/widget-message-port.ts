/*
 * The widget's message port: one visitor message in, the assistant reply out. The visitor is the channel thread
 * (channel "web", thread = visitor id), so each visitor keeps one conversation per chatbot.
 *
 * Rules:
 * - The public id is looked up first. A chatbot of another company, or an unknown public id, is refused before any write.
 * - A refused turn throws. The widget handler turns a throw into a generic 503, so no reason reaches the visitor.
 */
import type { WidgetChatbotReader, WidgetMessageInput, WidgetMessagePort } from "../widget/handlers.ts";
import type { CustomerTurns } from "./customer-turn.ts";
import type { ConversationStore } from "./conversation-store.ts";

export function createWidgetMessagePort(deps: {
  chatbots: WidgetChatbotReader;
  turns: CustomerTurns;
  store: Pick<ConversationStore, "listMessages">;
}): WidgetMessagePort {
  return {
    async send(input: WidgetMessageInput) {
      const config = await deps.chatbots.findByPublicId(input.chatbotPublicId);
      if (!config || config.companyId !== input.companyId) throw new Error("widget chatbot not found");

      const turn = await deps.turns.run(input.companyId, {
        chatbotId: config.chatbotId,
        channel: "web",
        externalThreadId: input.visitorId,
        text: input.text,
        surface: "widget",
      });
      if (turn.reply === null) throw new Error("widget conversation is not open");
      if (turn.reply.status !== "stored" && turn.reply.status !== "duplicate") {
        throw new Error(`widget reply not produced: ${turn.reply.status}`);
      }

      const replyId = turn.reply.messageId;
      const stored = (await deps.store.listMessages(input.companyId, turn.conversationId)).find((row) => row.id === replyId);
      if (!stored || stored.text === null) throw new Error("widget reply not readable");
      return { id: stored.id, text: stored.text };
    },
  };
}
