/**
 * Error type for the knowledge slice. Extends ChatbotError so the routes map it to a status the same way.
 * Messages never carry API keys, raw request bodies or provider payloads.
 */
import { ChatbotError } from "../chatbot-scope.ts";

export type KnowledgeErrorCode =
  | "disabled"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "url_refused"
  | "fetch_failed"
  | "unsupported_content"
  | "too_large"
  | "embedding_failed"
  | "write_failed"
  | "provider_unavailable";

export class KnowledgeError extends ChatbotError {
  readonly code: KnowledgeErrorCode;

  constructor(code: KnowledgeErrorCode, message: string, status = 400) {
    super(message, status);
    this.name = "KnowledgeError";
    this.code = code;
  }
}

const SECRET_PATTERN = /(sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi;
const MAX_MESSAGE = 300;

/** Short, non-secret text for lastError and logs. */
export function safeMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown error";
  return raw.replace(SECRET_PATTERN, "[redacted]").slice(0, MAX_MESSAGE);
}
