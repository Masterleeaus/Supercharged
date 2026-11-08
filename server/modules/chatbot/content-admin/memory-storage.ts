/**
 * In-memory ContentAdminStorage for tests and local runs. Company buckets are keyed by companyId, so a lookup
 * under another company never finds a row. Stored records are copied on the way in and out.
 */
import { randomUUID } from "node:crypto";
import type {
  ArticlePatch,
  CannedResponse,
  CannedResponsePatch,
  ContentAdminStorage,
  KnowledgeBaseArticle,
  NewCannedResponse,
  NewKnowledgeBaseArticle,
} from "./types.ts";

interface Bucket {
  canned: Map<string, CannedResponse>;
  articles: Map<string, KnowledgeBaseArticle>;
}

export interface MemoryStorageOptions {
  /** companyId -> chatbot ids that exist in that company. Stands in for the chatbots table. */
  chatbots?: Record<string, string[]>;
}

const copy = <T>(value: T): T => structuredClone(value);

export function createMemoryContentAdminStorage(options: MemoryStorageOptions = {}): ContentAdminStorage {
  const buckets = new Map<string, Bucket>();
  const chatbotIndex = new Map<string, Set<string>>(
    Object.entries(options.chatbots ?? {}).map(([companyId, ids]) => [companyId, new Set(ids)]),
  );

  const bucket = (companyId: string): Bucket => {
    let found = buckets.get(companyId);
    if (!found) {
      found = { canned: new Map(), articles: new Map() };
      buckets.set(companyId, found);
    }
    return found;
  };

  const sortByTitle = <T extends { title: string; id: string }>(rows: T[]): T[] =>
    rows.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  return {
    async listCannedResponses(companyId) {
      return copy(sortByTitle([...bucket(companyId).canned.values()]));
    },
    async findCannedResponse(companyId, id) {
      const row = bucket(companyId).canned.get(id);
      return row ? copy(row) : null;
    },
    async insertCannedResponse(companyId, input: NewCannedResponse, userId, now) {
      const row: CannedResponse = {
        id: randomUUID(),
        companyId,
        userId,
        title: input.title,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      };
      bucket(companyId).canned.set(row.id, row);
      return copy(row);
    },
    async updateCannedResponse(companyId, id, patch: CannedResponsePatch, now) {
      const b = bucket(companyId);
      const current = b.canned.get(id);
      if (!current) return null;
      const next: CannedResponse = { ...current, ...patch, updatedAt: now };
      b.canned.set(id, next);
      return copy(next);
    },
    async deleteCannedResponse(companyId, id) {
      return bucket(companyId).canned.delete(id);
    },

    async listArticles(companyId) {
      return copy(sortByTitle([...bucket(companyId).articles.values()]));
    },
    async findArticle(companyId, id) {
      const row = bucket(companyId).articles.get(id);
      return row ? copy(row) : null;
    },
    async filterOwnChatbotIds(companyId, chatbotIds) {
      const known = chatbotIndex.get(companyId);
      return known ? chatbotIds.filter((id) => known.has(id)) : [];
    },
    async insertArticle(companyId, input: NewKnowledgeBaseArticle, userId, now) {
      const row: KnowledgeBaseArticle = {
        id: randomUUID(),
        companyId,
        userId,
        title: input.title,
        description: input.description,
        content: input.content,
        isFeatured: input.isFeatured,
        chatbotIds: [...input.chatbotIds],
        createdAt: now,
        updatedAt: now,
      };
      bucket(companyId).articles.set(row.id, row);
      return copy(row);
    },
    async updateArticle(companyId, id, patch: ArticlePatch, now) {
      const b = bucket(companyId);
      const current = b.articles.get(id);
      if (!current) return null;
      const next: KnowledgeBaseArticle = {
        ...current,
        ...patch,
        chatbotIds: patch.chatbotIds ? [...patch.chatbotIds] : current.chatbotIds,
        updatedAt: now,
      };
      b.articles.set(id, next);
      return copy(next);
    },
    async deleteArticle(companyId, id) {
      return bucket(companyId).articles.delete(id);
    },
  };
}
