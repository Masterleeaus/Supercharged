/**
 * Provider registry and failover policy, built from the contracts.
 * Providers are created once, from the environment passed in. A provider is offered only when its key is
 * present (after trimming) and, for Gemini, when CHATBOT_GEMINI_ENABLED is exactly "true". Anything else is
 * absent, so a request can never reach a provider that has no key.
 */
import { CONTRACT_FLAGS, DEFAULT_FAILOVER_POLICY, MODEL_PROVIDER_ENV_KEYS, MODEL_PROVIDER_KEYS, readFlag } from "../contracts/index.ts";
import type {
  FailoverPolicy,
  ModelProvider,
  ModelProviderKey,
  ProviderRegistry,
  ProviderRegistryConfig,
} from "../contracts/index.ts";
import { AnthropicModelProvider } from "./anthropic.ts";
import { GeminiModelProvider } from "./gemini.ts";
import { OpenAIModelProvider } from "./openai.ts";
import { normalizeKey } from "./transport.ts";

export function createProviderRegistry(config: ProviderRegistryConfig): ProviderRegistry {
  const { env, http } = config;
  const providers = new Map<ModelProviderKey, ModelProvider>();

  providers.set("openai", new OpenAIModelProvider({ apiKey: env[MODEL_PROVIDER_ENV_KEYS.openai], http }));
  providers.set("anthropic", new AnthropicModelProvider({ apiKey: env[MODEL_PROVIDER_ENV_KEYS.anthropic], http }));
  if (readFlag(CONTRACT_FLAGS.GEMINI_ENABLED, env)) {
    providers.set("gemini", new GeminiModelProvider({ apiKey: env[MODEL_PROVIDER_ENV_KEYS.gemini], http }));
  }

  const hasKey = (key: ModelProviderKey): boolean => normalizeKey(env[MODEL_PROVIDER_ENV_KEYS[key]]) !== undefined;

  const available = (): ModelProviderKey[] => MODEL_PROVIDER_KEYS.filter((key) => providers.has(key) && hasKey(key));

  const get = (key: ModelProviderKey): ModelProvider | null => {
    if (!providers.has(key) || !hasKey(key)) return null;
    return providers.get(key) ?? null;
  };

  return {
    available,
    get,
    resolve(policy: FailoverPolicy): readonly ModelProvider[] {
      validateFailoverPolicy(policy);
      const out: ModelProvider[] = [];
      const seen = new Set<ModelProviderKey>();
      for (const key of policy.order) {
        if (seen.has(key)) continue;
        seen.add(key);
        const provider = get(key);
        if (provider) out.push(provider);
      }
      return out;
    },
  };
}

export interface FailoverOverrides {
  maxAttemptsPerProvider?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** Default policy: OpenAI, then Anthropic. Gemini is added last only when its flag is on. */
export function createFailoverPolicy(env: Readonly<Record<string, string | undefined>>, overrides: FailoverOverrides = {}): FailoverPolicy {
  const order: ModelProviderKey[] = [...DEFAULT_FAILOVER_POLICY.order];
  if (readFlag(CONTRACT_FLAGS.GEMINI_ENABLED, env) && !order.includes("gemini")) order.push("gemini");
  const policy: FailoverPolicy = {
    ...DEFAULT_FAILOVER_POLICY,
    order,
    maxAttemptsPerProvider: overrides.maxAttemptsPerProvider ?? DEFAULT_FAILOVER_POLICY.maxAttemptsPerProvider,
    backoffBaseMs: overrides.backoffBaseMs ?? DEFAULT_FAILOVER_POLICY.backoffBaseMs,
    backoffMaxMs: overrides.backoffMaxMs ?? DEFAULT_FAILOVER_POLICY.backoffMaxMs,
    failoverAfterFirstDelta: false,
  };
  validateFailoverPolicy(policy);
  return policy;
}

/** Configuration check. Messages name fields only, never values. */
export function validateFailoverPolicy(policy: FailoverPolicy): void {
  for (const key of policy.order) {
    if (!MODEL_PROVIDER_KEYS.includes(key)) throw new Error("Invalid failover policy: unknown provider key.");
  }
  if (!Number.isSafeInteger(policy.maxAttemptsPerProvider) || policy.maxAttemptsPerProvider < 1) {
    throw new Error("Invalid failover policy: maxAttemptsPerProvider must be an integer of at least 1.");
  }
  if (!(policy.backoffBaseMs >= 0) || !(policy.backoffMaxMs >= 0)) {
    throw new Error("Invalid failover policy: backoff values must be zero or more.");
  }
  if (policy.failoverAfterFirstDelta !== false) {
    throw new Error("Invalid failover policy: failoverAfterFirstDelta must be false.");
  }
}
