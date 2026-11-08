/**
 * Read-only workforce metrics for the signed-in admin's company.
 *
 * Reads GET /api/workforce/metrics through apiRequest. Shows workload, completion, escalations, error rates,
 * cost and the company's alerts. No buttons, no writes. Outcomes by agent are shown as unavailable until the
 * server records the acting agent on run events.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface MetricsSnapshot {
  runsStarted: number;
  runsCompleted: number;
  completionRate: number;
  runsFailed: number;
  errorRate: number;
  escalations: number;
  toolCallsRefused: number;
  toolRetries: number;
  spendCents: number;
  actions: number;
}

interface MetricsAlert {
  code: string;
  severity: "warning" | "critical";
  message: string;
}

interface MetricsResponse {
  snapshot: MetricsSnapshot;
  alerts: MetricsAlert[];
  agentBreakdown: { available: boolean; reason?: string };
}

const METRICS_KEY = ["workforce-metrics", "/api/workforce/metrics"] as const;

async function fetchMetrics(): Promise<MetricsResponse> {
  const res = await apiRequest("GET", "/api/workforce/metrics");
  if (!res.ok) throw new Error(`Metrics unavailable (HTTP ${res.status}).`);
  return (await res.json()) as MetricsResponse;
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Spend is recorded in cents. The currency is not part of the data, so only the amount is shown. */
function formatSpend(cents: number): string {
  return (cents / 100).toFixed(2);
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function MetricsPanel() {
  const query = useQuery({
    queryKey: METRICS_KEY,
    queryFn: fetchMetrics,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading metrics...
      </p>
    );
  }

  if (query.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Metrics could not be read."}
      </p>
    );
  }

  const data = query.data;
  if (!data) return null;
  const s = data.snapshot;

  return (
    <section aria-label="Workforce metrics" className="space-y-4">
      <h2 className="text-base font-semibold">Workforce metrics</h2>

      {data.alerts.length > 0 ? (
        <ul className="space-y-2" aria-label="Alerts">
          {data.alerts.map((alert) => (
            <li
              key={alert.code}
              role={alert.severity === "critical" ? "alert" : "status"}
              className={alert.severity === "critical" ? "text-sm text-destructive" : "text-sm text-amber-700"}
            >
              {alert.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Runs started" value={String(s.runsStarted)} />
        <Tile label="Completion rate" value={percent(s.completionRate)} hint={`${s.runsCompleted} completed`} />
        <Tile label="Error rate" value={percent(s.errorRate)} hint={`${s.runsFailed} failed`} />
        <Tile label="Escalations" value={String(s.escalations)} />
        <Tile label="Tool calls refused" value={String(s.toolCallsRefused)} />
        <Tile label="Tool retries" value={String(s.toolRetries)} />
        <Tile label="Spend" value={formatSpend(s.spendCents)} />
        <Tile label="Actions" value={String(s.actions)} />
      </div>

      <div>
        <h3 className="mb-1 text-sm font-medium">Outcomes by agent</h3>
        {data.agentBreakdown.available ? null : (
          <p className="text-sm text-muted-foreground">Not available yet: run events do not record the acting agent.</p>
        )}
      </div>
    </section>
  );
}
