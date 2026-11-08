/**
 * JSON wrapper over the injected HttpClient. Every outbound provider call goes through here, so the timeout,
 * the error shape and the "never echo the body" rule are the same for Calendly and Cal.com.
 */
import type { CalendarProviderKey, HttpClient, HttpMethod } from "../contracts/index.ts";
import { CalendarProviderError } from "./errors.ts";

export interface JsonCall {
  provider: CalendarProviderKey;
  http: HttpClient;
  method: HttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  timeoutMs: number;
}

export interface JsonResult {
  status: number;
  json: unknown;
}

function isTransportError(error: unknown): error is { kind: "timeout" | "network" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    ((error as { kind: unknown }).kind === "timeout" || (error as { kind: unknown }).kind === "network")
  );
}

/**
 * Sends one request and parses a 2xx JSON body. An empty 2xx body returns json null (cancel endpoints often
 * answer 204). Non-2xx responses throw with the status only. The body is not read into the error.
 */
export async function callJson(call: JsonCall): Promise<JsonResult> {
  const headers: Record<string, string> = { accept: "application/json", ...(call.headers ?? {}) };
  const hasBody = call.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";

  let response;
  try {
    response = await call.http({
      method: call.method,
      url: call.url,
      headers,
      body: hasBody ? JSON.stringify(call.body) : undefined,
      timeoutMs: call.timeoutMs,
    });
  } catch (error) {
    if (isTransportError(error) && error.kind === "timeout") {
      throw new CalendarProviderError(call.provider, "timeout", `${call.provider} request timed out`);
    }
    throw new CalendarProviderError(call.provider, "network", `${call.provider} request could not be completed`);
  }

  if (response.status < 200 || response.status > 299) {
    throw new CalendarProviderError(
      call.provider,
      "http",
      `${call.provider} request failed with status ${response.status}`,
      response.status,
    );
  }
  if (response.body.trim().length === 0) return { status: response.status, json: null };
  try {
    return { status: response.status, json: JSON.parse(response.body) as unknown };
  } catch {
    throw new CalendarProviderError(call.provider, "bad_response", `${call.provider} returned a body that is not JSON`);
  }
}
