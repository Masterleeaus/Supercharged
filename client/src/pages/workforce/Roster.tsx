/**
 * Workforce roster. Read-only list of the company's agents with role, tier and state.
 *
 * Reads GET /api/workforce/agents through apiRequest. Each row links to the agent detail screen.
 * Large text and full-width rows so it reads on an iPad. No writes, no buttons other than links.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  loadErrorMessage,
  rosterStatusLabel,
  sortRoster,
  tierLabel,
  toRosterItems,
  type RosterItem,
} from "./workforce-screen-logic";

export const ROSTER_QUERY_KEY = ["/api/workforce/agents"] as const;

async function fetchRoster(): Promise<RosterItem[]> {
  const res = await apiRequest("GET", "/api/workforce/agents");
  if (!res.ok) {
    const error = new Error(loadErrorMessage(res.status)) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const body = (await res.json()) as { items?: unknown };
  return sortRoster(toRosterItems(body.items));
}

export function RosterRow({ item }: { item: RosterItem }) {
  return (
    <li>
      <Link
        href={`/app/workforce/agents/${encodeURIComponent(item.id)}`}
        className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card className="p-5 text-lg hover:bg-muted/50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold leading-snug break-words">{item.name}</p>
              <p className="text-base text-muted-foreground break-words">Role: {item.roleId}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-base px-3 py-1">
                {tierLabel(item.autonomy)}
              </Badge>
              <Badge variant="secondary" className="text-base px-3 py-1">
                {rosterStatusLabel(item.status)}
              </Badge>
            </div>
          </div>
        </Card>
      </Link>
    </li>
  );
}

export default function Roster() {
  const query = useQuery({
    queryKey: ROSTER_QUERY_KEY,
    queryFn: fetchRoster,
    retry: false,
  });

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Roster</h1>
        <p className="text-lg text-muted-foreground">Every agent in your company, with its role and state.</p>
      </header>

      {query.isLoading && (
        <p role="status" className="text-lg text-muted-foreground">
          Loading roster...
        </p>
      )}

      {query.error && (
        <p role="alert" className="text-lg text-destructive">
          {query.error instanceof Error ? query.error.message : loadErrorMessage(null)}
        </p>
      )}

      {query.data && query.data.length === 0 && (
        <p className="text-lg text-muted-foreground">No agents yet.</p>
      )}

      {query.data && query.data.length > 0 && (
        <ul className="space-y-4" aria-label="Agents">
          {query.data.map((item) => (
            <RosterRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </main>
  );
}
