/**
 * Error type for the marketplace slice. Messages are safe to show a seller: they never carry provider
 * payloads, credentials, approval tokens or raw provider error text. Callers branch on `code`.
 */
export const MARKETPLACE_ERROR_CODES = [
  "misconfigured",
  "disabled",
  "forbidden",
  "not_found",
  "unsupported_provider",
  "read_only_provider",
  "capability_missing",
  "invalid_changes",
  "idempotency_conflict",
  "confirmation_required",
  "confirmation_invalid",
  "confirmation_expired",
  "stale_or_conflict",
  "rate_limited",
  "spend_limit",
  "bulk_cap",
  "no_match",
  "invalid_state",
  "provider_unavailable",
  "provider_mismatch",
] as const;
export type MarketplaceErrorCode = (typeof MARKETPLACE_ERROR_CODES)[number];

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;
  /** Set for rate_limited. Milliseconds until the next attempt is allowed. */
  readonly retryAfterMs: number | null;

  constructor(code: MarketplaceErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "MarketplaceError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
