/**
 * Read-only run history for admins and managers.
 *
 * Reads GET /api/workforce/run-history. Each run shows its status text from the server (run-status-view), its
 * outcome reason when there is one, and its audit timeline. The screen has no buttons and makes no writes.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  eventLabel,
  formatTime,
  parseRunHistory,
  type HistoryRun,
} from "./task-board-logic";

export const RUN_HISTORY_QUERY_KEY = ["workforce-run-history", "/api/workforce/run-history"] as const;

async function fetchRunHistory(): Promise<{ runs: HistoryRun[]; truncated: boolean }> {
  const res = await apiRequest("GET", "/api/workforce/run-history");
  if (!res.ok) throw new Error(`Run history unavailable (HTTP ${res.status}).`);
  const body: unknown = await res.json();
  const truncated = typeof body === "object" && body !== null && (body as { truncated?: unknown }).truncated === true;
  return { runs: parseRunHistory(body), truncated };
}

function RunEntry({ run }: { run: HistoryRun }) {
  return (
    <li className="rounded-md border bg-background p-4 space-y-2" data-testid="run-history-entry">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{run.text}</p>
        <p className="text-xs text-muted-foreground">Started {formatTime(run.createdAt)}</p>
      </div>
      {run.detail && <p className="text-xs text-muted-foreground">{run.detail}</p>}
      {run.outcome.reason && <p className="text-sm">{run.outcome.reason}</p>}
      {run.events.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events recorded.</p>
      ) : (
        <ol className="space-y-1 border-l pl-3">
          {run.events.map((event, index) => (
            <li key={`${event.createdAt}-${index}`} className="text-xs">
              <span className="font-medium">{eventLabel(event.action)}</span>{" "}
              <span className="text-muted-foreground">{formatTime(event.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function RunHistory() {
  const query = useQuery({
    queryKey: RUN_HISTORY_QUERY_KEY,
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

  const runs = query.data?.runs ?? [];
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <section data-testid="run-history-page" className="space-y-3">
      {query.data?.truncated && (
        <p className="text-xs text-muted-foreground">Showing the most recent runs only.</p>
      )}
      <ul className="space-y-3">
        {runs.map((run) => (
          <RunEntry key={run.runId} run={run} />
        ))}
      </ul>
    </section>
  );
}

export default RunHistory;
