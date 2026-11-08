/**
 * Analytics dashboard: totals cards, a daily chart of new conversations and messages, and top lists.
 * Data comes from GET /api/chatbot/content/analytics (the ops analytics port). Top agents has no metric yet,
 * so it shows a pending state. A 501 from the backend shows a pending state for the whole chart and cards.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { analyticsKey, getAnalytics, isPending, type AnalyticsParams } from "./api";
import type { AnalyticsMetric, AnalyticsResponse } from "./types";
import { EmptyState, ErrorState, LoadingRows, PendingState } from "./shared";

const TOTAL_METRICS: AnalyticsMetric[] = [
  "conversations",
  "messages",
  "handoffs",
  "resolved_by_ai",
  "avg_first_response_seconds",
];

const CARD_LABELS: Record<string, string> = {
  conversations: "Conversations",
  messages: "Messages",
  handoffs: "Handed to a person",
  resolved_by_ai: "Resolved by AI",
  avg_first_response_seconds: "Average first reply",
};

const chartConfig = {
  conversations: { label: "New conversations", color: "hsl(var(--chart-1))" },
  messages: { label: "Messages", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Seconds as "45s" or "3m 10s". */
export function formatSeconds(total: number | undefined): string {
  if (total === undefined || !Number.isFinite(total)) return "No data";
  const s = Math.round(total);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 86_400_000);
  return { from: isoDay(from), to: isoDay(to) };
}

export default function AnalyticsPage() {
  const [range, setRange] = useState(defaultRange);

  const totalsParams: AnalyticsParams = { from: range.from, to: range.to, metrics: TOTAL_METRICS };
  const seriesParams: AnalyticsParams = { from: range.from, to: range.to, groupBy: "day", metrics: ["conversations", "messages"] };
  const channelParams: AnalyticsParams = { from: range.from, to: range.to, groupBy: "channel", metrics: ["conversations"] };

  const totals = useQuery<AnalyticsResponse>({
    queryKey: analyticsKey(totalsParams),
    queryFn: () => getAnalytics(totalsParams),
    retry: false,
  });
  const series = useQuery<AnalyticsResponse>({
    queryKey: analyticsKey(seriesParams),
    queryFn: () => getAnalytics(seriesParams),
    retry: false,
  });
  const channels = useQuery<AnalyticsResponse>({
    queryKey: analyticsKey(channelParams),
    queryFn: () => getAnalytics(channelParams),
    retry: false,
  });

  const chartData = useMemo(
    () =>
      (series.data?.rows ?? []).map((row) => ({
        day: row.bucket ?? "",
        conversations: row.values.conversations ?? 0,
        messages: row.values.messages ?? 0,
      })),
    [series.data],
  );

  const topChannels = useMemo(
    () =>
      (channels.data?.rows ?? [])
        .map((row) => ({ name: row.bucket ?? "Unknown", count: row.values.conversations ?? 0 }))
        .sort((a, b) => b.count - a.count),
    [channels.data],
  );

  const totalsRow = totals.data?.rows[0]?.values;
  const anyPending = isPending(totals.error) || isPending(series.error) || isPending(channels.error);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-sm text-muted-foreground">Conversations, replies and handoffs for your chatbots.</p>
        </div>
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="analytics-from">From</Label>
            <Input
              id="analytics-from"
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="analytics-to">To</Label>
            <Input
              id="analytics-to"
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
        </div>
      </div>

      {anyPending ? (
        <PendingState title="Analytics is not connected yet">
          The analytics service is not mounted on this server. Totals, the chart and top lists will show here once it is.
        </PendingState>
      ) : totals.error ? (
        <ErrorState message="The totals could not be loaded. Try a different date range." />
      ) : totals.isLoading ? (
        <LoadingRows count={2} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {TOTAL_METRICS.map((metric) => (
            <Card key={metric}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{CARD_LABELS[metric]}</p>
                <p className="mt-1 text-2xl font-semibold" data-testid={`stat-${metric}`}>
                  {metric === "avg_first_response_seconds"
                    ? formatSeconds(totalsRow?.[metric])
                    : (totalsRow?.[metric] ?? 0).toLocaleString()}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!anyPending && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New conversations and messages per day</CardTitle>
          </CardHeader>
          <CardContent>
            {series.error && !isPending(series.error) ? (
              <ErrorState message="The chart could not be loaded." />
            ) : series.isLoading ? (
              <LoadingRows />
            ) : chartData.length === 0 ? (
              <EmptyState title="No activity in this range" />
            ) : (
              <ChartContainer config={chartConfig} className="h-72 w-full">
                <LineChart data={chartData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="conversations" stroke="var(--color-conversations)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="messages" stroke="var(--color-messages)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      )}

      {!anyPending && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top channels</CardTitle>
            </CardHeader>
            <CardContent>
              {channels.isLoading ? (
                <LoadingRows count={2} />
              ) : topChannels.length === 0 ? (
                <EmptyState title="No channel activity in this range" />
              ) : (
                <ol className="space-y-2">
                  {topChannels.map((c) => (
                    <li key={c.name} className="flex justify-between text-sm">
                      <span className="capitalize">{c.name}</span>
                      <span className="font-medium">{c.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top agents</CardTitle>
            </CardHeader>
            <CardContent>
              <PendingState title="Not available yet">
                Agent ranking needs a per-agent metric from the analytics service, which it does not have yet.
              </PendingState>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
