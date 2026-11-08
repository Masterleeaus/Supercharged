/**
 * Read-only run history list.
 *
 * Reads GET /api/workforce/activity through apiRequest and lists each item with
 * its title, detail, time and kind. No buttons, no swipe, no writes.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  kindLabel,
  sortRunHistory,
  toRunHistoryItems,
  type RunHistoryItem,
} from "./run-history-logic";

// Distinct from the activity panel's key, which caches a different response shape.
const RUN_HISTORY_KEY = ["run-history", "/api/workforce/activity"] as const;

async function fetchRunHistory(): Promise<RunHistoryItem[]> {
  const res = await apiRequest("GET", "/api/workforce/activity");
  if (!res.ok) throw new Error(`Run history unavailable (HTTP ${res.status}).`);
  const body = (await res.json()) as { items?: unknown };
  return sortRunHistory(toRunHistoryItems(body.items));
}

function formatTime(createdAt: string | null): string {
  if (createdAt === null) return "Time unknown";
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "Time unknown" : date.toLocaleString();
}

export function RunHistory() {
  const query = useQuery({
    queryKey: RUN_HISTORY_KEY,
    queryFn: fetchRunHistory,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading run history...
      </p>
    );
  }

  if (query.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Run history could not be read."}
      </p>
    );
  }

  const items = query.data ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <section data-testid="run-history" className="space-y-2">
      <h2 className="text-base font-semibold">Run history</h2>
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.id} className="py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{item.title}</span>
              <span className="text-xs uppercase text-muted-foreground">{kindLabel(item.kind)}</span>
            </div>
            <p className="text-sm text-muted-foreground">{item.detail}</p>
            <time dateTime={item.createdAt ?? undefined} className="text-xs text-muted-foreground">
              {formatTime(item.createdAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
