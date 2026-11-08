/**
 * Usage for the company: how many runs have started today, the spend today against the daily budget, and the
 * totals across every run the company has. Admin only. Read only.
 *
 * Server contract (company-controls-routes.ts):
 *   GET /api/workforce/usage -> { day, today: { runsStarted, spendCents }, totals: { runs, toolCalls, tokens, spendCents },
 *                                 budgets | null, remainingToday | null }
 */
import { useEffect, useState } from "react";
import { apiRequest, ApiError } from "@/lib/queryClient";

interface UsageResponse {
  day: string;
  today: { runsStarted: number; spendCents: number };
  totals: { runs: number; toolCalls: number; tokens: number; spendCents: number };
  budgets: {
    maxRunsPerCompanyPerDay: number;
    maxSpendCentsPerCompanyPerDay: number;
  } | null;
  remainingToday: { runs: number; spendCents: number } | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function count(value: number): string {
  return value.toLocaleString();
}

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return "Only a company admin can see usage.";
  return "Usage could not be loaded.";
}

export default function Usage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/workforce/usage");
        const body = (await res.json()) as UsageResponse;
        if (!cancelled) setData(body);
      } catch (error) {
        if (!cancelled) setProblem(errorText(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (problem) return <p role="alert" className="p-6 text-lg text-red-700">{problem}</p>;
  if (!data) return <p className="p-6 text-lg">Loading usage...</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6 text-lg">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Usage</h1>
        <p>Today is {data.day} (UTC). Totals cover every run the company has.</p>
      </header>

      <section className="space-y-3" aria-labelledby="today-heading">
        <h2 id="today-heading" className="text-2xl font-semibold">Today</h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-4">
            <dt className="font-medium">Runs started</dt>
            <dd className="text-3xl font-bold">{count(data.today.runsStarted)}</dd>
            {data.budgets && (
              <dd className="mt-1">of {count(data.budgets.maxRunsPerCompanyPerDay)} allowed</dd>
            )}
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-medium">Spend today</dt>
            <dd className="text-3xl font-bold">{money(data.today.spendCents)}</dd>
            {data.budgets && (
              <dd className="mt-1">of {money(data.budgets.maxSpendCentsPerCompanyPerDay)} allowed</dd>
            )}
          </div>
        </dl>
        {data.remainingToday ? (
          <p>
            Left today: {count(data.remainingToday.runs)} runs and {money(data.remainingToday.spendCents)} of spend.
          </p>
        ) : (
          <p className="rounded bg-amber-50 p-4 text-amber-900">
            No budgets are saved yet, so the company cannot run work. Set budgets on the controls page.
          </p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="totals-heading">
        <h2 id="totals-heading" className="text-2xl font-semibold">All time</h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-4">
            <dt className="font-medium">Runs</dt>
            <dd className="text-2xl font-bold">{count(data.totals.runs)}</dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-medium">Tool calls</dt>
            <dd className="text-2xl font-bold">{count(data.totals.toolCalls)}</dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-medium">Tokens</dt>
            <dd className="text-2xl font-bold">{count(data.totals.tokens)}</dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-medium">Spend</dt>
            <dd className="text-2xl font-bold">{money(data.totals.spendCents)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
