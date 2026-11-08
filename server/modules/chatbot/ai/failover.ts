/**
 * Failover runner. Tries providers in policy order. Retries the same provider on the policy's retry statuses,
 * then moves on. A timeout or network failure moves on at once. Any other error goes straight back to the caller.
 * The whole call shares one budget (request.timeoutMs), so failover cannot exceed the caller's limit.
 */
import { MODEL_PROVIDER_ENV_KEYS } from "../contracts/index.ts";
import type {
  FailoverPolicy,
  ModelCompletion,
  ModelProviderError,
  ModelProviderErrorCode,
  ModelProviderKey,
  ModelRequest,
  ProviderRegistry,
} from "../contracts/index.ts";
import { toProviderError } from "./errors.ts";

export interface FailoverOptions {
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Milliseconds, like Date.now(). */
  now?: () => number;
}

export interface FailoverAttempt {
  provider: ModelProviderKey;
  attempt: number;
  status: number | null;
  code: ModelProviderErrorCode;
}

/** Thrown when no provider answered. Carries the last normalised error and every attempt made. */
export class ModelCallFailure extends Error {
  readonly error: ModelProviderError;
  readonly attempts: readonly FailoverAttempt[];

  constructor(error: ModelProviderError, attempts: readonly FailoverAttempt[]) {
    super(error.message);
    this.name = "ModelCallFailure";
    this.error = error;
    this.attempts = attempts;
  }
}

export function backoffDelayMs(policy: FailoverPolicy, attempt: number): number {
  return Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** (attempt - 1));
}

/** True when the policy allows another attempt, on the same provider or the next one. */
export function isFailoverEligible(error: ModelProviderError, policy: FailoverPolicy): boolean {
  if (!error.retryable) return false;
  if (error.status === null) return true;
  return policy.retryOnStatus.includes(error.status);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function completeWithFailover(
  registry: ProviderRegistry,
  policy: FailoverPolicy,
  companyId: string,
  request: ModelRequest,
  options: FailoverOptions = {},
): Promise<ModelCompletion> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + request.timeoutMs;
  const attempts: FailoverAttempt[] = [];

  const providers = registry.resolve(policy);
  if (providers.length === 0) {
    throw new ModelCallFailure(noProviderError(policy), attempts);
  }

  let last: ModelProviderError | null = null;

  for (const provider of providers) {
    for (let attempt = 1; attempt <= policy.maxAttemptsPerProvider; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new ModelCallFailure(budgetError(provider.key, request.timeoutMs), attempts);
      }
      try {
        return await provider.complete(companyId, { ...request, timeoutMs: remaining });
      } catch (err) {
        const error = toProviderError(err, provider.key);
        attempts.push({ provider: provider.key, attempt, status: error.status, code: error.code });
        last = error;

        if (!isFailoverEligible(error, policy)) {
          throw new ModelCallFailure(error, attempts);
        }
        // Timeout or network failure: the budget for this provider is spent, so move on.
        if (error.status === null) break;

        if (attempt < policy.maxAttemptsPerProvider) {
          const delay = backoffDelayMs(policy, attempt);
          if (deadline - now() <= delay) break;
          await sleep(delay);
        }
      }
    }
  }

  throw new ModelCallFailure(last ?? budgetError(policy.order[0] ?? "openai", request.timeoutMs), attempts);
}

function noProviderError(policy: FailoverPolicy): ModelProviderError {
  const names = policy.order.map((key) => MODEL_PROVIDER_ENV_KEYS[key]);
  const geminiNote = policy.order.includes("gemini") ? " Gemini also needs CHATBOT_GEMINI_ENABLED=true." : "";
  return {
    provider: policy.order[0] ?? "openai",
    status: null,
    code: "auth",
    retryable: false,
    message: `No model provider is available. Set ${names.join(" or ")}.${geminiNote}`,
  };
}

function budgetError(provider: ModelProviderKey, timeoutMs: number): ModelProviderError {
  return {
    provider,
    status: null,
    code: "timeout",
    retryable: true,
    message: `The model call budget of ${timeoutMs} ms was used up before a provider answered.`,
  };
}
