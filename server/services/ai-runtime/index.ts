/**
 * Desk AI runtime. One shared entry point for model calls, guardrails, retrieval with citations, tools and
 * provider failover. Ported from TitanPro (see PORT-MAP.md).
 *
 * Wiring: the app builds provider clients at startup, with their keys taken from configuration, and passes
 * them here. This module never reads env, never stores a key, and never makes an HTTP call itself.
 *
 * Fail-closed default: with no chat or embedding client configured, the runtime uses the Disabled
 * providers. Every model call returns provider_not_configured without any I/O. mode is 'disabled'.
 *
 * Every entry point takes companyId and validates it. Nothing reads a company from a request.
 */
import { requireCompanyId } from './company.ts';
import {
  DisabledChatProvider,
  DisabledEmbeddingProvider,
  type ChatCallInput,
  type ChatMessage,
  type ChatProviderContract,
  type EmbedCallInput,
  type EmbeddingProviderContract,
  type ProviderChatResult,
  type ProviderEmbedResult,
  type ProviderHealth,
} from './contracts.ts';
import { ProviderFailoverChain, type FailoverEvent } from './failover.ts';
import { evaluateGuardrail, type GuardrailContract } from './guardrail.ts';
import { runPipeline, type PipelineRequest, type PipelineResult, type PipelineStages } from './pipeline.ts';
import type { CompanyId } from './types.ts';

export { AiRuntimeError, type AiRuntimeErrorCode, type CompanyId } from './types.ts';
export { requireCompanyId, tryCompanyId } from './company.ts';
export * from './contracts.ts';
export { ProviderFailoverChain, DEFAULT_FAILOVER_STATUSES, type FailoverEvent, type ProviderFailoverChainOptions } from './failover.ts';
export {
  createBlockedTermGuardrail,
  evaluateGuardrail,
  resolveBlockedTerms,
  screenInput,
  screenOutput,
  screenText,
  type GuardrailContract,
  type GuardrailHandler,
  type GuardrailInput,
  type GuardrailManifest,
  type GuardrailTripped,
  type GuardrailVerdict,
} from './guardrail.ts';
export {
  extractTerms,
  rankCandidates,
  retrieveChunks,
  resolveTopK,
  scoreCandidate,
  type ChunkCandidate,
  type RetrievalPolicy,
  type RetrievalResult,
  type RetrievalStore,
} from './retrieval.ts';
export {
  attachCitations,
  buildCitation,
  createCitationStage,
  parseChunkId,
  resolveCitations,
  type ChunkRecord,
  type Citation,
} from './citation.ts';
export {
  ToolExecutor,
  createToolPermissionGate,
  validateToolInput,
  type ToolAuditEntry,
  type ToolContext,
  type ToolDefinition,
  type ToolErrorCode,
  type ToolManifest,
  type ToolResult,
} from './tools.ts';
export { runPipeline, type PipelineRequest, type PipelineResult, type PipelineStages } from './pipeline.ts';
export {
  compositeScore,
  detectHallucination,
  evaluateResponse,
  scoreTaskCompletion,
  scoreToolAccuracy,
  type EvaluationExpectation,
  type EvaluationInput,
  type EvaluationScore,
} from './evaluator.ts';

export interface AiRuntimeOptions {
  chatProviders?: ChatProviderContract[];
  embeddingProviders?: EmbeddingProviderContract[];
  failoverStatuses?: readonly number[];
  onFailure?: (event: FailoverEvent) => void;
  /** Stages used by runPipeline(). The input guardrail is also applied to chat(). */
  stages?: PipelineStages;
  /** Applied to a successful chat() answer before it is returned. */
  outputGuardrail?: GuardrailContract | null;
}

export interface AiRuntime {
  /** 'configured' when at least one real client was supplied, otherwise 'disabled'. */
  readonly mode: 'configured' | 'disabled';
  chat(input: { companyId: CompanyId; messages: ChatMessage[]; options?: Record<string, unknown> }): Promise<ProviderChatResult>;
  embed(input: { companyId: CompanyId; input: string | string[]; options?: Record<string, unknown> }): Promise<ProviderEmbedResult>;
  health(): Promise<ProviderHealth>;
  runPipeline(input: { companyId: CompanyId; request: PipelineRequest; context?: { userId?: string | number | null; user?: unknown; dryRun?: boolean } }): Promise<PipelineResult>;
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function invalidMessages(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  return messages.some(
    (m) => !m || typeof m !== 'object' || !ROLES.has((m as ChatMessage).role) || typeof (m as ChatMessage).content !== 'string',
  );
}

function refused(provider: string, error: string): ProviderChatResult {
  return { ok: false, provider, error, status: null, retryable: false, latency_ms: null };
}

export function createAiRuntime(options: AiRuntimeOptions = {}): AiRuntime {
  const configuredChat = options.chatProviders ?? [];
  const configuredEmbed = options.embeddingProviders ?? [];
  const mode: 'configured' | 'disabled' = configuredChat.length > 0 || configuredEmbed.length > 0 ? 'configured' : 'disabled';

  const chain = new ProviderFailoverChain({
    chatProviders: configuredChat.length > 0 ? configuredChat : [new DisabledChatProvider()],
    embeddingProviders: configuredEmbed.length > 0 ? configuredEmbed : [new DisabledEmbeddingProvider()],
    failoverStatuses: options.failoverStatuses,
    onFailure: options.onFailure,
  });

  const stages = options.stages ?? {};

  return {
    mode,

    async chat(input) {
      const companyId = requireCompanyId(input?.companyId);
      if (invalidMessages(input?.messages)) return refused('runtime', 'messages_invalid');

      if (stages.guardrail) {
        const userText = input.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n');
        const verdict = await evaluateGuardrail(stages.guardrail, {
          companyId,
          text: userText,
          tool: null,
          params: {},
          context: { stage: 'input' },
        });
        if (!verdict.pass) return refused('runtime', 'guardrail_blocked');
      }

      const call: ChatCallInput = { companyId, messages: input.messages, options: input.options };
      const result = await chain.chat(call);

      if (result.ok && options.outputGuardrail) {
        const verdict = await evaluateGuardrail(options.outputGuardrail, {
          companyId,
          text: result.content,
          tool: null,
          params: {},
          context: { stage: 'output' },
        });
        if (!verdict.pass) return refused('runtime', 'output_blocked');
      }

      return result;
    },

    async embed(input) {
      const companyId = requireCompanyId(input?.companyId);
      const call: EmbedCallInput = { companyId, input: input.input, options: input.options };
      return chain.embed(call);
    },

    async health() {
      return chain.health();
    },

    async runPipeline(input) {
      const companyId = requireCompanyId(input?.companyId);
      return runPipeline({ companyId, request: input.request, context: input.context, stages });
    },
  };
}
