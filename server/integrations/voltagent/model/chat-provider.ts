/**
 * VoltAgent model adapter for the AI runtime. Implements ChatProviderContract by calling a
 * VoltAgent-compatible LanguageModel (a Vercel AI SDK model object) that the caller has already built.
 *
 * - No API key is read here. The caller builds the model with its own key and passes the model in.
 * - A string model id is refused. Passing a string would route the call through the AI SDK gateway,
 *   which reads its own key from the environment.
 * - Nothing is mounted. Nothing in the app calls this yet.
 * - SDK retries are off (maxRetries: 0), so a provider status reaches ProviderFailoverChain unchanged.
 *   The chain then decides failover from its own status list (429, 500, 502, 503, 504 by default).
 * - Unconfigured: returns DisabledChatProvider, which refuses every call and performs no I/O.
 *
 * Decisions are logged in /home/claude/supercharged-fixes-checklist.md.
 */
import { generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { DisabledChatProvider } from '../../../services/ai-runtime/contracts.ts';
import type {
  ChatCallInput,
  ChatProviderContract,
  ProviderChatResult,
  ProviderFailure,
  ProviderHealth,
  ProviderUsage,
} from '../../../services/ai-runtime/contracts.ts';

export interface VoltAgentChatConfig {
  /** A model object built by the caller. Undefined, null, or a string id means unconfigured. */
  model?: LanguageModel | null;
  /** Name reported to the failover chain. Defaults to 'voltagent'. */
  providerName?: string;
}

type ModelObject = Exclude<LanguageModel, string>;

const DEFAULT_PROVIDER_NAME = 'voltagent';

function isModelObject(model: unknown): model is ModelObject {
  return typeof model === 'object' && model !== null && typeof (model as { modelId?: unknown }).modelId === 'string';
}

/** Returns a fail-closed provider unless a model object is passed in. */
export function createVoltAgentChatProvider(config: VoltAgentChatConfig = {}): ChatProviderContract {
  const model = config?.model;
  if (!isModelObject(model)) return new DisabledChatProvider();
  return new VoltAgentChatProvider(model, config.providerName ?? DEFAULT_PROVIDER_NAME);
}

class VoltAgentChatProvider implements ChatProviderContract {
  constructor(
    private readonly model: ModelObject,
    private readonly name: string,
  ) {}

  providerName(): string {
    return this.name;
  }

  async chat(input: ChatCallInput): Promise<ProviderChatResult> {
    const started = Date.now();
    const converted = toModelMessages(input?.messages);
    if (!converted.ok) {
      return failure(this.name, converted.error, null, false, started);
    }

    const signal = input.options?.abortSignal instanceof AbortSignal ? input.options.abortSignal : undefined;
    try {
      const result = await generateText({
        model: this.model,
        messages: converted.messages,
        maxRetries: 0,
        abortSignal: signal,
      });
      return {
        ok: true,
        provider: this.name,
        model: this.model.modelId,
        content: result.text,
        usage: toUsage(result.usage),
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return toFailure(this.name, err, signal, started);
    }
  }

  /** No I/O. Configured means a model object was supplied; the key is checked by the first call. */
  async health(): Promise<ProviderHealth> {
    return { ok: true, provider: this.name, reason: null };
  }
}

type Converted = { ok: true; messages: ModelMessage[] } | { ok: false; error: string };

function toModelMessages(messages: ChatCallInput['messages'] | undefined): Converted {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: 'no_messages' };
  const out: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content });
        break;
      case 'user':
        out.push({ role: 'user', content: message.content });
        break;
      case 'assistant':
        out.push({ role: 'assistant', content: message.content });
        break;
      default:
        // Tool messages need a matching tool call, which this adapter does not build.
        return { ok: false, error: 'unsupported_message_role' };
    }
  }
  return { ok: true, messages: out };
}

function toUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): ProviderUsage | null {
  if (!usage) return null;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function httpStatusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const record = err as { statusCode?: unknown; status?: unknown };
  const candidate = record.statusCode ?? record.status;
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : null;
}

/**
 * Maps a thrown SDK error to a failure. The error text is a short code, never the provider's message,
 * so a provider response body or key cannot reach the caller's logs through this path.
 * A status is kept whatever it is, and the failover chain decides. A caller abort never fails over.
 */
function toFailure(provider: string, err: unknown, signal: AbortSignal | undefined, started: number): ProviderFailure {
  const aborted = signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
  if (aborted) return failure(provider, 'aborted', null, false, started);

  const status = httpStatusOf(err);
  const code = status === null ? 'transport_error' : `http_${status}`;
  return failure(provider, code, status, true, started);
}

function failure(provider: string, error: string, status: number | null, retryable: boolean, started: number): ProviderFailure {
  return { ok: false, provider, error, status, retryable, latency_ms: Date.now() - started };
}
