/**
 * Shared request plumbing for the three providers: key handling, input checks, the injected HTTP call,
 * and response parsing helpers. Every outbound call goes through the HttpClient passed in by the caller.
 */
import { MODEL_PROVIDER_ENV_KEYS } from "../contracts/index.ts";
import type {
  EmbedRequest,
  HttpClient,
  HttpResponse,
  ModelProviderKey,
  ModelRequest,
  ModelUsage,
} from "../contracts/index.ts";
import { PROVIDER_LABELS, codeForStatus, providerFailure, scrubMessage } from "./errors.ts";

export function normalizeKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Fails closed. The message names the variable, never the value. */
export function requireKey(provider: ModelProviderKey, key: string | undefined): string {
  if (key !== undefined) return key;
  const envName = MODEL_PROVIDER_ENV_KEYS[provider];
  throw providerFailure(provider, "auth", null, `${envName} is not set, so the ${PROVIDER_LABELS[provider]} provider is unavailable.`);
}

export function assertCompany(provider: ModelProviderKey, companyId: string): void {
  if (typeof companyId !== "string" || companyId.trim() === "") {
    throw providerFailure(provider, "bad_request", null, "companyId is required.");
  }
}

export function assertTimeout(provider: ModelProviderKey, timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw providerFailure(provider, "bad_request", null, "timeoutMs must be a positive integer.");
  }
}

export function assertChatRequest(provider: ModelProviderKey, companyId: string, request: ModelRequest): void {
  assertCompany(provider, companyId);
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw providerFailure(provider, "bad_request", null, "model is required.");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw providerFailure(provider, "bad_request", null, "messages must be a non-empty list.");
  }
  for (const message of request.messages) {
    if (message.role === "tool" && (typeof message.toolCallId !== "string" || message.toolCallId === "")) {
      throw providerFailure(provider, "bad_request", null, "tool messages need a toolCallId.");
    }
  }
  assertTimeout(provider, request.timeoutMs);
}

export function assertEmbedRequest(provider: ModelProviderKey, companyId: string, request: EmbedRequest): void {
  assertCompany(provider, companyId);
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw providerFailure(provider, "bad_request", null, "model is required.");
  }
  if (!Array.isArray(request.inputs) || request.inputs.length === 0 || request.inputs.some((s) => typeof s !== "string")) {
    throw providerFailure(provider, "bad_request", null, "inputs must be a non-empty list of strings.");
  }
  assertTimeout(provider, request.timeoutMs);
}

export interface JsonCall {
  provider: ModelProviderKey;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  /** Values that must never appear in an error message. */
  secrets: readonly string[];
}

export interface JsonResult {
  json: Record<string, any>;
  headers: Record<string, string>;
}

/** POST a JSON body through the injected client. Maps transport and HTTP failures onto normalised errors. */
export async function postJson(http: HttpClient, call: JsonCall): Promise<JsonResult> {
  assertTimeout(call.provider, call.timeoutMs);
  const label = PROVIDER_LABELS[call.provider];

  let response: HttpResponse;
  try {
    response = await http({
      method: "POST",
      url: call.url,
      headers: call.headers,
      body: JSON.stringify(call.body),
      timeoutMs: call.timeoutMs,
    });
  } catch (err) {
    if (isTransportKind(err, "timeout")) {
      throw providerFailure(call.provider, "timeout", null, `${label} request timed out after ${call.timeoutMs} ms.`);
    }
    throw providerFailure(call.provider, "upstream_unavailable", null, `${label} request failed before a response was received.`);
  }

  const headers = lowerKeys(response.headers ?? {});
  const text = typeof response.body === "string" ? response.body : "";

  if (response.status < 200 || response.status > 299) {
    const detail = providerDetail(text, call.secrets);
    const message = `${label} returned HTTP ${response.status}.${detail ? ` ${detail}` : ""}`;
    throw providerFailure(call.provider, codeForStatus(response.status), response.status, message);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw providerFailure(call.provider, "unknown", null, `${label} returned a body that is not a JSON object.`);
  }
  return { json: json as Record<string, any>, headers };
}

function isTransportKind(err: unknown, kind: string): boolean {
  return typeof err === "object" && err !== null && (err as { kind?: unknown }).kind === kind;
}

function lowerKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/** Pulls the provider's own error text out of an error body, scrubbed. Returns "" when there is none. */
function providerDetail(text: string, secrets: readonly string[]): string {
  try {
    const parsed = JSON.parse(text);
    const candidate = parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : undefined);
    return typeof candidate === "string" ? scrubMessage(candidate, secrets) : "";
  } catch {
    return "";
  }
}

export function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function readUsage(usage: any, inputKey: string, outputKey: string): ModelUsage {
  return { inputTokens: nonNegativeInt(usage?.[inputKey]), outputTokens: nonNegativeInt(usage?.[outputKey]) };
}

/** Tool arguments arrive as JSON text (OpenAI) or as objects (Anthropic, Gemini). Malformed text becomes {}. */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Fall through to the empty object. The caller validates tool arguments.
    }
  }
  return {};
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
