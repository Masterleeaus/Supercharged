/**
 * Message feed for the public widget: polling reads and the server-sent event stream.
 *
 * The realtime stream contract in server/modules/chatbot/realtime/ does not exist yet. WidgetMessageFeed.subscribe is
 * the interface this widget codes against. The owner wires it to the realtime path when that lands, and to the
 * EventPublisher otherwise. Until then, the widget polls.
 *
 * Only the public fields in WidgetFeedMessage ever leave the server. Internal ids, staff ids and notes do not.
 */

export const WIDGET_FEED_PAGE_SIZE = 50;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Who a feed belongs to. Every value is checked against the verified embed token, never the request body. */
export interface WidgetFeedScope {
  companyId: string;
  chatbotPublicId: string;
  visitorId: string;
}

export interface WidgetFeedMessage {
  id: string;
  /** Only replies reach the visitor from the feed. The visitor's own messages are shown by the widget itself. */
  role: "assistant" | "staff";
  text: string;
  /** ISO 8601 time. */
  createdAt: string;
}

export interface WidgetMessageFeed {
  /** Messages after the cursor, oldest first, at most limit. A null cursor starts at the beginning. */
  listAfter(scope: WidgetFeedScope, afterId: string | null, limit: number): Promise<WidgetFeedMessage[]>;
  /** Calls listener for each new feed message in scope. Returns the unsubscribe function. */
  subscribe(scope: WidgetFeedScope, listener: (message: WidgetFeedMessage) => void): () => void;
}

/** Keeps only the public fields. Anything else on the input is dropped. */
export function toPublicFeedMessage(input: { id: string; role: string; text: string; createdAt: Date | string }): WidgetFeedMessage | null {
  if (!EVENT_ID_PATTERN.test(input.id)) return null;
  if (input.role !== "assistant" && input.role !== "staff") return null;
  const createdAt = input.createdAt instanceof Date ? input.createdAt : new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { id: input.id, role: input.role, text: input.text, createdAt: createdAt.toISOString() };
}

/** Reads the cursor from a query string value. Anything that is not a plain id is treated as absent. */
export function readFeedCursor(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value)) return "invalid";
  return value;
}

/** One server-sent message frame. The id line lets a reconnecting client resume. */
export function formatSseMessage(message: WidgetFeedMessage): string {
  const id = EVENT_ID_PATTERN.test(message.id) ? message.id : "";
  const lines = [`event: message`];
  if (id) lines.unshift(`id: ${id}`);
  // JSON.stringify never emits a raw newline, so one data line is enough.
  lines.push(`data: ${JSON.stringify(message)}`);
  return `${lines.join("\n")}\n\n`;
}

/** Comment frame that keeps proxies from closing an idle stream. */
export const SSE_HEARTBEAT = ": keep-alive\n\n";
export const SSE_OPEN = ": open\n\n";
export const SSE_HEARTBEAT_MS = 25_000;
