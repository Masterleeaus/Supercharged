/**
 * Typed calls for the staff inbox.
 *
 * Every endpoint below is defined in server/modules/chatbot/agent-routes/agent-router.ts. The router is
 * NOT mounted yet (see DECISIONS.md). Until it is, the list returns 404 and the page shows a pending state.
 * The router also answers 404 when DESK_CHATBOT_AGENT_ROUTES is not "true", and 503 when the inbox is off.
 */
import { ApiError, apiRequest } from "@/lib/queryClient";
import type {
  AgentHandler,
  ConversationActionResult,
  ConversationThread,
  InboxPage,
  StaffReplyResult,
  TicketStatus,
} from "./types";

/** backend pending: mount. Default mount path from integration/mount.ts under /api/chatbot. */
export const AGENT_BASE = "/api/chatbot/agent";

export const INBOX_QUERY_KEY = ["chatbot", "agent", "inbox"] as const;
export const threadQueryKey = (conversationId: string) => ["chatbot", "agent", "conversation", conversationId] as const;

export interface InboxFilters {
  /** "ai" or "human". Omit for both. */
  handler?: AgentHandler;
  /** "new" or "closed". Omit for all. */
  ticketStatus?: TicketStatus;
  page: number;
  perPage: number;
}

/** Builds the query string for GET /inbox. The server rejects unknown keys, so only these four are sent. */
export function inboxQueryString(filters: InboxFilters): string {
  const params = new URLSearchParams();
  if (filters.handler) params.set("handler", filters.handler);
  if (filters.ticketStatus) params.set("status", filters.ticketStatus);
  params.set("page", String(filters.page));
  params.set("per_page", String(filters.perPage));
  return params.toString();
}

/** GET /inbox */
export async function listInbox(filters: InboxFilters): Promise<InboxPage> {
  const res = await apiRequest("GET", `${AGENT_BASE}/inbox?${inboxQueryString(filters)}`);
  return (await res.json()) as InboxPage;
}

/** GET /conversations/:id. Staff view, internal notes included. */
export async function getThread(conversationId: string): Promise<ConversationThread> {
  const res = await apiRequest("GET", `${AGENT_BASE}/conversations/${encodeURIComponent(conversationId)}`);
  return (await res.json()) as ConversationThread;
}

/** POST /conversations/:id/messages. Set isInternalNote to keep the text staff-only. */
export async function postStaffReply(
  conversationId: string,
  body: { message: string; isInternalNote: boolean },
): Promise<StaffReplyResult> {
  const res = await apiRequest("POST", `${AGENT_BASE}/conversations/${encodeURIComponent(conversationId)}/messages`, body);
  return (await res.json()) as StaffReplyResult;
}

/** POST /conversations/:id/takeover. No body. */
export async function takeOver(conversationId: string): Promise<ConversationActionResult> {
  const res = await apiRequest("POST", `${AGENT_BASE}/conversations/${encodeURIComponent(conversationId)}/takeover`);
  return (await res.json()) as ConversationActionResult;
}

/** POST /conversations/:id/handback. No body. */
export async function handBack(conversationId: string): Promise<ConversationActionResult> {
  const res = await apiRequest("POST", `${AGENT_BASE}/conversations/${encodeURIComponent(conversationId)}/handback`);
  return (await res.json()) as ConversationActionResult;
}

/** POST /conversations/:id/close. No body. Closing cannot be undone on the server. */
export async function closeTicket(conversationId: string): Promise<ConversationActionResult> {
  const res = await apiRequest("POST", `${AGENT_BASE}/conversations/${encodeURIComponent(conversationId)}/close`);
  return (await res.json()) as ConversationActionResult;
}

/**
 * True when the inbox is not available yet: the router is not mounted (404 with no router error body), or
 * the flag is off or the inbox is off (404 "Not found", 503). A missing conversation is not pending.
 */
export function isInboxPending(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 503) return true;
  if (err.status !== 404) return false;
  const body = err.data as { error?: unknown } | null;
  return !body || body.error === "Not found";
}
