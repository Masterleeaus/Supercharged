/**
 * Read-only task board for admins and managers.
 *
 * Reads GET /api/workforce/tasks and groups each run into a column by its status label. Status text comes from
 * the server (run-status-view). The board has no buttons and makes no writes.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  COLUMN_HEADINGS,
  COLUMN_ORDER,
  formatTime,
  groupByColumn,
  parseTaskRows,
  type TaskRow,
} from "./task-board-logic";

export const TASKS_QUERY_KEY = ["workforce-tasks", "/api/workforce/tasks"] as const;

async function fetchTasks(): Promise<{ tasks: TaskRow[]; truncated: boolean }> {
  const res = await apiRequest("GET", "/api/workforce/tasks");
  if (!res.ok) throw new Error(`Task board unavailable (HTTP ${res.status}).`);
  const body: unknown = await res.json();
  const truncated = typeof body === "object" && body !== null && (body as { truncated?: unknown }).truncated === true;
  return { tasks: parseTaskRows(body), truncated };
}

function TaskCard({ task }: { task: TaskRow }) {
  return (
    <li className="rounded-md border bg-background p-3 space-y-1" data-testid="task-card">
      <p className="text-sm font-medium">{task.text}</p>
      {task.detail && <p className="text-xs text-muted-foreground">{task.detail}</p>}
      <p className="text-xs text-muted-foreground">Updated {formatTime(task.updatedAt)}</p>
    </li>
  );
}

export function TaskBoard() {
  const query = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading tasks...
      </p>
    );
  }

  if (query.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Task board could not be read."}
      </p>
    );
  }

  const tasks = query.data?.tasks ?? [];
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">No tasks yet.</p>;
  }

  const columns = groupByColumn(tasks);

  return (
    <section data-testid="task-board" className="space-y-3">
      {query.data?.truncated && (
        <p className="text-xs text-muted-foreground">Showing the most recent tasks only.</p>
      )}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-7">
        {COLUMN_ORDER.map((label) => {
          const rows = columns[label];
          return (
            <div key={label} className="space-y-2" data-testid={`task-column-${label}`}>
              <h3 className="text-sm font-semibold">
                {COLUMN_HEADINGS[label]} ({rows.length})
              </h3>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">None</p>
              ) : (
                <ul className="space-y-2">
                  {rows.map((task) => (
                    <TaskCard key={task.runId} task={task} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default TaskBoard;
