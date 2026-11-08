/**
 * Provider failover chain. Ported from TitanPro Modules/TitanCore/Services/ProviderFailoverChain.php.
 *
 * Providers are tried in order. The chain moves to the next provider when a call fails with no status
 * (transport error) or with a status in the failover list (default 429, 500, 502, 503, 504). It stops on
 * any other status, and on any failure with retryable: false.
 *
 * Changes from TitanPro (see PORT-MAP.md):
 * - A provider that throws is treated as a transport failure and the chain moves on. TitanPro lets the
 *   exception escape. The TitanPro HTTP drivers call ->throw(), which discards the status, so failover
 *   by status cannot work there. Real clients must return a status-carrying failure instead.
 * - The companyId is required and is passed to every provider.
 * - An empty chain returns a refusal, not an unset result.
 *
 * No I/O here. Providers are injected.
 */
import { requireCompanyId } from './company.ts';
import type {
  ChatCallInput,
  ChatProviderContract,
  EmbedCallInput,
  EmbeddingProviderContract,
  ProviderChatResult,
  ProviderEmbedResult,
  ProviderFailure,
  ProviderHealth,
} from './contracts.ts';

export const DEFAULT_FAILOVER_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export interface FailoverEvent {
  kind: 'chat' | 'embed';
  provider: string;
  status: number | null;
  error: string;
  failover: boolean;
}

export interface ProviderFailoverChainOptions {
  chatProviders?: ChatProviderContract[];
  embeddingProviders?: EmbeddingProviderContract[];
  failoverStatuses?: readonly number[];
  onFailure?: (event: FailoverEvent) => void;
}

type Attempt = { ok: boolean; status?: number | null; error?: string; retryable?: boolean };

function shouldFailover(failed: Attempt, statuses: readonly number[]): boolean {
  if (failed.retryable === false) return false;
  if (failed.status === undefined || failed.status === null) return true;
  return statuses.includes(failed.status);
}

function noProviders(provider: string): ProviderFailure {
  return { ok: false, provider: 'failover_chain', error: `no_${provider}_providers_configured`, status: null, retryable: false, latency_ms: null };
}

async function runChain<P extends { providerName(): string }, R extends Attempt>(
  kind: 'chat' | 'embed',
  providers: readonly P[],
  call: (provider: P) => Promise<R>,
  statuses: readonly number[],
  onFailure: ((event: FailoverEvent) => void) | undefined,
): Promise<R | ProviderFailure> {
  if (providers.length === 0) return noProviders(kind);

  let last: R | ProviderFailure | null = null;
  for (const provider of providers) {
    const name = provider.providerName();
    let result: R | ProviderFailure;
    try {
      result = await call(provider);
    } catch {
      result = { ok: false, provider: name, error: 'provider_threw', status: null, retryable: true, latency_ms: null } as ProviderFailure;
    }

    if (result.ok) return result as R;

    const failed = result as Attempt & ProviderFailure;
    const failover = shouldFailover(failed, statuses);
    onFailure?.({
      kind,
      provider: name,
      status: failed.status ?? null,
      error: String(failed.error ?? 'unknown'),
      failover,
    });

    last = result;
    if (!failover) break;
  }

  return last ?? noProviders(kind);
}

export class ProviderFailoverChain {
  private readonly chatProviders: ChatProviderContract[];
  private readonly embeddingProviders: EmbeddingProviderContract[];
  private failoverStatuses: readonly number[];
  private readonly onFailure: ((event: FailoverEvent) => void) | undefined;

  constructor(options: ProviderFailoverChainOptions = {}) {
    this.chatProviders = [...(options.chatProviders ?? [])];
    this.embeddingProviders = [...(options.embeddingProviders ?? [])];
    this.failoverStatuses = [...(options.failoverStatuses ?? DEFAULT_FAILOVER_STATUSES)];
    this.onFailure = options.onFailure;
  }

  async chat(input: ChatCallInput): Promise<ProviderChatResult> {
    const companyId = requireCompanyId(input?.companyId);
    const normalised: ChatCallInput = { ...input, companyId };
    return runChain('chat', this.chatProviders, (p) => p.chat(normalised), this.failoverStatuses, this.onFailure) as Promise<ProviderChatResult>;
  }

  async embed(input: EmbedCallInput): Promise<ProviderEmbedResult> {
    const companyId = requireCompanyId(input?.companyId);
    const normalised: EmbedCallInput = { ...input, companyId };
    return runChain('embed', this.embeddingProviders, (p) => p.embed(normalised), this.failoverStatuses, this.onFailure) as Promise<ProviderEmbedResult>;
  }

  /** Health of the primary provider, as TitanPro does. Not ok when the chain is empty. */
  async health(): Promise<ProviderHealth> {
    const primary: { providerName(): string; health(): Promise<ProviderHealth> } | undefined =
      this.chatProviders[0] ?? this.embeddingProviders[0];
    if (!primary) return { ok: false, provider: 'failover_chain', reason: 'no_providers_configured' };
    const health = await primary.health();
    return { ...health, provider: `failover_chain(${primary.providerName()})` };
  }

  providerName(): string {
    const primary = this.chatProviders[0] ?? this.embeddingProviders[0];
    return `failover_chain(${primary ? primary.providerName() : 'empty'})`;
  }

  setFailoverStatuses(statuses: readonly number[]): this {
    this.failoverStatuses = [...statuses];
    return this;
  }
}
