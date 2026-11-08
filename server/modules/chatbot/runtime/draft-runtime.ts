/*
 * Draft runtime: AI-suggested replies that a staff member reads, edits and then sends (or discards).
 *
 * Port of DraftRuntime.php (translate and draft in AIRuntime.php). The runtime has no send, insert or channel
 * dependency, so it cannot send a draft. A draft is returned as text only. Sending is a staff action in the
 * message runtime, and only then is anything stored as a message.
 */
import { completeWithFailover, type CompletionRoute } from "./failover.ts";
import { buildDraftMessages } from "./prompt-builder.ts";
import type { DraftContext, DraftResult, DraftRuntime as DraftRuntimeContract, ModelMessage } from "../contracts/index.ts";

export const DRAFT_TEMPERATURE = 0.4;
export const TRANSLATE_TEMPERATURE = 0;

export interface DraftRuntime extends DraftRuntimeContract {}

export interface DraftRuntimeDeps {
  route: CompletionRoute;
}

export function createDraftRuntime(deps: DraftRuntimeDeps): DraftRuntime {
  return {
    async draft(companyId, context: DraftContext): Promise<DraftResult> {
      const messages = buildDraftMessages({
        // The draft context carries instructions and locale, not the chatbot title. The title is left empty.
        chatbot: { title: "", language: context.locale ?? "en", instructions: context.instructions, welcomeMessage: null },
        knowledgeText: context.knowledgeText,
        recent: context.recentMessages,
        locale: context.locale,
      });
      const result = await completeWithFailover(deps.route, companyId, {
        messages,
        purpose: "draft",
        timeoutMs: context.timeoutMs,
        conversationId: context.conversationId,
        temperature: DRAFT_TEMPERATURE,
      });
      if (!result.ok) throw new Error("provider_unavailable");
      return {
        text: result.completion.text.trim(),
        // The model does not report a trustworthy confidence, so none is returned.
        confidence: null,
        usage: result.completion.usage,
        model: result.completion.model,
      };
    },

    async translate(companyId, text, targetLocale, timeoutMs): Promise<string> {
      const messages: ModelMessage[] = [
        { role: "system", content: `Translate to ${targetLocale}. Return only the translation.` },
        { role: "user", content: text },
      ];
      const result = await completeWithFailover(deps.route, companyId, {
        messages,
        purpose: "translate",
        timeoutMs,
        temperature: TRANSLATE_TEMPERATURE,
      });
      if (!result.ok) return text;
      return result.completion.text.trim() || text;
    },
  };
}
