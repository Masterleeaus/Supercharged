/**
 * Injected HTTP port. Every outbound call to a model, channel, marketplace, payment, calendar or any other
 * third party goes through an HttpClient that the caller passes in. No module calls global fetch directly.
 *
 * Rules (see CONVENTIONS.md):
 * - timeoutMs is required on every request. A request without a timeout is a contract violation.
 * - Tests inject a fake HttpClient. No test may reach the network.
 * - Responses are returned as text. JSON parsing is the caller's job, so a bad body cannot throw inside the port.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  /** Already-serialised body. Never log it: it may carry customer data or credentials. */
  body?: string;
  /** Hard limit for the whole call, in milliseconds. Must be a positive integer. */
  timeoutMs: number;
  /**
   * Redirect handling. Default "follow" (the existing behaviour). "manual" means the client must return the 3xx
   * response as is, so a caller can check each hop. Added by change request 3 (knowledge slice, SSRF guard).
   */
  redirect?: "follow" | "manual";
}

export interface HttpResponse {
  status: number;
  /** Header names are lower-cased by the implementation. */
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Optional streaming variant of HttpClient, yielding body chunks as text as they arrive. Added by change request C2
 * (ai slice). Optional: the buffered HttpClient stays the required port, and nothing must depend on this one.
 * Same rules as HttpClient: timeoutMs is required, and no test may reach the network.
 */
export type HttpStreamClient = (request: HttpRequest) => Promise<HttpStreamResponse>;

export interface HttpStreamResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** Body chunks in arrival order. The caller decodes and parses them. */
  chunks: AsyncIterable<string>;
}

/** Error shape thrown by an HttpClient when a request times out or the connection fails. */
export interface HttpTransportError {
  kind: "timeout" | "network";
  message: string;
}
