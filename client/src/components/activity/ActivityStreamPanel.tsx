/**
 * Activity stream container for the Desk dashboard.
 *
 * Reads GET /api/workforce/activity and renders ActivityStream, the only place swipe gestures live.
 *   - Swipe left archives the card. Archiving is kept in this browser session only; the server has no archive store yet.
 *   - Swipe right runs the suggested action. For an approval item that is approveApproval on the approval it names.
 *     An item with no suggested action does nothing on swipe right.
 *   - Members get a 403 from the server, so the panel renders nothing for them.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { approveApproval } from "@/lib/approvals-api";
import { ActivityStream } from "./ActivityStream";
import type { ActivityItem } from "./ActivityCard";

const ACTIVITY_KEY = ["/api/workforce/activity"] as const;

/** The server adds the approval id to the suggested action. The shared card type does not carry it. */
interface ServerActivityItem extends ActivityItem {
  suggestedAction?: { label: string; approvalId?: string };
}

interface ActivityFeedBody {
  items?: ServerActivityItem[];
}

async function fetchActivity(): Promise<{ allowed: boolean; items: ServerActivityItem[] }> {
  const res = await apiRequest("GET", "/api/workforce/activity");
  if (res.status === 403) return { allowed: false, items: [] };
  if (!res.ok) throw new Error(`Workforce activity unavailable (HTTP ${res.status}).`);
  const body = (await res.json()) as ActivityFeedBody;
  return { allowed: true, items: Array.isArray(body.items) ? body.items : [] };
}

export function ActivityStreamPanel() {
  const queryClient = useQueryClient();
  const [archived, setArchived] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ACTIVITY_KEY,
    queryFn: fetchActivity,
    retry: false,
  });

  if (query.data && !query.data.allowed) return null;

  const visible = (query.data?.items ?? []).filter((item) => !archived.has(item.id));

  const onArchive = (id: string) => {
    setArchived((prev) => new Set(prev).add(id));
  };

  const onAccept = async (id: string) => {
    const item = (query.data?.items ?? []).find((candidate) => candidate.id === id);
    const approvalId = item?.suggestedAction?.approvalId;
    if (!approvalId) return;
    setActionError(null);
    try {
      await approveApproval(approvalId);
      setArchived((prev) => new Set(prev).add(id));
      await queryClient.invalidateQueries({ queryKey: ACTIVITY_KEY });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The action could not run.");
    }
  };

  return (
    <section data-testid="activity-stream-panel" className="space-y-2">
      <h2 className="text-base font-semibold">Activity</h2>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Workforce activity could not be read."}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      <ActivityStream
        items={visible}
        loading={query.isLoading}
        onArchive={onArchive}
        onAccept={onAccept}
      />
    </section>
  );
}
