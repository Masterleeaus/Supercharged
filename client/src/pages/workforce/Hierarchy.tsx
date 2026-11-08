/**
 * Workforce hierarchy. Read-only view of coordinator and team relations taken from the roster data.
 *
 * Reads GET /api/workforce/agents through apiRequest (same cache entry as the roster screen).
 * Agents nest under their coordinator. Relations the roster does not carry are shown as such,
 * never inferred from role names.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  buildHierarchy,
  loadErrorMessage,
  rosterStatusLabel,
  sortRoster,
  teamLabel,
  toRosterItems,
  type HierarchyNode,
  type RosterItem,
} from "./workforce-screen-logic";
import { ROSTER_QUERY_KEY } from "./Roster";

async function fetchHierarchy(): Promise<RosterItem[]> {
  const res = await apiRequest("GET", "/api/workforce/agents");
  if (!res.ok) throw new Error(loadErrorMessage(res.status));
  const body = (await res.json()) as { items?: unknown };
  return sortRoster(toRosterItems(body.items));
}

function HierarchyRow({ node }: { node: HierarchyNode }) {
  const { item } = node;
  return (
    <li style={{ marginLeft: `${Math.min(node.depth, 6) * 1.5}rem` }}>
      <Link
        href={`/app/workforce/agents/${encodeURIComponent(item.id)}`}
        className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card className="p-4 text-lg hover:bg-muted/50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold leading-snug break-words">{item.name}</p>
              <p className="text-base text-muted-foreground break-words">Role: {item.roleId}</p>
              {node.depth === 0 && <p className="text-base text-muted-foreground">Top level</p>}
              {node.depth > 0 && <p className="text-base text-muted-foreground">Reports to a coordinator above</p>}
              {node.coordinatorMissing && (
                <p className="text-base text-destructive">Coordinator is not in the roster</p>
              )}
              {node.inCycle && (
                <p className="text-base text-destructive">Coordinator loop: check this agent&apos;s coordinator</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-base px-3 py-1">
                {teamLabel(item.teamId)}
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

export default function Hierarchy() {
  const query = useQuery({
    queryKey: ROSTER_QUERY_KEY,
    queryFn: fetchHierarchy,
    retry: false,
  });

  const nodes = query.data ? buildHierarchy(query.data) : [];
  const hasCoordinatorData = query.data?.some((item) => item.coordinatorId !== null) ?? false;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Hierarchy</h1>
        <p className="text-lg text-muted-foreground">
          Who coordinates whom, and which team each agent belongs to. Read only.
        </p>
      </header>

      {query.isLoading && (
        <p role="status" className="text-lg text-muted-foreground">
          Loading hierarchy...
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

      {query.data && query.data.length > 0 && !hasCoordinatorData && (
        <p role="note" className="text-lg text-muted-foreground">
          The roster does not list coordinators yet, so every agent is shown at the top level.
        </p>
      )}

      {nodes.length > 0 && (
        <ul className="space-y-4" aria-label="Agent hierarchy">
          {nodes.map((node) => (
            <HierarchyRow key={node.item.id} node={node} />
          ))}
        </ul>
      )}
    </main>
  );
}
