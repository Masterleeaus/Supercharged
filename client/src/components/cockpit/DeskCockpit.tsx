import type { ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { approveApproval, approvalsQueryKeys } from "@/lib/approvals-api";
import { AuthStorage } from "@/lib/auth-storage";
import { CockpitPanel } from "./CockpitPanel";
import {
  canSeeWorkforceActivity,
  listFromBody,
  mapCampaignResponsesToItems,
  mapReviewInboxToItems,
  mapThreadsToInboxItems,
  mapWorkforceActivityToItems,
  panelsForMode,
  resolveDeskMode,
  sourceNote,
  type CockpitItem,
  type CockpitPanelId,
  type DeskModeOutcome,
  type ResolvedDeskMode,
} from "./cockpit-logic";

const DESK_MODE_KEY = ["/api/desk-mode"] as const;
const WORKFORCE_ACTIVITY_KEY = ["/api/workforce/activity"] as const;
const REVIEW_INBOX_KEY = ["/api/workforce/review-inbox"] as const;
const INBOX_THREADS_KEY = ["/api/inbox/threads", "open"] as const;
const CAMPAIGN_RESPONSES_KEY = ["/api/campaigns/responses"] as const;

/** Open threads only. The inbox module's thread route, mounted under /api/inbox. */
const INBOX_THREADS_URL = "/api/inbox/threads?status=open";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Fetches a cockpit endpoint. A non-OK status throws with the reason, which the panel shows. */
async function getJson(url: string, label: string): Promise<unknown> {
  const res = await apiRequest("GET", url);
  if (!res.ok) {
    const hint = res.status === 404 ? ", the route is not mounted on this server" : "";
    throw new Error(`${label} unavailable (HTTP ${res.status}${hint}).`);
  }
  return res.json() as Promise<unknown>;
}

/** Reads GET /api/desk-mode. A failed read resolves to the default mode with a notice. */
function useDeskModeState(): { isLoading: boolean; resolved: ResolvedDeskMode } {
  const query = useQuery({
    queryKey: DESK_MODE_KEY,
    queryFn: () => getJson("/api/desk-mode", "Desk mode"),
    retry: false,
  });
  const outcome: DeskModeOutcome | null = query.isError
    ? { ok: false, reason: errorText(query.error, "request failed") }
    : query.isSuccess
      ? { ok: true, body: query.data }
      : null;
  return {
    isLoading: outcome === null,
    resolved: resolveDeskMode(outcome ?? { ok: false, reason: "loading" }),
  };
}

/** Workforce activity from /api/workforce/activity: completed work and approvals. */
function useWorkforceActivity() {
  const queryClient = useQueryClient();
  const allowed = canSeeWorkforceActivity(AuthStorage.getUser()?.role);
  const query = useQuery({
    queryKey: WORKFORCE_ACTIVITY_KEY,
    queryFn: () => getJson("/api/workforce/activity", "Workforce activity"),
    retry: false,
    enabled: allowed,
  });
  const approve = useMutation({
    mutationFn: (approvalId: string) => approveApproval(approvalId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: WORKFORCE_ACTIVITY_KEY });
      queryClient.invalidateQueries({ queryKey: approvalsQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: REVIEW_INBOX_KEY });
    },
  });
  const onAction = (item: CockpitItem) => {
    if (item.action?.kind === "approve") approve.mutate(item.action.approvalId);
  };
  return {
    allowed,
    forbidden: query.error instanceof Error && /HTTP 403/.test(query.error.message),
    items: mapWorkforceActivityToItems(listFromBody(query.data)),
    isLoading: query.isLoading,
    error: query.error ? errorText(query.error, "Workforce activity could not be read.") : null,
    footnote: sourceNote(query.data, "runsSource"),
    onOpen: () => undefined,
    onAction,
    actionPendingId: approve.isPending ? (approve.variables ?? null) : null,
    actionError: approve.error ? errorText(approve.error, "Approval failed.") : null,
  };
}

/** Exceptions from /api/workforce/review-inbox. Only approval and run items get a button. */
function useReviewCards() {
  const [, setLocation] = useLocation();
  const query = useQuery({
    queryKey: REVIEW_INBOX_KEY,
    queryFn: () => getJson("/api/workforce/review-inbox", "Review inbox"),
    retry: false,
  });
  const onOpen = (item: CockpitItem) => {
    if (item.openHref) setLocation(item.openHref);
  };
  const onAction = (item: CockpitItem) => {
    if (item.action?.kind === "open") setLocation(item.action.href);
  };
  return {
    items: mapReviewInboxToItems(listFromBody(query.data)),
    isLoading: query.isLoading,
    error: query.error ? errorText(query.error, "Could not load the review inbox.") : null,
    onOpen,
    onAction,
  };
}

/** Open conversation threads only. Calls are never read here. */
function useInboxCards() {
  const query = useQuery({
    queryKey: INBOX_THREADS_KEY,
    queryFn: () => getJson(INBOX_THREADS_URL, "Inbox threads"),
    retry: false,
  });
  // A 404 means the thread route is not mounted yet. That is "not connected", not a failure.
  const notConnected = query.error instanceof Error && query.error.message.includes("HTTP 404");
  return {
    items: mapThreadsToInboxItems(listFromBody(query.data)),
    isLoading: query.isLoading,
    error: query.error && !notConnected ? errorText(query.error, "Inbox threads could not be read.") : null,
    footnote: notConnected ? "The inbox is not connected on this server yet." : null,
  };
}

/** Campaign responses from /api/campaigns/responses. */
function useCampaignResponses() {
  const query = useQuery({
    queryKey: CAMPAIGN_RESPONSES_KEY,
    queryFn: () => getJson("/api/campaigns/responses", "Campaign responses"),
    retry: false,
  });
  return {
    items: mapCampaignResponsesToItems(listFromBody(query.data)),
    isLoading: query.isLoading,
    error: query.error ? errorText(query.error, "Campaign responses could not be read.") : null,
    footnote: sourceNote(query.data, "eventsSource"),
  };
}

const noAction = () => undefined;

function WorkforceActivityPanel() {
  const data = useWorkforceActivity();
  // Hidden for members and when the server refuses the read with 403.
  if (!data.allowed || data.forbidden) return null;
  return (
    <CockpitPanel
      testId="cockpit-workforce-activity"
      title="Workforce activity"
      items={data.items}
      isLoading={data.isLoading}
      error={data.error}
      footnote={data.footnote}
      emptyText="No workforce activity has been recorded yet."
      actionError={data.actionError}
      actionPendingId={data.actionPendingId}
      onOpen={data.onOpen}
      onAction={data.onAction}
    />
  );
}

function NeedsAttentionPanel() {
  const data = useReviewCards();
  return (
    <CockpitPanel
      testId="cockpit-needs-attention"
      title="Needs attention"
      items={data.items}
      isLoading={data.isLoading}
      error={data.error}
      emptyText="Nothing needs attention right now."
      onOpen={data.onOpen}
      onAction={data.onAction}
    />
  );
}

function InboxPanel() {
  const data = useInboxCards();
  return (
    <CockpitPanel
      testId="cockpit-inbox"
      title="Inbox"
      items={data.items}
      isLoading={data.isLoading}
      error={data.error}
      emptyText="No open conversations."
      footnote={data.footnote}
      onOpen={noAction}
      onAction={noAction}
    />
  );
}

function CampaignResponsesPanel() {
  const data = useCampaignResponses();
  return (
    <CockpitPanel
      testId="cockpit-campaign-responses"
      title="Campaign responses"
      items={data.items}
      isLoading={data.isLoading}
      error={data.error}
      footnote={data.footnote}
      emptyText="No campaign responses have been recorded yet."
      onOpen={noAction}
      onAction={noAction}
    />
  );
}

const PANEL_COMPONENTS: Record<CockpitPanelId, ComponentType> = {
  workforce_activity: WorkforceActivityPanel,
  needs_attention: NeedsAttentionPanel,
  inbox: InboxPanel,
  campaign_responses: CampaignResponsesPanel,
};

/**
 * The cockpit. The panels come from GET /api/desk-mode: workforce shows the workforce panels,
 * syncedat shows the comms panels. A failed read uses workforce and shows a notice.
 */
export function DeskCockpit() {
  const { isLoading, resolved } = useDeskModeState();

  if (isLoading) {
    return (
      <section aria-label="Cockpit" className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-testid="desk-cockpit">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </section>
    );
  }

  const [left, right] = panelsForMode(resolved.mode);
  const LeftPanel = PANEL_COMPONENTS[left];
  const RightPanel = PANEL_COMPONENTS[right];
  return (
    <section
      aria-label="Cockpit"
      className="grid grid-cols-1 lg:grid-cols-2 gap-6"
      data-testid="desk-cockpit"
      data-mode={resolved.mode}
    >
      {resolved.notice && (
        <p role="status" className="col-span-full text-xs text-muted-foreground" data-testid="cockpit-mode-notice">
          {resolved.notice}
        </p>
      )}
      <LeftPanel />
      <RightPanel />
    </section>
  );
}
