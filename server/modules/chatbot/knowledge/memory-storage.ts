/**
 * In-memory KnowledgeStorage and candidate reader. Used by the service tests and as the reference for the
 * rules the Drizzle storage must keep: company scoping, unique source uri per chatbot and kind, atomic chunk
 * replacement, and delete-cascade of chunks and embeddings.
 */
import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_SOURCE_STATUSES,
  type Embedding,
  type KnowledgeChunk,
  type KnowledgeSource,
  type KnowledgeSourceStatus,
  type KnowledgeStorage,
  type NewKnowledgeSource,
} from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import { chunkIdFor } from "./chunking.ts";
import { type EmbeddingModel } from "./embedding.ts";
import { KnowledgeError } from "./errors.ts";
import { type EmbeddedCandidate, type KnowledgeCandidateReader } from "./retriever.ts";

interface TenantBucket {
  sources: Map<string, KnowledgeSource>;
  chunks: Map<string, KnowledgeChunk>;
  /** Keyed by chunkId, provider, model. */
  embeddings: Map<string, Embedding>;
}

export interface MemoryKnowledgeStorage extends KnowledgeStorage, KnowledgeCandidateReader {}

function embeddingKey(chunkId: string, provider: string, model: string): string {
  return `${chunkId}\u001f${provider}\u001f${model}`;
}

function assertKind(kind: string): asserts kind is KnowledgeSource["kind"] {
  if (!(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new KnowledgeError("invalid_input", "Unknown knowledge source kind.");
  }
}

function assertStatus(status: string): asserts status is KnowledgeSourceStatus {
  if (!(KNOWLEDGE_SOURCE_STATUSES as readonly string[]).includes(status)) {
    throw new KnowledgeError("invalid_input", "Unknown knowledge source status.");
  }
}

export function createMemoryKnowledgeStorage(): MemoryKnowledgeStorage {
  const tenants = new Map<string, TenantBucket>();

  function bucket(companyId: string): TenantBucket {
    const tenant = requireCompanyId(companyId);
    let rows = tenants.get(tenant);
    if (!rows) {
      rows = { sources: new Map(), chunks: new Map(), embeddings: new Map() };
      tenants.set(tenant, rows);
    }
    return rows;
  }

  function removeSourceRows(rows: TenantBucket, sourceId: string): void {
    for (const chunk of [...rows.chunks.values()]) {
      if (chunk.sourceId !== sourceId) continue;
      for (const key of [...rows.embeddings.keys()]) {
        if (key.startsWith(`${chunk.id}\u001f`)) rows.embeddings.delete(key);
      }
      rows.chunks.delete(chunk.id);
    }
  }

  return {
    async insertSource(companyId: string, input: NewKnowledgeSource): Promise<KnowledgeSource> {
      const rows = bucket(companyId);
      assertKind(input.kind);
      if (!input.chatbotId) throw new KnowledgeError("invalid_input", "chatbotId is required.");
      if (input.uri !== null) {
        for (const existing of rows.sources.values()) {
          if (existing.chatbotId === input.chatbotId && existing.kind === input.kind && existing.uri === input.uri) {
            throw new KnowledgeError("conflict", "A source with this address already exists.", 409);
          }
        }
      }
      const now = new Date();
      const source: KnowledgeSource = {
        id: randomUUID(),
        companyId,
        chatbotId: input.chatbotId,
        kind: input.kind,
        title: input.title,
        uri: input.uri,
        status: "pending",
        contentHash: null,
        lastIndexedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.sources.set(source.id, source);
      return { ...source };
    },

    async getSource(companyId: string, sourceId: string): Promise<KnowledgeSource | null> {
      const source = bucket(companyId).sources.get(sourceId);
      return source ? { ...source } : null;
    },

    async listSources(companyId: string, chatbotId: string): Promise<KnowledgeSource[]> {
      return [...bucket(companyId).sources.values()]
        .filter((s) => s.chatbotId === chatbotId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((s) => ({ ...s }));
    },

    async setSourceStatus(companyId, sourceId, status, detail) {
      const rows = bucket(companyId);
      assertStatus(status);
      const source = rows.sources.get(sourceId);
      if (!source) return null;
      const updated: KnowledgeSource = {
        ...source,
        status,
        contentHash: detail.contentHash ?? source.contentHash,
        lastError: detail.lastError !== undefined ? detail.lastError : source.lastError,
        lastIndexedAt: detail.lastIndexedAt ?? source.lastIndexedAt,
        updatedAt: new Date(),
      };
      rows.sources.set(sourceId, updated);
      return { ...updated };
    },

    async replaceChunks(companyId, sourceId, chunks, embeddings): Promise<number> {
      const rows = bucket(companyId);
      const source = rows.sources.get(sourceId);
      if (!source) return 0;

      // Validate everything before the first write, so a bad input leaves the old chunks in place.
      const ids = new Set<string>();
      const built: KnowledgeChunk[] = chunks.map((c) => {
        if (c.companyId !== companyId || c.sourceId !== sourceId || c.chatbotId !== source.chatbotId) {
          throw new KnowledgeError("write_failed", "A chunk does not belong to this source.");
        }
        const id = chunkIdFor(sourceId, c.ordinal, c.contentHash);
        ids.add(id);
        return { ...c, id, createdAt: new Date() };
      });
      for (const e of embeddings) {
        if (e.companyId !== companyId || !ids.has(e.chunkId)) {
          throw new KnowledgeError("write_failed", "An embedding does not match a chunk of this source.");
        }
        if (e.vector.length !== e.dimensions) {
          throw new KnowledgeError("write_failed", "An embedding length does not match its dimensions.");
        }
      }

      removeSourceRows(rows, sourceId);
      for (const chunk of built) rows.chunks.set(chunk.id, chunk);
      const now = new Date();
      for (const e of embeddings) {
        rows.embeddings.set(embeddingKey(e.chunkId, e.provider, e.model), { ...e, createdAt: now });
      }
      return built.length;
    },

    async deleteSource(companyId, sourceId): Promise<boolean> {
      const rows = bucket(companyId);
      if (!rows.sources.has(sourceId)) return false;
      removeSourceRows(rows, sourceId);
      rows.sources.delete(sourceId);
      return true;
    },

    async listCandidates(companyId, chatbotId, model: EmbeddingModel, sourceIds): Promise<EmbeddedCandidate[]> {
      const rows = bucket(companyId);
      const allowed = sourceIds ? new Set(sourceIds) : null;
      const out: EmbeddedCandidate[] = [];
      for (const chunk of rows.chunks.values()) {
        if (chunk.chatbotId !== chatbotId) continue;
        if (allowed && !allowed.has(chunk.sourceId)) continue;
        const source = rows.sources.get(chunk.sourceId);
        if (!source || source.status !== "ready") continue;
        const emb = rows.embeddings.get(embeddingKey(chunk.id, model.provider, model.model));
        if (!emb || emb.dimensions !== model.dimensions) continue;
        out.push({
          companyId,
          chunkId: chunk.id,
          sourceId: chunk.sourceId,
          sourceTitle: source.title,
          ordinal: chunk.ordinal,
          text: chunk.text,
          vector: [...emb.vector],
        });
      }
      return out;
    },
  };
}
