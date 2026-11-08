/**
 * Runs one outbound marketplace call behind the rate limiter. Every provider read and write goes through here
 * or through the explicit acquire/observe/recordFailure sequence in the write runtime.
 * Provider errors are reported as provider_unavailable with no provider text, so nothing leaks into messages.
 */
import type { RateLimitHooks } from "../../contracts/index.ts";
import { MarketplaceError } from "./errors.ts";

export async function guardedCall<T>(
  limiter: RateLimitHooks,
  companyId: string,
  provider: string,
  capability: string,
  call: () => Promise<T>,
): Promise<T> {
  const decision = await limiter.acquire(companyId, provider, capability);
  if (!decision.allowed) {
    throw new MarketplaceError("rate_limited", "The marketplace is rate limited. Try again later.", decision.retryAfterMs);
  }
  try {
    const result = await call();
    await limiter.observe(companyId, provider, capability, { status: 200, headers: {} });
    return result;
  } catch (error) {
    if (error instanceof MarketplaceError) throw error;
    await limiter.recordFailure(companyId, provider, capability, "call_failed");
    throw new MarketplaceError("provider_unavailable", "Marketplace is temporarily unavailable.");
  }
}
