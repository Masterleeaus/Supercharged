/**
 * Model provider port. Concrete providers (OpenAI, Anthropic, Gemini) implement ModelProvider and receive an
 * HttpClient through their constructor. Nothing here reads environment variables or makes a call.
 *
 * Provider order: OpenAI is primary, Anthropic is the failover, Gemini is optional and off by default
 * (flag CHATBOT_GEMINI_ENABLED, see flags.ts). API keys come from the environment only (ENV_KEYS below).
 *
 * Every method takes companyId first, so each call can be attributed to a tenant for usage and cost.
 */
import type { HttpClient } from "./http.ts";

export const MODEL_PROVIDER_KEYS = ["openai", "anthropic", "gemini"] as const;
export type ModelProviderKey = (typeof MODEL_PROVIDER_KEYS)[number];

/** Environment variable that holds each provider's API key. The key is never stored in code or the database. */
export const MODEL_PROVIDER_ENV_KEYS: Readonly<Record<ModelProviderKey, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  role: ModelRole;
  content: string;
  /** Set on role "tool" messages to link the result to the call that produced it. */
  toolCallId?: string;
  /**
   * Set on role "assistant" messages that asked for tools. Needed to replay a multi-turn tool conversation,
   * because each tool result must follow the call that produced it. Added by change request C1 (ai slice).
   */
  toolCalls?: ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  /** Arguments as the model produced them, already parsed from JSON. Validation is the caller's job. */
  arguments: Record<string, unknown>;
}

export type ModelPurpose = "reply" | "draft" | "summary" | "translate" | "classify" | "action";

export interface ModelRequest {
  /** Provider-specific model id. Chosen by the caller, not hard-coded in this port. */
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "text" | "json";
  /** Hard limit for the whole call, in milliseconds. Required. */
  timeoutMs: number;
  purpose: ModelPurpose;
  /** Carried into usage records. Not sent to the provider unless the provider needs it. */
  conversationId?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelFinishReason = "stop" | "length" | "tool_call" | "content_filter" | "error";

export interface ModelCompletion {
  provider: ModelProviderKey;
  model: string;
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: ModelFinishReason;
  usage: ModelUsage;
  /** The provider's own request id, for support tickets. Null when the provider does not return one. */
  providerRequestId: string | null;
}

export type ModelStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ModelToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done"; finishReason: ModelFinishReason }
  | { type: "error"; error: ModelProviderError };

export interface EmbedRequest {
  model: string;
  inputs: string[];
  timeoutMs: number;
  conversationId?: string;
}

export interface EmbedResult {
  provider: ModelProviderKey;
  model: string;
  /** Length of every vector in this result. Stored with each embedding so a model change is detectable. */
  dimensions: number;
  /** One vector per input, in input order. Plain number arrays (see knowledge.ts for the similarity decision). */
  vectors: number[][];
  usage: { inputTokens: number };
}

export type ModelProviderErrorCode =
  | "rate_limited"
  | "upstream_unavailable"
  | "timeout"
  | "auth"
  | "bad_request"
  | "content_filtered"
  | "unknown";

/** Normalised error. Providers map their own status codes and error bodies onto this shape. */
export interface ModelProviderError {
  provider: ModelProviderKey;
  /** HTTP status from the provider, or null for timeouts and network failures. */
  status: number | null;
  code: ModelProviderErrorCode;
  /** True when the failover policy may try the next provider. Derived from status, see FailoverPolicy. */
  retryable: boolean;
  /** Short, non-secret message. Never includes the API key or the raw request body. */
  message: string;
}

export interface ModelProvider {
  readonly key: ModelProviderKey;
  complete(companyId: string, request: ModelRequest): Promise<ModelCompletion>;
  stream(companyId: string, request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  embed(companyId: string, request: EmbedRequest): Promise<EmbedResult>;
}

/** Statuses that trigger failover to the next provider. Anything else is returned to the caller as is. */
export const FAILOVER_RETRY_STATUSES = [429, 500, 502, 503, 504] as const;

export interface FailoverPolicy {
  /** Providers in the order they are tried. Gemini is only listed when its flag is on. */
  order: readonly ModelProviderKey[];
  retryOnStatus: readonly number[];
  /** Attempts per provider before moving to the next one. Must be at least 1. */
  maxAttemptsPerProvider: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Failover is never used for streams after the first delta has been sent to a customer. */
  failoverAfterFirstDelta: false;
}

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  order: ["openai", "anthropic"],
  retryOnStatus: FAILOVER_RETRY_STATUSES,
  maxAttemptsPerProvider: 2,
  backoffBaseMs: 250,
  backoffMaxMs: 2000,
  failoverAfterFirstDelta: false,
};

export interface ProviderRegistry {
  /** Keys whose API key is present in the environment and whose flags allow use. */
  available(): readonly ModelProviderKey[];
  get(key: ModelProviderKey): ModelProvider | null;
  /** Providers for a request, in failover order. Empty when none is available. */
  resolve(policy: FailoverPolicy): readonly ModelProvider[];
}

/** Input the registry needs to build providers. Keys are read from the environment, never passed in code. */
export interface ProviderRegistryConfig {
  env: Readonly<Record<string, string | undefined>>;
  http: HttpClient;
  policy: FailoverPolicy;
}
