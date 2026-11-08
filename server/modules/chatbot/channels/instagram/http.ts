/**
 * Graph API calls. Every request goes through the injected HttpClient with a timeout. Tokens travel in the
 * Authorization header, never in the URL, so they cannot show up in proxy or access logs.
 * Errors returned from here carry a code and a status only. Response bodies are never copied into messages.
 */
import type { HttpClient, HttpResponse, HttpTransportError } from "../../contracts/index.ts";
import { INSTAGRAM_HTTP_TIMEOUT_MS } from "./config.ts";

export type GraphCallResult =
  | { ok: true; status: number; json: Record<string, unknown> }
  | { ok: false; status: number; code: "timeout" | "network" | "http_error" | "bad_json" };

/** Parses a JSON object body. Returns null for anything else, so a bad body cannot throw. */
export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isTransportError(value: unknown): value is HttpTransportError {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "timeout" || (value as { kind: unknown }).kind === "network")
  );
}

/**
 * Sends one request. A form body is url-encoded, a JSON body is serialised by the caller.
 * Non-2xx and transport errors come back as values, so callers decide what to do.
 */
export async function graphRequest(
  http: HttpClient,
  input: {
    method: "GET" | "POST";
    url: string;
    bearer?: string;
    form?: Record<string, string>;
    json?: unknown;
  },
): Promise<GraphCallResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.bearer) headers.Authorization = `Bearer ${input.bearer}`;

  let body: string | undefined;
  if (input.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(input.form).toString();
  } else if (input.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(input.json);
  }

  let response: HttpResponse;
  try {
    response = await http({
      method: input.method,
      url: input.url,
      headers,
      body,
      timeoutMs: INSTAGRAM_HTTP_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTransportError(error)) {
      return { ok: false, status: 0, code: error.kind };
    }
    return { ok: false, status: 0, code: "network" };
  }

  const json = parseJsonObject(response.body);
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, code: "http_error" };
  }
  if (!json) {
    return { ok: false, status: response.status, code: "bad_json" };
  }
  return { ok: true, status: response.status, json };
}
