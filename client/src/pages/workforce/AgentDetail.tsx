/**
 * Agent detail. Shows one agent's role, tier, permissions, state, assigned work, recent results and errors.
 *
 * Reads GET /api/workforce/agents/:agentId through apiRequest, expecting the AgentView shape from
 * server/workforce/runtime/agent-view.ts. That route is not mounted yet, so until it is the screen shows
 * the load error message. Read only.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  agentStateLabel,
  formatWhen,
  loadErrorMessage,
  parseAgentDetail,
  runLabelText,
  runLabelTone,
  tierLabel,
  type AgentDetailData,
} from "./workforce-screen-logic";

async function fetchAgentDetail(agentId: string): Promise<AgentDetailData> {
  const res = await apiRequest("GET", `/api/workforce/agents/${encodeURIComponent(agentId)}`);
  if (!res.ok) {
    const error = new Error(loadErrorMessage(res.status)) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const detail = parseAgentDetail(await res.json());
  if (detail === null) throw new Error(loadErrorMessage(null));
  return detail;
}

function ToneBadge({ label }: { label: string }) {
  const tone = runLabelTone(label);
  const variant = tone === "danger" ? "destructive" : tone === "attention" ? "default" : "secondary";
  return (
    <Badge variant={variant} className="text-base px-3 py-1">
      {runLabelText(label)}
    </Badge>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-2xl font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-lg text-muted-foreground">{text}</p>;
}

export default function AgentDetail() {
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId ?? "";

  const query = useQuery({
    queryKey: ["/api/workforce/agents", agentId],
    queryFn: () => fetchAgentDetail(agentId),
    enabled: agentId !== "",
    retry: false,
  });

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <nav className="text-lg">
        <Link href="/app/workforce/roster" className="underline underline-offset-4">
          Back to roster
        </Link>
      </nav>

      {query.isLoading && (
        <p role="status" className="text-lg text-muted-foreground">
          Loading agent...
        </p>
      )}

      {query.error && (
        <p role="alert" className="text-lg text-destructive">
          {query.error instanceof Error ? query.error.message : loadErrorMessage(null)}
        </p>
      )}

      {query.data && <AgentBody agent={query.data} />}
    </main>
  );
}

function AgentBody({ agent }: { agent: AgentDetailData }) {
  return (
    <>
      <header className="space-y-3">
        <h1 className="text-3xl font-bold break-words">{agent.roleName}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="text-base px-3 py-1">
            {tierLabel(agent.autonomy)}
          </Badge>
          <Badge variant="secondary" className="text-base px-3 py-1">
            {agentStateLabel(agent.state)}
          </Badge>
        </div>
      </header>

      <Section title="Role and tier">
        <dl className="grid gap-3 text-lg sm:grid-cols-2">
          <div>
            <dt className="text-base text-muted-foreground">Role</dt>
            <dd className="break-words">{agent.roleName}</dd>
          </div>
          <div>
            <dt className="text-base text-muted-foreground">Tier</dt>
            <dd>{tierLabel(agent.autonomy)}</dd>
          </div>
          <div>
            <dt className="text-base text-muted-foreground">Channels</dt>
            <dd>{agent.channels.length > 0 ? agent.channels.join(", ") : "None"}</dd>
          </div>
          <div>
            <dt className="text-base text-muted-foreground">State</dt>
            <dd>{agentStateLabel(agent.state)}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Permissions">
        {agent.permissions.length === 0 ? (
          <Empty text="No tools allowed." />
        ) : (
          <ul className="list-disc space-y-1 pl-6 text-lg break-words">
            {agent.permissions.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Assigned work">
        {agent.assignedWork.length === 0 ? (
          <Empty text="No open work." />
        ) : (
          <ul className="space-y-3">
            {agent.assignedWork.map((work) => (
              <li key={work.runId} className="rounded-lg border p-4 text-lg">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium break-words">{work.text}</p>
                  <ToneBadge label={work.label} />
                </div>
                {work.detail && <p className="text-base text-muted-foreground break-words">{work.detail}</p>}
                <p className="text-base text-muted-foreground">Updated {formatWhen(work.updatedAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recent results">
        {agent.recentResults.length === 0 ? (
          <Empty text="No finished work yet." />
        ) : (
          <ul className="space-y-3">
            {agent.recentResults.map((result) => (
              <li key={result.runId} className="rounded-lg border p-4 text-lg">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium break-words">{result.text}</p>
                  <ToneBadge label={result.label} />
                </div>
                <p className="text-base text-muted-foreground">Finished {formatWhen(result.finishedAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Errors">
        {agent.errors.length === 0 ? (
          <Empty text="No errors." />
        ) : (
          <ul className="space-y-3">
            {agent.errors.map((error) => (
              <li key={error.runId} className="rounded-lg border border-destructive/40 p-4 text-lg">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium break-words">{error.text}</p>
                  <ToneBadge label={error.label} />
                </div>
                {error.reason && <p className="text-base text-muted-foreground break-words">Reason: {error.reason}</p>}
                <p className="text-base text-muted-foreground">Stopped {formatWhen(error.finishedAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
