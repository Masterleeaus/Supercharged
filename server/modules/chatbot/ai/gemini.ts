/**
 * Gemini model provider (optional, off unless CHATBOT_GEMINI_ENABLED is exactly "true").
 * Ported from GeminiGenerator.php. Differences from the PHP: the key travels in the x-goog-api-key header
 * instead of the URL query, so it cannot leak through a logged or reported URL. The model id is checked
 * before it is placed in the path.
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
  requireKey,
} from "./transport.ts";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const JSON_ONLY_INSTRUCTION = "Respond with a single valid JSON object and nothing else.";

export interface GeminiProviderOptions {
  apiKey: string | undefined;
  http: HttpClient;
}

export class GeminiModelProvider implements ModelProvider {
  readonly key: "gemini" = "gemini";
  readonly #apiKey: string | undefined;
  readonly #http: HttpClient;

  constructor(options: GeminiProviderOptions) {
    this.#apiKey = normalizeKey(options.apiKey);
    this.#http = options.http;
  }

  async complete(companyId: string, request: ModelRequest): Promise<ModelCompletion> {
    assertChatRequest(this.key, companyId, request);
    const model = checkedModelId(this.key, request.model);
    const apiKey = requireKey(this.key, this.#apiKey);
    const { json, headers } = await postJson(this.#http, {
      provider: this.key,
      url: `${GEMINI_BASE_URL}/models/${model}:generateContent`,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: buildGenerateBody(request),
      timeoutMs: request.timeoutMs,
      secrets: [apiKey],
    });
    return parseGenerate(json, request.model, headers["x-request-id"] ?? null);
  }

  stream(companyId: string, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    return bufferedStream(this, companyId, request);
  }

  async embed(companyId: string, request: EmbedRequest): Promise<EmbedResult> {
    assertEmbedRequest(this.key, companyId, request);
    const model = checkedModelId(this.key, request.model);
    const apiKey = requireKey(this.key, this.#apiKey);
    const { json } = await postJson(this.#http, {
      provider: this.key,
      url: `${GEMINI_BASE_URL}/models/${model}:batchEmbedContents`,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: {
        requests: request.inputs.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      },
      timeoutMs: request.timeoutMs,
      secrets: [apiKey],
    });
    const items: any[] = Array.isArray(json.embeddings) ? json.embeddings : [];
    const vectors: number[][] = items.map((item) => (Array.isArray(item?.values) ? item.values.map(Number) : []));
    const dimensions = vectors[0]?.length ?? 0;
    const consistent = vectors.length === request.inputs.length && dimensions > 0 && vectors.every((v) => v.length === dimensions);
    if (!consistent) {
      throw providerFailure(this.key, "unknown", null, "Gemini returned embeddings that do not match the inputs.");
    }
    return { provider: this.key, model: request.model, dimensions, vectors, usage: { inputTokens: 0 } };
  }
}

function checkedModelId(provider: "gemini", model: string): string {
  if (!MODEL_ID_PATTERN.test(model)) {
    throw providerFailure(provider, "bad_request", null, "The Gemini model id contains characters that are not allowed.");
  }
  return model;
}

function buildGenerateBody(request: ModelRequest): Record<string, unknown> {
  const system: string[] = [];
  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      if (message.content.trim() !== "") system.push(message.content);
      continue;
    }
    const text = textForGemini(message);
    if (text.trim() === "") continue;
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }

  if (contents.length === 0) {
    throw providerFailure("gemini", "bad_request", null, "At least one user or assistant message is required.");
  }
  if (request.responseFormat === "json") system.push(JSON_ONLY_INSTRUCTION);

  const body: Record<string, unknown> = { contents };
  if (system.length > 0) body.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  if (request.tools && request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.responseFormat === "json") generationConfig.responseMimeType = "application/json";
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

/** Tool results have no functionResponse name here (only the call id is kept), so they go in as labelled text. */
function textForGemini(message: ModelMessage): string {
  if (message.role === "tool") return `Tool result (${message.toolCallId}): ${message.content}`;
  return message.content;
}

function parseGenerate(json: Record<string, any>, model: string, requestId: string | null): ModelCompletion {
  const candidate = Array.isArray(json.candidates) ? json.candidates[0] : undefined;
  if (!candidate) {
    const blocked = typeof json.promptFeedback?.blockReason === "string";
    if (blocked) {
      return {
        provider: "gemini",
        model,
        text: "",
        toolCalls: [],
        finishReason: "content_filter",
        usage: readGeminiUsage(json),
        providerRequestId: requestId,
      };
    }
    throw providerFailure("gemini", "unknown", null, "Gemini returned a response with no candidates.");
  }

  const parts: any[] = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((part) => typeof part?.text === "string").map((part) => part.text as string).join("");
  const toolCalls: ModelToolCall[] = parts
    .filter((part) => part?.functionCall && typeof part.functionCall.name === "string")
    .map((part, index) => ({
      id: `${part.functionCall.name}-${index}`,
      name: part.functionCall.name as string,
      arguments: parseArguments(part.functionCall.args),
    }));

  return {
    provider: "gemini",
    model,
    text,
    toolCalls,
    finishReason: mapFinishReason(candidate.finishReason, toolCalls.length > 0),
    usage: readGeminiUsage(json),
    providerRequestId: requestId,
  };
}

function readGeminiUsage(json: Record<string, any>) {
  return {
    inputTokens: nonNegativeInt(json.usageMetadata?.promptTokenCount),
    outputTokens: nonNegativeInt(json.usageMetadata?.candidatesTokenCount),
  };
}

const CONTENT_FILTER_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

function mapFinishReason(reason: unknown, hasToolCalls: boolean): ModelFinishReason {
  if (hasToolCalls) return "tool_call";
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (typeof reason === "string" && CONTENT_FILTER_REASONS.has(reason)) return "content_filter";
  return "error";
}
