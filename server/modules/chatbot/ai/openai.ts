/**
 * OpenAI model provider (primary). Ported from OpenAIGenerator.php: chat completions with tool calls and
 * the system-instruction layering. Embeddings use the /v1/embeddings endpoint.
 */
import type {
  EmbedRequest,
  EmbedResult,
  HttpClient,
  ModelCompletion,
  ModelFinishReason,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
} from "../contracts/index.ts";
import { providerFailure } from "./errors.ts";
import { bufferedStream } from "./stream.ts";
import {
  assertChatRequest,
  assertEmbedRequest,
  normalizeKey,
  nonNegativeInt,
  parseArguments,
  postJson,
  readUsage,
  requireKey,
} from "./transport.ts";

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";

export interface OpenAIProviderOptions {
  apiKey: string | undefined;
  http: HttpClient;
}

export class OpenAIModelProvider implements ModelProvider {
  readonly key: "openai" = "openai";
  readonly #apiKey: string | undefined;
  readonly #http: HttpClient;

  constructor(options: OpenAIProviderOptions) {
    this.#apiKey = normalizeKey(options.apiKey);
    this.#http = options.http;
  }

  async complete(companyId: string, request: ModelRequest): Promise<ModelCompletion> {
    assertChatRequest(this.key, companyId, request);
    const apiKey = requireKey(this.key, this.#apiKey);
    const { json, headers } = await postJson(this.#http, {
      provider: this.key,
      url: OPENAI_CHAT_URL,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: buildChatBody(request),
      timeoutMs: request.timeoutMs,
      secrets: [apiKey],
    });
    return parseChat(json, request.model, headers["x-request-id"] ?? null);
  }

  stream(companyId: string, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    return bufferedStream(this, companyId, request);
  }

  async embed(companyId: string, request: EmbedRequest): Promise<EmbedResult> {
    assertEmbedRequest(this.key, companyId, request);
    const apiKey = requireKey(this.key, this.#apiKey);
    const { json } = await postJson(this.#http, {
      provider: this.key,
      url: OPENAI_EMBED_URL,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: { model: request.model, input: request.inputs },
      timeoutMs: request.timeoutMs,
      secrets: [apiKey],
    });
    const data: any[] = Array.isArray(json.data) ? [...json.data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)) : [];
    const vectors: number[][] = data.map((item) => (Array.isArray(item?.embedding) ? item.embedding.map(Number) : []));
    const dimensions = vectors[0]?.length ?? 0;
    const consistent = vectors.length === request.inputs.length && dimensions > 0 && vectors.every((v) => v.length === dimensions);
    if (!consistent) {
      throw providerFailure(this.key, "unknown", null, "OpenAI returned embeddings that do not match the inputs.");
    }
    return {
      provider: this.key,
      model: request.model,
      dimensions,
      vectors,
      usage: { inputTokens: nonNegativeInt(json.usage?.prompt_tokens) },
    };
  }
}

function buildChatBody(request: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toOpenAIMessage),
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) body.max_completion_tokens = request.maxOutputTokens;
  if (request.responseFormat === "json") body.response_format = { type: "json_object" };
  return body;
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  return { role: message.role, content: message.content };
}

function parseChat(json: Record<string, any>, model: string, requestId: string | null): ModelCompletion {
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (!choice || typeof choice !== "object") {
    throw providerFailure("openai", "unknown", null, "OpenAI returned a response with no choices.");
  }
  const message = choice.message ?? {};
  const toolCalls: ModelToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter((call: any) => typeof call?.function?.name === "string")
        .map((call: any) => ({
          id: String(call.id ?? ""),
          name: call.function.name as string,
          arguments: parseArguments(call.function.arguments),
        }))
    : [];
  return {
    provider: "openai",
    model,
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    finishReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    usage: readUsage(json.usage, "prompt_tokens", "completion_tokens"),
    providerRequestId: requestId,
  };
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): ModelFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "content_filter":
      return "content_filter";
    default:
      return hasToolCalls ? "tool_call" : "error";
  }
}
