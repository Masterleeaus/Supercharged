/**
 * Error type for calendar and reminder providers.
 *
 * The message is always a fixed string built here. It never contains the response body, the request URL,
 * a header, or a credential. A provider that echoes a token back in an error body cannot leak it through this error.
 */
import type { CalendarProviderKey } from "../contracts/index.ts";

export const PROVIDER_ERROR_CODES = ["config", "invalid_request", "http", "timeout", "network", "bad_response"] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export class CalendarProviderError extends Error {
  readonly provider: CalendarProviderKey;
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  /** True when the same request may succeed later (timeouts, network, 429 and 5xx). */
  readonly retryable: boolean;

  constructor(provider: CalendarProviderKey, code: ProviderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "CalendarProviderError";
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.retryable = code === "timeout" || code === "network" || (status !== null && (status === 429 || status >= 500));
  }
}
