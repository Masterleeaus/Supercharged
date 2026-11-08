/**
 * Typed calls for the content admin screens (canned responses, knowledge-base articles, contacts, analytics).
 * Every request goes through apiRequest from lib/queryClient, so the auth header and token refresh are the same
 * as the rest of Desk. No provider keys or secrets are used here.
 *
 * Backend: server/modules/chatbot/content-admin/router.ts, mounted under /api/chatbot by the owner.
 * Until it is mounted, these calls answer 404. Analytics and contacts answer 501 when their ports are not injected;
 * the screens show a pending state for 501 (see isPending).
 */
import { ApiError, apiRequest } from "@/lib/queryClient";
import type {
  AnalyticsMetric,
  AnalyticsResponse,
  ArticleFormBody,
  CannedResponse,
  Contact,
  KnowledgeBaseArticle,
} from "./types";

const CONTENT_BASE = "/api/chatbot/content";

export const cannedResponsesKey = ["chatbot", "content", "canned-responses"] as const;
export const articlesKey = ["chatbot", "content", "knowledge-base-articles"] as const;
export const contactsKey = ["chatbot", "content", "contacts"] as const;
export const analyticsKey = (params: AnalyticsParams) => ["chatbot", "content", "analytics", params] as const;

export interface CannedResponseBody {
  title: string;
  content: string;
}

/** Canned responses: list, create, edit, delete. */
export async function listCannedResponses(): Promise<CannedResponse[]> {
  const res = await apiRequest("GET", `${CONTENT_BASE}/canned-responses`);
  return (await res.json()) as CannedResponse[];
}

export async function createCannedResponse(body: CannedResponseBody): Promise<CannedResponse> {
  const res = await apiRequest("POST", `${CONTENT_BASE}/canned-responses`, body);
  return (await res.json()) as CannedResponse;
}

export async function updateCannedResponse(id: string, body: Partial<CannedResponseBody>): Promise<CannedResponse> {
  const res = await apiRequest("PATCH", `${CONTENT_BASE}/canned-responses/${encodeURIComponent(id)}`, body);
  return (await res.json()) as CannedResponse;
}

export async function deleteCannedResponse(id: string): Promise<void> {
  await apiRequest("DELETE", `${CONTENT_BASE}/canned-responses/${encodeURIComponent(id)}`);
}

/** Knowledge-base articles: list, create, edit, delete. */
export async function listArticles(): Promise<KnowledgeBaseArticle[]> {
  const res = await apiRequest("GET", `${CONTENT_BASE}/knowledge-base-articles`);
  return (await res.json()) as KnowledgeBaseArticle[];
}

export async function createArticle(body: ArticleFormBody): Promise<KnowledgeBaseArticle> {
  const res = await apiRequest("POST", `${CONTENT_BASE}/knowledge-base-articles`, body);
  return (await res.json()) as KnowledgeBaseArticle;
}

export async function updateArticle(id: string, body: Partial<ArticleFormBody>): Promise<KnowledgeBaseArticle> {
  const res = await apiRequest("PATCH", `${CONTENT_BASE}/knowledge-base-articles/${encodeURIComponent(id)}`, body);
  return (await res.json()) as KnowledgeBaseArticle;
}

export async function deleteArticle(id: string): Promise<void> {
  await apiRequest("DELETE", `${CONTENT_BASE}/knowledge-base-articles/${encodeURIComponent(id)}`);
}

/** Contacts (chatbot customers), read only. Answers 501 until the reader is mounted. */
export async function listContacts(): Promise<Contact[]> {
  const res = await apiRequest("GET", `${CONTENT_BASE}/contacts`);
  return (await res.json()) as Contact[];
}

export async function getContact(id: string): Promise<Contact> {
  const res = await apiRequest("GET", `${CONTENT_BASE}/contacts/${encodeURIComponent(id)}`);
  return (await res.json()) as Contact;
}

export interface AnalyticsParams {
  from: string;
  to: string;
  groupBy?: "day" | "week" | "channel" | "chatbot";
  metrics: AnalyticsMetric[];
  chatbotId?: string;
}

/** Analytics read view. Data comes from the ops analytics port on the backend, never from the browser. */
export async function getAnalytics(params: AnalyticsParams): Promise<AnalyticsResponse> {
  const search = new URLSearchParams({ from: params.from, to: params.to, metrics: params.metrics.join(",") });
  if (params.groupBy) search.set("groupBy", params.groupBy);
  if (params.chatbotId) search.set("chatbotId", params.chatbotId);
  const res = await apiRequest("GET", `${CONTENT_BASE}/analytics?${search.toString()}`);
  return (await res.json()) as AnalyticsResponse;
}

/**
 * True when the content router is not mounted on this server. The router's own flag-off answer is a 404 with
 * { error: "Not found" }, and Express's default 404 has no JSON error. A row-level 404 carries a specific message
 * such as "Article not found", and that is a real error, not a missing endpoint.
 */
export function isNotMounted(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false;
  const message = (error.data as { error?: unknown } | null)?.error;
  return typeof message !== "string" || message === "Not found";
}

/** True when the endpoint is not mounted (404) or its port is not injected (501). Screens show a pending state. */
export function isPending(error: unknown): boolean {
  return isNotMounted(error) || (error instanceof ApiError && error.status === 501);
}

export const chatbotOptionsKey = ["chatbot", "chatbots"] as const;

/** The company's chatbots, from the mounted GET /api/chatbot/chatbots. Used for the article link checkboxes. */
export async function listChatbotOptions(): Promise<{ id: string; title: string }[]> {
  const res = await apiRequest("GET", "/api/chatbot/chatbots");
  const rows = (await res.json()) as { id: string; title: string }[];
  return rows.map((row) => ({ id: row.id, title: row.title }));
}

/** First readable message from an error. Uses the first zod issue for 400s. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = (error.data as { issues?: { message?: string; path?: unknown[] }[] } | null)?.issues;
    if (error.status === 400 && issues?.length) {
      const first = issues[0];
      const field = Array.isArray(first.path) && first.path.length ? `${first.path.join(".")}: ` : "";
      return `${field}${first.message ?? "Invalid input"}`;
    }
    return error.message || `Request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : "Something went wrong";
}
