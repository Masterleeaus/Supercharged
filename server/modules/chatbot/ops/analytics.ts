/**
 * Chatbot analytics. Port of ChatbotAnalyticsService.php, computed in app code from stored rows.
 *
 * The PHP counted with SQL and per-row loops. This port loads one company's rows for a date range through an
 * injected AnalyticsSource, then aggregates in memory. A row whose companyId differs from the argument is ignored.
 *
 * Range: from is inclusive, to is exclusive. Buckets are UTC days or ISO weeks (Monday start).
 */
import { ANALYTICS_METRICS } from "../contracts/index.ts";
import type { AnalyticsMetric, AnalyticsQuery, AnalyticsQueryPort, AnalyticsRow } from "../contracts/index.ts";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";

/** Same 1-hour cut-off as averageResponseTime() in the PHP. Slower first replies are treated as abandoned. */
export const FIRST_RESPONSE_MAX_SECONDS = 3600;
export const ANALYTICS_MAX_RANGE_DAYS = 366;
export const TOP_LIST_DEFAULT_LIMIT = 5;
export const TOP_LIST_MAX_LIMIT = 10;

export interface AnalyticsConversation {
  id: string;
  companyId: string;
  chatbotId: string;
  channel: string;
  createdAt: Date;
  connectAgentAt: Date | null;
  ticketStatus: string;
}

export interface AnalyticsMessage {
  id: string;
  companyId: string;
  conversationId: string;
  role: string;
  isInternalNote: boolean;
  createdAt: Date;
}

export interface AnalyticsWindow {
  conversations: AnalyticsConversation[];
  messages: AnalyticsMessage[];
  /** Optional. Booking and order counts come from other slices. When absent, those metrics are left out. */
  bookingsCreatedAt?: Date[];
  ordersPlacedAt?: Date[];
  /**
   * Company-tagged variants of the two lists above. The aggregation drops any row whose companyId differs from
   * the argument, so a source that returns another company's rows cannot change the counts. The Drizzle source
   * fills these.
   */
  bookingRows?: { companyId: string; createdAt: Date }[];
  orderRows?: { companyId: string; placedAt: Date }[];
}

export interface AnalyticsSource {
  /** Must return only rows for companyId whose timestamps fall in [from, to). */
  load(companyId: string, from: Date, to: Date): Promise<AnalyticsWindow>;
}

export interface TopEntry {
  key: string;
  count: number;
}

type Attributes = { channel: string; chatbotId: string } | null;

function inRange(date: Date, from: Date, to: Date): boolean {
  const time = date.getTime();
  return time >= from.getTime() && time < to.getTime();
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Monday of the ISO week that contains date, as YYYY-MM-DD (UTC). */
function isoWeekStart(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return isoDay(day);
}

function bucketFor(date: Date, groupBy: AnalyticsQuery["groupBy"], attributes: Attributes): string | null {
  switch (groupBy) {
    case null:
      return null;
    case "day":
      return isoDay(date);
    case "week":
      return isoWeekStart(date);
    case "channel":
      return attributes ? attributes.channel : null;
    case "chatbot":
      return attributes ? attributes.chatbotId : null;
  }
}

function assertQuery(query: AnalyticsQuery): void {
  if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
    throw new ChatbotError("At least one metric is required.", 400);
  }
  for (const metric of query.metrics) {
    if (!(ANALYTICS_METRICS as readonly string[]).includes(metric)) {
      throw new ChatbotError("Unknown analytics metric.", 400);
    }
  }
  if (!(query.from instanceof Date) || !(query.to instanceof Date) || Number.isNaN(query.from.getTime()) || Number.isNaN(query.to.getTime())) {
    throw new ChatbotError("from and to must be valid dates.", 400);
  }
  if (query.from.getTime() >= query.to.getTime()) {
    throw new ChatbotError("from must be before to.", 400);
  }
  const days = (query.to.getTime() - query.from.getTime()) / 86_400_000;
  if (days > ANALYTICS_MAX_RANGE_DAYS) {
    throw new ChatbotError(`The date range may not exceed ${ANALYTICS_MAX_RANGE_DAYS} days.`, 400);
  }
}

/** Pure aggregation. Exported so the rules can be tested without a source. */
export function summariseWindow(
  companyId: string,
  window: AnalyticsWindow,
  query: AnalyticsQuery,
): AnalyticsRow[] {
  const { from, to, groupBy } = query;
  const conversations = window.conversations.filter(
    (row) => row.companyId === companyId && (!query.chatbotId || row.chatbotId === query.chatbotId),
  );
  const byId = new Map(conversations.map((row) => [row.id, row]));
  const attributesOf = (conversationId: string): Attributes => {
    const row = byId.get(conversationId);
    return row ? { channel: row.channel, chatbotId: row.chatbotId } : null;
  };
  const conversationAttributes = (row: AnalyticsConversation): Attributes => ({
    channel: row.channel,
    chatbotId: row.chatbotId,
  });
  // Booking and order rows carry no channel or chatbot id. They are left out when grouping by either,
  // and when a single chatbot is requested, because counting them would mix in other chatbots.
  const omitsCounts = groupBy === "channel" || groupBy === "chatbot" || query.chatbotId !== undefined;

  type Event = { bucket: string; value: number };
  const events: Partial<Record<AnalyticsMetric, Event[]>> = {};
  const push = (metric: AnalyticsMetric, event: Event) => {
    (events[metric] ??= []).push(event);
  };

  for (const row of conversations) {
    if (inRange(row.createdAt, from, to)) {
      const bucket = bucketFor(row.createdAt, groupBy, conversationAttributes(row)) ?? "";
      push("conversations", { bucket, value: 1 });
      if (row.connectAgentAt === null && row.ticketStatus === "closed") {
        push("resolved_by_ai", { bucket, value: 1 });
      }
    }
    if (row.connectAgentAt && inRange(row.connectAgentAt, from, to)) {
      push("handoffs", { bucket: bucketFor(row.connectAgentAt, groupBy, conversationAttributes(row)) ?? "", value: 1 });
    }
  }

  const visibleMessages = window.messages.filter(
    (row) => row.companyId === companyId && byId.has(row.conversationId) && !row.isInternalNote && inRange(row.createdAt, from, to),
  );
  for (const message of visibleMessages) {
    const attributes = attributesOf(message.conversationId);
    push("messages", { bucket: bucketFor(message.createdAt, groupBy, attributes) ?? "", value: 1 });
  }

  // First response: for each handoff in range, the first assistant message after connect_agent_at.
  for (const row of conversations) {
    if (!row.connectAgentAt || !inRange(row.connectAgentAt, from, to)) continue;
    const connectedAt = row.connectAgentAt.getTime();
    const firstReply = visibleMessages
      .filter((message) => message.conversationId === row.id && message.role === "assistant" && message.createdAt.getTime() > connectedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!firstReply) continue;
    const seconds = Math.floor((firstReply.createdAt.getTime() - connectedAt) / 1000);
    if (seconds > FIRST_RESPONSE_MAX_SECONDS) continue;
    push("avg_first_response_seconds", {
      bucket: bucketFor(row.connectAgentAt, groupBy, conversationAttributes(row)) ?? "",
      value: seconds,
    });
  }

  if (!omitsCounts) {
    const bookingDates = [
      ...(window.bookingsCreatedAt ?? []),
      ...(window.bookingRows ?? []).filter((row) => row.companyId === companyId).map((row) => row.createdAt),
    ];
    const orderDates = [
      ...(window.ordersPlacedAt ?? []),
      ...(window.orderRows ?? []).filter((row) => row.companyId === companyId).map((row) => row.placedAt),
    ];
    for (const date of bookingDates) {
      if (inRange(date, from, to)) push("bookings_created", { bucket: bucketFor(date, groupBy, null) ?? "", value: 1 });
    }
    for (const date of orderDates) {
      if (inRange(date, from, to)) push("orders_placed", { bucket: bucketFor(date, groupBy, null) ?? "", value: 1 });
    }
  }

  const metrics = [...new Set(query.metrics)];
  const buckets = new Set<string>();
  for (const metric of metrics) {
    for (const event of events[metric] ?? []) buckets.add(event.bucket);
  }
  if (groupBy === null) buckets.add("");
  const sortedBuckets = [...buckets].sort();

  return sortedBuckets.map((bucket) => {
    const values: Partial<Record<AnalyticsMetric, number>> = {};
    for (const metric of metrics) {
      if ((metric === "bookings_created" || metric === "orders_placed") && omitsCounts) continue;
      const hits = (events[metric] ?? []).filter((event) => event.bucket === bucket);
      if (metric === "avg_first_response_seconds") {
        if (hits.length > 0) {
          values[metric] = Math.round(hits.reduce((sum, event) => sum + event.value, 0) / hits.length);
        }
        continue;
      }
      values[metric] = hits.length;
    }
    return { bucket: groupBy === null ? null : bucket, values };
  });
}

/** Top conversation counts for one company and range, sorted by count descending then key ascending. */
export function topConversationCounts(
  companyId: string,
  window: AnalyticsWindow,
  from: Date,
  to: Date,
  field: "channel" | "chatbotId",
  limit: number,
): TopEntry[] {
  const counts = new Map<string, number>();
  for (const row of window.conversations) {
    if (row.companyId !== companyId || !inRange(row.createdAt, from, to)) continue;
    counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
  }
  const size = Math.min(TOP_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, size);
}

export class ChatbotAnalytics implements AnalyticsQueryPort {
  private readonly source: AnalyticsSource;

  constructor(source: AnalyticsSource) {
    this.source = source;
  }

  async run(companyId: string, query: AnalyticsQuery): Promise<AnalyticsRow[]> {
    const cid = requireCompanyId(companyId);
    assertQuery(query);
    const window = await this.source.load(cid, query.from, query.to);
    return summariseWindow(cid, window, query);
  }

  async topChannels(companyId: string, from: Date, to: Date, limit = TOP_LIST_DEFAULT_LIMIT): Promise<TopEntry[]> {
    const cid = requireCompanyId(companyId);
    const window = await this.source.load(cid, from, to);
    return topConversationCounts(cid, window, from, to, "channel", limit);
  }

  async topChatbots(companyId: string, from: Date, to: Date, limit = TOP_LIST_DEFAULT_LIMIT): Promise<TopEntry[]> {
    const cid = requireCompanyId(companyId);
    const window = await this.source.load(cid, from, to);
    return topConversationCounts(cid, window, from, to, "chatbotId", limit);
  }
}
