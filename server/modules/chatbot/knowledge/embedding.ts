/**
 * Embedding through the ModelProvider contract. The provider is injected; this file reads no keys and calls
 * no vendor SDK. Port of OpenAIEmbedder and EmbedingService::generateEmbedding (PHP).
 *
 * Each vector is checked against the configured model and dimensions. A provider that returns a different
 * size is rejected before anything is stored, so vectors from different models are never mixed.
 */
import type { EmbedResult, ModelProvider, ModelProviderKey } from "../contracts/index.ts";
import { KnowledgeError, safeMessage } from "./errors.ts";

export interface EmbeddingModel {
  provider: ModelProviderKey;
  model: string;
  dimensions: number;
}

/** Same model as the PHP default (TEXT_EMBEDDING_3_SMALL). */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
};

export const EMBED_BATCH_SIZE = 96;

export function sameEmbeddingModel(a: EmbeddingModel, b: EmbeddingModel): boolean {
  return a.provider === b.provider && a.model === b.model && a.dimensions === b.dimensions;
}

function checkResult(result: EmbedResult, model: EmbeddingModel, expected: number): void {
  if (result.provider !== model.provider || result.model !== model.model) {
    throw new KnowledgeError("embedding_failed", "The embedding provider answered for a different model.", 502);
  }
  if (result.dimensions !== model.dimensions || result.vectors.length !== expected) {
    throw new KnowledgeError("embedding_failed", "The embedding response does not match the configured model.", 502);
  }
  for (const vector of result.vectors) {
    if (vector.length !== model.dimensions || vector.some((x) => !Number.isFinite(x))) {
      throw new KnowledgeError("embedding_failed", "An embedding vector has the wrong size or a non-numeric value.", 502);
    }
  }
}

/** Embeds inputs in batches, returning one vector per input in input order. */
export async function embedInputs(
  provider: ModelProvider,
  companyId: string,
  model: EmbeddingModel,
  inputs: readonly string[],
  timeoutMs: number,
): Promise<number[][]> {
  if (provider.key !== model.provider) {
    throw new KnowledgeError("provider_unavailable", "The embedding provider does not match the configured model.", 503);
  }
  const vectors: number[][] = [];
  for (let start = 0; start < inputs.length; start += EMBED_BATCH_SIZE) {
    const batch = inputs.slice(start, start + EMBED_BATCH_SIZE);
    let result: EmbedResult;
    try {
      result = await provider.embed(companyId, { model: model.model, inputs: [...batch], timeoutMs });
    } catch (error) {
      throw new KnowledgeError("embedding_failed", `Embedding failed: ${safeMessage(error)}`, 502);
    }
    checkResult(result, model, batch.length);
    vectors.push(...result.vectors);
  }
  return vectors;
}
