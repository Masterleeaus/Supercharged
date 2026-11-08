/**
 * Provider client interfaces. Ported from TitanPro Modules/TitanCore/AI/ClientInterface.php and
 * Modules/TitanCore/Contracts/AI/{Chat,Embedding}ProviderContract.
 *
 * This file defines interfaces only. There is no HTTP client here and nothing that holds an API key.
 * A real client is constructed at startup by the app, with its key injected from configuration, and
 * passed to createAiRuntime(). Browser code never reaches a provider.
 *
 * Fail-closed default: DisabledChatProvider and DisabledEmbeddingProvider refuse every call and make
 * no I/O. createAiRuntime() uses them when no client is configured.
 */
import type { CompanyId } from './types.ts';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCallInput {
  companyId: CompanyId;
  messages: ChatMessage[];
  options?: Record<string, unknown>;
}

export interface EmbedCallInput {
  companyId: CompanyId;
  input: string | string[];
  options?: Record<string, unknown>;
}

export interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ProviderChatSuccess {
  ok: true;
  provider: string;
  model: string | null;
  content: string;
  usage: ProviderUsage | null;
  latency_ms: number | null;
}

export interface ProviderEmbedSuccess {
  ok: true;
  provider: string;
  model: string | null;
  vectors: number[][];
  usage: ProviderUsage | null;
  latency_ms: number | null;
}

/**
 * A failed provider call. `status` is the HTTP status when the client has one. Null means a
 * transport-level failure, which the failover chain treats as retryable. `retryable: false` stops the
 * chain even when the status would allow failover.
 */
export interface ProviderFailure {
  ok: false;
  provider: string;
  error: string;
  status: number | null;
  retryable: boolean;
  latency_ms: number | null;
}

export type ProviderChatResult = ProviderChatSuccess | ProviderFailure;
export type ProviderEmbedResult = ProviderEmbedSuccess | ProviderFailure;

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  reason: string | null;
}

export interface ChatProviderContract {
  providerName(): string;
  chat(input: ChatCallInput): Promise<ProviderChatResult>;
  health(): Promise<ProviderHealth>;
}

export interface EmbeddingProviderContract {
  providerName(): string;
  embed(input: EmbedCallInput): Promise<ProviderEmbedResult>;
  health(): Promise<ProviderHealth>;
}

export const PROVIDER_NOT_CONFIGURED = 'provider_not_configured';

/** Fail-closed chat client. Takes no arguments and performs no I/O. Every call is refused. */
export class DisabledChatProvider implements ChatProviderContract {
  providerName(): string {
    return 'disabled';
  }

  async chat(): Promise<ProviderChatResult> {
    return { ok: false, provider: 'disabled', error: PROVIDER_NOT_CONFIGURED, status: null, retryable: false, latency_ms: null };
  }

  async health(): Promise<ProviderHealth> {
    return { ok: false, provider: 'disabled', reason: PROVIDER_NOT_CONFIGURED };
  }
}

/** Fail-closed embedding client. Takes no arguments and performs no I/O. Every call is refused. */
export class DisabledEmbeddingProvider implements EmbeddingProviderContract {
  providerName(): string {
    return 'disabled';
  }

  async embed(): Promise<ProviderEmbedResult> {
    return { ok: false, provider: 'disabled', error: PROVIDER_NOT_CONFIGURED, status: null, retryable: false, latency_ms: null };
  }

  async health(): Promise<ProviderHealth> {
    return { ok: false, provider: 'disabled', reason: PROVIDER_NOT_CONFIGURED };
  }
}
