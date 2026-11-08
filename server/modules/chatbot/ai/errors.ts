/**
 * Normalised model-provider errors and secret scrubbing.
 * Nothing in this file reads the environment. A message produced here never carries an API key or a raw
 * request body: messages are fixed strings, plus a short, scrubbed excerpt of the provider's own error text.
 */
import { FAILOVER_RETRY_STATUSES } from "../contracts/index.ts";
import type { ModelProviderError, ModelProviderErrorCode, ModelProviderKey } from "../contracts/index.ts";

export const PROVIDER_LABELS: Readonly<Record<ModelProviderKey, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

/** Thrown by provider methods. Carries the normalised error so callers and the failover runner can act on it. */
export class ModelCallError extends Error {
  readonly providerError: ModelProviderError;

  constructor(providerError: ModelProviderError) {
    super(providerError.message);
    this.name = "ModelCallError";
    this.providerError = providerError;
  }
}

const KEY_SHAPES: readonly RegExp[] = [/sk-ant-[A-Za-z0-9_-]+/g, /sk-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{20,}/g];
const MAX_EXCERPT = 200;

/** Removes known secrets and key-shaped strings from text, then caps its length. */
export function scrubMessage(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  for (const shape of KEY_SHAPES) out = out.replace(shape, "[redacted]");
  out = out.replace(/([?&]key=)[^&\s"']*/gi, "$1[redacted]");
  return out.length > MAX_EXCERPT ? `${out.slice(0, MAX_EXCERPT)}...` : out;
}

export function codeForStatus(status: number): ModelProviderErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "upstream_unavailable";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** Retry and failover eligibility for an error, before the policy is applied. */
export function isRetryableFailure(status: number | null, code: ModelProviderErrorCode): boolean {
  if (status === null) return code === "timeout" || code === "upstream_unavailable";
  return (FAILOVER_RETRY_STATUSES as readonly number[]).includes(status);
}

export function providerFailure(
  provider: ModelProviderKey,
  code: ModelProviderErrorCode,
  status: number | null,
  message: string,
): ModelCallError {
  return new ModelCallError({
    provider,
    status,
    code,
    retryable: isRetryableFailure(status, code),
    message,
  });
}

/** Turns anything thrown during a call into a normalised error. Unknown throws keep no detail. */
export function toProviderError(err: unknown, provider: ModelProviderKey): ModelProviderError {
  if (err instanceof ModelCallError) return err.providerError;
  return {
    provider,
    status: null,
    code: "unknown",
    retryable: false,
    message: "Model provider call failed unexpectedly.",
  };
}
