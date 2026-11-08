/**
 * Left column of the staff inbox: filters, sort, the conversation list and paging.
 *
 * Server-side filters: handler (AI or human), ticket status (new or closed), page.
 * Client-side only, on the current page: channel and sort. Unread is pending the backend (see DECISIONS.md).
 */
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { InboxConversation, InboxPage, AgentHandler, TicketStatus } from "./types";
import { channelLabel, formatTime } from "./format";

export type SortOrder = "newest" | "oldest";

export interface ListFilters {
  handler: AgentHandler | "all";
  ticketStatus: TicketStatus | "all";
  channel: string;
  sort: SortOrder;
  unreadOnly: boolean;
  page: number;
}

export const DEFAULT_LIST_FILTERS: ListFilters = {
  handler: "all",
  ticketStatus: "all",
  channel: "all",
  sort: "newest",
  unreadOnly: false,
  page: 1,
};

interface ConversationListProps {
  filters: ListFilters;
  onFiltersChange: (next: ListFilters) => void;
  data: InboxPage | undefined;
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  perPage: number;
}

export function ConversationList({
  filters,
  onFiltersChange,
  data,
  isLoading,
  selectedId,
  onSelect,
  perPage,
}: ConversationListProps) {
  const items: InboxConversation[] = data?.items ?? [];

  // Channel options come from the current page, so they always match what the user can see.
  const channels = useMemo(() => Array.from(new Set(items.map((c) => c.channel))).sort(), [items]);

  const visible = useMemo(() => {
    let rows = items;
    if (filters.channel !== "all") rows = rows.filter((c) => c.channel === filters.channel);
    if (filters.unreadOnly) rows = rows.filter((c) => (c.unreadCount ?? 0) > 0);
    const sorted = [...rows].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    return filters.sort === "newest" ? sorted.reverse() : sorted;
  }, [items, filters.channel, filters.unreadOnly, filters.sort]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / perPage)) : 1;
  const set = (patch: Partial<ListFilters>) => onFiltersChange({ ...filters, ...patch });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-2 gap-3 border-b p-3">
        <div className="space-y-1">
          <Label htmlFor="inbox-status" className="text-xs">Status</Label>
          <Select
            value={filters.ticketStatus}
            onValueChange={(v) => set({ ticketStatus: v as ListFilters["ticketStatus"], page: 1 })}
          >
            <SelectTrigger id="inbox-status" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="inbox-assigned" className="text-xs">Assigned</Label>
          <Select
            value={filters.handler}
            onValueChange={(v) => set({ handler: v as ListFilters["handler"], page: 1 })}
          >
            <SelectTrigger id="inbox-assigned" aria-label="Filter by assigned agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="ai">AI agent</SelectItem>
              <SelectItem value="human">Human agent</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="inbox-channel" className="text-xs">Channel (this page)</Label>
          <Select value={filters.channel} onValueChange={(v) => set({ channel: v })}>
            <SelectTrigger id="inbox-channel" aria-label="Filter by channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {channels.map((c) => (
                <SelectItem key={c} value={c}>
                  {channelLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="inbox-sort" className="text-xs">Sort (this page)</Label>
          <Select value={filters.sort} onValueChange={(v) => set({ sort: v as SortOrder })}>
            <SelectTrigger id="inbox-sort" aria-label="Sort conversations">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="col-span-2 flex items-start gap-2">
          <Checkbox
            id="inbox-unread"
            checked={filters.unreadOnly}
            onCheckedChange={(v) => set({ unreadOnly: v === true })}
            aria-describedby="inbox-unread-note"
          />
          <div>
            <Label htmlFor="inbox-unread" className="text-xs">Unread only</Label>
            <p id="inbox-unread-note" className="text-xs text-muted-foreground">
              Unread counts are not sent by the server yet, so this shows nothing until they are.
            </p>
          </div>
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversations">
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="space-y-2 border-b p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </li>
          ))}

        {!isLoading && visible.length === 0 && (
          <li className="p-4 text-sm text-muted-foreground">No conversations match these filters.</li>
        )}

        {visible.map((c) => {
          const selected = c.id === selectedId;
          return (
            <li key={c.id} className="border-b">
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={selected ? "true" : undefined}
                className={`flex w-full items-start gap-3 p-4 text-left hover:bg-accent/40 ${selected ? "bg-accent/60" : ""}`}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">Conversation {c.id.slice(0, 8)}</span>
                    {typeof c.unreadCount === "number" && c.unreadCount > 0 && (
                      <Badge aria-label={`${c.unreadCount} unread`} className="shrink-0">
                        {c.unreadCount}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {channelLabel(c.channel)} · {c.handler === "human" ? "Human agent" : "AI agent"} ·{" "}
                    {c.ticketStatus === "closed" ? "Closed" : "New"}
                  </p>
                </div>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={c.updatedAt}>
                  {formatTime(c.updatedAt)}
                </time>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-2 border-t p-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!data || filters.page <= 1}
          onClick={() => set({ page: filters.page - 1 })}
          aria-label="Previous page"
        >
          <ChevronLeft />
          Prev
        </Button>
        <span className="text-xs text-muted-foreground">
          Page {filters.page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!data || filters.page >= totalPages}
          onClick={() => set({ page: filters.page + 1 })}
          aria-label="Next page"
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
