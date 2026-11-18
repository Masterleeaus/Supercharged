/**
 * Cohere reranker (Phase 1, W6, issue #380; Mastra gap 2).
 *
 * Calls a Cohere-style rerank endpoint and returns the documents ordered by relevance. The fetch function is
 * injected, so tests use a mock and no network call is made in tests.
 *
 * Fail closed:
 * - An API key is required when the reranker is built. Without one, construction throws.
 * - Empty document lists return [] without a request.
 * - Non-2xx responses, timeouts and malformed bodies throw RerankError. The error carries the status and a fixed
 *   code, never the key or the response body.
 * - Result indexes must be integers inside the document range, and scores must be finite numbers.
 *
 * Port source (attribution): mastra-ai/mastra, packages/rag/src/rerank/relevance/cohere/index.ts, licence Apache-2.0
 * (Copyright (c) 2025 Kepler Software, Inc.), read at commit b9d38c73982210c6564ee8a33d992a238e29a20b. The endpoint
 * (POST /v2/rerank), the default model, the Bearer header and the results[] { index, relevance_score } parsing follow it.
 * Differences: this module reranks a whole document list in one call and not one document at a time, it returns
 * indexes, and it checks every response field and throws fixed error codes. The Mastra file is not copied verbatim.
 * The live Cohere API is not called from tests.
 *
 * Licence of this file: TitanZero code under the Apache-2.0 attribution above. See source/mastra-apache-only/README.md.
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface CohereRerankerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface RerankedItem {
  index: number;
  score: number;
}

export type RerankErrorCode = 'rerank_failed' | 'rerank_timeout' | 'rerank_response_invalid' | 'rerank_input_invalid';

export class RerankError extends Error {
  readonly code: RerankErrorCode;
  readonly status: number | null;

  constructor(code: RerankErrorCode, status: number | null = null) {
    super(code);
    this.name = 'RerankError';
    this.code = code;
    this.status = status;
  }
}

export const MAX_DOCUMENTS = 1000;
export const MAX_QUERY_CHARS = 2000;

export interface Reranker {
  rerank(query: string, documents: readonly string[], topN?: number): Promise<RerankedItem[]>;
}

export function createCohereReranker(options: CohereRerankerOptions): Reranker {
  if (!options || typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new Error('rerank_api_key_required');
  }
  const apiKey = options.apiKey;
  const model = options.model ?? 'rerank-v3.5';
  const baseUrl = (options.baseUrl ?? 'https://api.cohere.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('rerank_timeout_invalid');
  const fetchImpl: FetchLike | undefined = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') throw new Error('rerank_fetch_required');

  return {
    async rerank(query, documents, topN) {
      if (typeof query !== 'string' || query.trim() === '' || query.length > MAX_QUERY_CHARS) {
        throw new RerankError('rerank_input_invalid');
      }
      if (!Array.isArray(documents) || documents.some((d) => typeof d !== 'string')) {
        throw new RerankError('rerank_input_invalid');
      }
      if (documents.length > MAX_DOCUMENTS) throw new RerankError('rerank_input_invalid');
      if (documents.length === 0) return [];

      const limit = Math.min(Math.max(1, Math.floor(topN ?? documents.length)), documents.length);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/v2/rerank`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, query, documents, top_n: limit }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new RerankError('rerank_timeout');
        throw new RerankError('rerank_failed');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) throw new RerankError('rerank_failed', response.status);

      let body;
      try {
        body = await response.json();
      } catch {
        throw new RerankError('rerank_response_invalid');
      }
      const results = (body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) throw new RerankError('rerank_response_invalid');

      const items = results.map((r) => {
        const item = r as { index?: unknown; relevance_score?: unknown };
        if (!Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= documents.length) {
          throw new RerankError('rerank_response_invalid');
        }
        if (typeof item.relevance_score !== 'number' || !Number.isFinite(item.relevance_score)) {
          throw new RerankError('rerank_response_invalid');
        }
        return { index: item.index as number, score: item.relevance_score };
      });
      return items.sort((a, b) => b.score - a.score || a.index - b.index);
    },
  };
}

/** Reorders items by rerank score. Each item keeps its original position in the input list. */
export async function rerankItems<T>(
  reranker: Reranker,
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
  topN?: number,
): Promise<Array<{ item: T; score: number }>> {
  const ranked = await reranker.rerank(query, items.map(textOf), topN);
  return ranked.map((r) => ({ item: items[r.index], score: r.score }));
}
