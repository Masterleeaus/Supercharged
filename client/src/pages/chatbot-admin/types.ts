/**
 * Wire types for the content admin screens. Names match the JSON the backend sends
 * (server/modules/chatbot/content-admin/router.ts). Dates arrive as ISO strings.
 */

export interface CannedResponse {
  id: string;
  companyId: string;
  userId: string | null;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseArticle {
  id: string;
  companyId: string;
  userId: string | null;
  title: string;
  description: string;
  content: string | null;
  isFeatured: boolean;
  chatbotIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ArticleFormBody {
  title: string;
  description: string;
  content: string | null;
  isFeatured: boolean;
  chatbotIds: string[];
}

export interface Contact {
  id: string;
  companyId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  chatbotId: string | null;
  chatbotChannel: string | null;
  preferredLanguage: string | null;
  createdAt: string;
}

/** Metrics the ops analytics port knows. Must match ANALYTICS_METRICS in contracts/runtime.ts. */
export type AnalyticsMetric =
  | "conversations"
  | "messages"
  | "handoffs"
  | "resolved_by_ai"
  | "avg_first_response_seconds"
  | "bookings_created"
  | "orders_placed";

export interface AnalyticsRow {
  bucket: string | null;
  values: Partial<Record<AnalyticsMetric, number>>;
}

export interface AnalyticsResponse {
  from: string;
  to: string;
  groupBy: "day" | "week" | "channel" | "chatbot" | null;
  rows: AnalyticsRow[];
}
