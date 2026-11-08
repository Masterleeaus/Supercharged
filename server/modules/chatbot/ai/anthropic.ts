/**
 * Anthropic model provider (failover). Ported from AnthropicGenerator.php: messages API with the system
 * prompt split out, tool_use and tool_result blocks, and a 4096-token default output cap.
 * Anthropic offers no embeddings endpoint, so embed() fails without a network call.
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
  parseArguments,
  postJson,
  readUsage,
  requireKey,
} from "./transport.ts";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
const JSON_ONLY_INSTRUCTION = "Respond with a single valid JSON object and nothing else.";

type Block = Record<string, unknown>;
interface AnthropicTurn {
  role: "user" | "assistant";
  content: Block[];
}

export interface AnthropicProviderOptions {
  apiKey: string | undefined;
  http: HttpClient;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly key: "anthropic" = "anthropic";
  readonly #apiKey: string | undefined;
  readonly #http: HttpClient;

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = normalizeKey(options.apiKey);
    this.#http = options.http;
  }

  async complete(companyId: string, request: ModelRequest): Promise<ModelCompletion> {
    assertChatRequest(this.key, companyId, request);
    const apiKey = requireKey(this.key, this.#apiKey);
    const { json, headers } = await postJson(this.#http, {
      provider: this.key,
      url: ANTHROPIC_MESSAGES_URL,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: buildMessagesBody(request),
      timeoutMs: request.timeoutMs,
      secrets: [apiKey],
    });
    return parseMessage(json, request.model, headers["request-id"] ?? headers["x-request-id"] ?? null);
  }

  stream(companyId: string, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    return bufferedStream(this, companyId, request);
  }

  async embed(companyId: string, request: EmbedRequest): Promise<EmbedResult> {
    assertEmbedRequest(this.key, companyId, request);
    throw providerFailure(
      this.key,
      "bad_request",
      null,
      "Anthropic does not offer embeddings. Use the OpenAI or Gemini provider for embed().",
    );
  }
}

function buildMessagesBody(request: ModelRequest): Record<string, unknown> {
  const system: string[] = [];
  const turns: AnthropicTurn[] = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      if (message.content.trim() !== "") system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      appendBlock(turns, "user", toolResultBlock(message));
      continue;
    }
    if (message.content.trim() === "") continue;
    appendBlock(turns, message.role === "assistant" ? "assistant" : "user", { type: "text", text: message.content });
  }

  if (turns.length === 0) {
    throw providerFailure("anthropic", "bad_request", null, "At least one user or assistant message is required.");
  }
  if (request.responseFormat === "json") system.push(JSON_ONLY_INSTRUCTION);

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: turns,
  };
  if (system.length > 0) body.system = system.join("\n\n");
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  return body;
}

function toolResultBlock(message: ModelMessage): Block {
  return { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
}

/** Anthropic expects alternating turns, so consecutive blocks for the same role share one turn. */
function appendBlock(turns: AnthropicTurn[], role: "user" | "assistant", block: Block): void {
  const last = turns[turns.length - 1];
  if (last && last.role === role) {
    last.content.push(block);
  } else {
    turns.push({ role, content: [block] });
  }
}

function parseMessage(json: Record<string, any>, model: string, requestId: string | null): ModelCompletion {
  if (!Array.isArray(json.content)) {
    throw providerFailure("anthropic", "unknown", null, "Anthropic returned a response with no content.");
  }
  const blocks: any[] = json.content;
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const toolCalls: ModelToolCall[] = blocks
    .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({ id: String(block.id ?? ""), name: block.name as string, arguments: parseArguments(block.input) }));

  return {
    provider: "anthropic",
    model,
    text,
    toolCalls,
    finishReason: mapStopReason(json.stop_reason, toolCalls.length > 0),
    usage: readUsage(json.usage, "input_tokens", "output_tokens"),
    providerRequestId: requestId,
  };
}

function mapStopReason(reason: unknown, hasToolCalls: boolean): ModelFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    case "refusal":
      return "content_filter";
    default:
      return hasToolCalls ? "tool_call" : "error";
  }
}
