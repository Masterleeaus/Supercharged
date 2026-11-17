/**
 * VoltAgent model adapter (Phase 1, W3, issue #377).
 *
 * Wraps a ProviderFailoverChain as a text model that VoltAgent code can call. The adapter does no I/O of its
 * own. Failover, status handling and the default status list (429, 500, 502, 503, 504) all come from the chain.
 * The adapter never overrides those statuses.
 *
 * Fail closed:
 * - A chain is required when the adapter is built. Without one, the constructor throws.
 * - companyId is required for every call and is passed to the chain.
 * - When the chain refuses (no provider configured, or a non-failover failure), generate() throws a
 *   ModelUnavailableError with the chain's error code and status. It never returns an empty answer.
 * - Only the roles system, user, assistant and tool are accepted. Any other role throws before a call is made.
 *
 * Adapter only. No call site is migrated to this module.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 * The VoltAgent model interface is not verified against an installed @voltagent/core, because
 * node_modules/@voltagent is empty in this checkout.
 */
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { ChatMessage, ChatRole, ProviderChatResult, ProviderUsage } from '../../../services/ai-runtime/contracts.ts';

const ALLOWED_ROLES: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool'];

export interface ChatChain {
  chat(input: { companyId: unknown; messages: ChatMessage[]; options?: Record<string, unknown> }): Promise<ProviderChatResult>;
}

export interface VoltMessage {
  role: string;
  content: string;
}

export interface VoltModelResult {
  text: string;
  provider: string;
  model: string | null;
  usage: ProviderUsage | null;
  latencyMs: number | null;
}

export class ModelUnavailableError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly provider: string;

  constructor(code: string, status: number | null, provider: string) {
    super(`model_unavailable:${code}`);
    this.name = 'ModelUnavailableError';
    this.code = code;
    this.status = status;
    this.provider = provider;
  }
}

export interface VoltModelAdapterOptions {
  chain: ChatChain;
  companyId: unknown;
  options?: Record<string, unknown>;
}

export interface VoltModelAdapter {
  generate(messages: readonly VoltMessage[]): Promise<VoltModelResult>;
}

function toChatMessages(messages: readonly VoltMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('model_messages_required');
  return messages.map((m) => {
    if (typeof m !== 'object' || m === null) throw new Error('model_message_invalid');
    if (!ALLOWED_ROLES.includes(m.role as ChatRole)) throw new Error('model_message_role_invalid');
    if (typeof m.content !== 'string') throw new Error('model_message_content_invalid');
    return { role: m.role as ChatRole, content: m.content };
  });
}

export function createVoltModelAdapter(options: VoltModelAdapterOptions): VoltModelAdapter {
  if (!options || !options.chain || typeof options.chain.chat !== 'function') {
    throw new Error('model_chain_required');
  }
  const companyId = requireCompanyId(options.companyId);
  const chain = options.chain;
  const callOptions = options.options ? { ...options.options } : undefined;

  return {
    async generate(messages) {
      const chatMessages = toChatMessages(messages);
      const result = await chain.chat({ companyId, messages: chatMessages, options: callOptions });
      if (!result.ok) {
        throw new ModelUnavailableError(result.error, result.status, result.provider);
      }
      return {
        text: result.content,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        latencyMs: result.latency_ms,
      };
    },
  };
}
