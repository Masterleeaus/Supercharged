/*
 * Runs one completion against the providers in failover order. Port of the failover rule in the PHP
 * ProviderRegistry: a retryable error moves to the next provider, anything else is thrown to the caller.
 * Failover is only for complete(). Streams never fail over after a delta (see FailoverPolicy).
 */
import type {
  FailoverPolicy,
  ModelCompletion,
  ModelProvider,
  ModelProviderError,
  ModelProviderKey,
  ModelRequest,
} from "../contracts/index.ts";

export interface CompletionRoute {
  /** Providers in failover order, as resolved by the provider registry. */
  providers: readonly ModelProvider[];
  /** Model id per provider. A provider with no model here is skipped. */
  models: Partial<Record<ModelProviderKey, string>>;
  policy: FailoverPolicy;
}

export type FailoverResult = { ok: true; completion: ModelCompletion } | { ok: false; reason: "provider_unavailable" };

export function isModelProviderError(value: unknown): value is ModelProviderError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ModelProviderError>;
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean" && typeof candidate.provider === "string";
}

/** The providers that have a model configured, in order. */
export function usableProviders(route: CompletionRoute): ModelProvider[] {
  return route.providers.filter((provider) => route.models[provider.key] !== undefined);
}

export async function completeWithFailover(
  route: CompletionRoute,
  companyId: string,
  request: Omit<ModelRequest, "model">,
): Promise<FailoverResult> {
  const providers = usableProviders(route);
  if (providers.length === 0) return { ok: false, reason: "provider_unavailable" };

  const attempts = Math.max(1, Math.trunc(route.policy.maxAttemptsPerProvider));
  let lastError: unknown = null;

  for (const provider of providers) {
    const model = route.models[provider.key] as string;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const completion = await provider.complete(companyId, { ...request, model });
        return { ok: true, completion };
      } catch (error) {
        lastError = error;
        if (!isModelProviderError(error) || !error.retryable) throw error;
        if (attempt < attempts) await backoff(route.policy, attempt);
      }
    }
  }

  throw lastError;
}

async function backoff(policy: FailoverPolicy, attempt: number): Promise<void> {
  const delay = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** (attempt - 1));
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}
