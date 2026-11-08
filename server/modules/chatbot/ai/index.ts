/**
 * Barrel for the model-provider slice. Consumers import from here.
 * Providers take an injected HttpClient and a key. None of them reads the environment directly.
 */
export { OpenAIModelProvider, OPENAI_CHAT_URL, OPENAI_EMBED_URL } from "./openai.ts";
export { AnthropicModelProvider, ANTHROPIC_MESSAGES_URL } from "./anthropic.ts";
export { GeminiModelProvider, GEMINI_BASE_URL } from "./gemini.ts";
export { createProviderRegistry, createFailoverPolicy, validateFailoverPolicy } from "./registry.ts";
export type { FailoverOverrides } from "./registry.ts";
export { completeWithFailover, backoffDelayMs, isFailoverEligible, ModelCallFailure } from "./failover.ts";
export type { FailoverAttempt, FailoverOptions } from "./failover.ts";
export { bufferedStream, streamWithFailover, eventsFromCompletion } from "./stream.ts";
export { ModelCallError, scrubMessage, toProviderError } from "./errors.ts";
