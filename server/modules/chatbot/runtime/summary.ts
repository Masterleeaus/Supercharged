/*
 * Conversation summary (port of AIRuntime::summarize). Pure apart from the model call made through the failover route.
 * Caching and the summary timestamp are left to the caller, because the chatbot storage has no summary column.
 */
import { completeWithFailover, type CompletionRoute } from "./failover.ts";

export const SUMMARY_FALLBACK_CHARS = 1200;
export const SUMMARY_TEMPERATURE = 0.2;

/** Only the fields a transcript needs. Works for the legacy chatbot-storage rows and the contract rows alike. */
export interface TranscriptMessage {
  role: string;
  message: string | null;
}

/** Removes markup. Not a full HTML parser: enough to keep tags out of a model transcript. */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

/** One line per message, "role: text". Empty when there are no messages. */
export function transcriptOf(messages: TranscriptMessage[]): string {
  return messages.map((message) => `${message.role}: ${stripTags(message.message ?? "")}`).join("\n");
}

/** Plain fallback used when the model is unavailable: the start of the transcript, cut by code point. */
export function fallbackSummary(transcript: string): string {
  return Array.from(transcript).slice(0, SUMMARY_FALLBACK_CHARS).join("");
}

export interface SummaryResult {
  text: string;
  /** False when the text is the plain fallback, because no model answered. Fallbacks should not be cached. */
  fromModel: boolean;
}

/** Summary plus whether a model produced it. Empty transcript gives empty text with fromModel false. */
export async function summarizeWithStatus(
  route: CompletionRoute,
  companyId: string,
  messages: TranscriptMessage[],
  options: { timeoutMs: number; conversationId?: string },
): Promise<SummaryResult> {
  const transcript = transcriptOf(messages);
  if (transcript === "") return { text: "", fromModel: false };

  const result = await completeWithFailover(route, companyId, {
    messages: [
      { role: "system", content: "Summarize this conversation factually and concisely." },
      { role: "user", content: transcript },
    ],
    purpose: "summary",
    timeoutMs: options.timeoutMs,
    conversationId: options.conversationId,
    temperature: SUMMARY_TEMPERATURE,
  });
  if (!result.ok) return { text: fallbackSummary(transcript), fromModel: false };
  const text = result.completion.text.trim();
  if (text === "") return { text: fallbackSummary(transcript), fromModel: false };
  return { text, fromModel: true };
}

export async function summarizeConversation(
  route: CompletionRoute,
  companyId: string,
  messages: TranscriptMessage[],
  options: { timeoutMs: number; conversationId?: string },
): Promise<string> {
  return (await summarizeWithStatus(route, companyId, messages, options)).text;
}
