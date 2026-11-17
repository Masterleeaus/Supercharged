/**
 * Types for canned responses, knowledge-base articles, the contacts read view and the analytics read view.
 * Every storage method takes companyId first. A row from another company is treated as absent.
 *
 * Canned responses and articles are owned by this module. The knowledge agent reads articles through
 * KnowledgeStorage (contracts/knowledge.ts) and does not own the table.
 */
import type { AnalyticsMetric, AnalyticsQueryPort, AnalyticsRow } from "../contracts/index.ts";

export interface CannedResponse {
  id: string;
  companyId: string;
  userId: string | null;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCannedResponse {
  title: string;
  content: string;
}

export interface KnowledgeBaseArticle {
  id: string;
  companyId: string;
  userId: string | null;
  title: string;
  description: string;
  content: string | null;
  isFeatured: boolean;
  /** Chatbots this article is linked to, in insertion order. */
  chatbotIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewKnowledgeBaseArticle {
  title: string;
  description: string;
  content: string | null;
  isFeatured: boolean;
  chatbotIds: string[];
}

export type ArticlePatch = Partial<NewKnowledgeBaseArticle>;
export type CannedResponsePatch = Partial<NewCannedResponse>;

/** Contacts are the chatbot customers. Read-only here; the customers slice owns writes. */
export interface ContactSummary {
  id: string;
  companyId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  chatbotId: string | null;
  chatbotChannel: string | null;
  preferredLanguage: string | null;
  createdAt: Date;
}

export interface ContactReader {
  listContacts(companyId: string): Promise<ContactSummary[]>;
  findContact(companyId: string, id: string): Promise<ContactSummary | null>;
}

export interface ContentAdminStorage {
  listCannedResponses(companyId: string): Promise<CannedResponse[]>;
  findCannedResponse(companyId: string, id: string): Promise<CannedResponse | null>;
  insertCannedResponse(companyId: string, input: NewCannedResponse, userId: string | null, now: Date): Promise<CannedResponse>;
  updateCannedResponse(companyId: string, id: string, patch: CannedResponsePatch, now: Date): Promise<CannedResponse | null>;
  /** Returns false when the row is absent or belongs to another company. */
  deleteCannedResponse(companyId: string, id: string): Promise<boolean>;

  listArticles(companyId: string): Promise<KnowledgeBaseArticle[]>;
  findArticle(companyId: string, id: string): Promise<KnowledgeBaseArticle | null>;
  /** Returns the subset of chatbotIds that exist in companyId. Used to refuse links to other companies. */
  filterOwnChatbotIds(companyId: string, chatbotIds: string[]): Promise<string[]>;
  insertArticle(companyId: string, input: NewKnowledgeBaseArticle, userId: string | null, now: Date): Promise<KnowledgeBaseArticle>;
  updateArticle(companyId: string, id: string, patch: ArticlePatch, now: Date): Promise<KnowledgeBaseArticle | null>;
  deleteArticle(companyId: string, id: string): Promise<boolean>;
}

/** Ops analytics, through the runtime port. Injected by the caller. When absent, the route answers 501. */
export type ContentAnalyticsPort = AnalyticsQueryPort;
export type { AnalyticsMetric, AnalyticsRow };
