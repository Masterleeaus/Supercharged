/**
 * Omnichannel staff inbox page. Route: /app/chatbot-inbox (see DECISIONS.md, the route is added by the owner).
 * Three columns: the list with filters, the thread with the composer and actions, and the contact panel.
 * The list and thread poll every few seconds until the realtime transport is chosen (see DECISIONS.md).
 */
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthStorage } from "@/lib/auth-storage";
import { ApiError } from "@/lib/queryClient";
import { getThread, INBOX_QUERY_KEY, isInboxPending, listInbox, threadQueryKey } from "./api";
import { ConversationList, DEFAULT_LIST_FILTERS, type ListFilters } from "./conversation-list";
import { ConversationThread } from "./conversation-thread";
import { ContactPanel } from "./contact-panel";
import { PAGE_SIZE, READ_ONLY_ROLES } from "./types";

const LIST_POLL_MS = 20_000;

export default function ChatbotInboxPage() {
  const [filters, setFilters] = useState<ListFilters>(DEFAULT_LIST_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Role comes from the stored user. The server checks the role on every write, so this only hides controls.
  const role = AuthStorage.getUser()?.role ?? null;
  const canWrite = !(READ_ONLY_ROLES as readonly string[]).includes(role ?? "");

  const list = useQuery({
    queryKey: [...INBOX_QUERY_KEY, filters.handler, filters.ticketStatus, filters.page],
    queryFn: () =>
      listInbox({
        handler: filters.handler === "all" ? undefined : filters.handler,
        ticketStatus: filters.ticketStatus === "all" ? undefined : filters.ticketStatus,
        page: filters.page,
        perPage: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: LIST_POLL_MS,
  });

  const items = list.data?.items ?? [];

  // Open the first conversation on the page, and move off a row that dropped out of the filter.
  useEffect(() => {
    if (items.length === 0) return;
    if (!selectedId || !items.some((c) => c.id === selectedId)) setSelectedId(items[0].id);
  }, [items, selectedId]);

  // Same key as the thread, so React Query shares one request for the contact panel and the thread.
  const thread = useQuery({
    queryKey: selectedId ? threadQueryKey(selectedId) : ["chatbot", "agent", "conversation", "none"],
    queryFn: () => getThread(selectedId as string),
    enabled: Boolean(selectedId),
  });

  if (list.isError && isInboxPending(list.error)) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-4 text-xl font-semibold">Omnichannel Inbox</h1>
        <Alert>
          <AlertTitle>Staff inbox is not switched on yet</AlertTitle>
          <AlertDescription>
            The staff inbox routes are not mounted or not enabled for this environment. This page shows no
            conversations and changes nothing until they are.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100vh-4rem)] min-h-[480px] grid-cols-1 overflow-hidden md:grid-cols-[300px_1fr] lg:grid-cols-[300px_1fr_280px]">
      <section aria-label="Conversation list" className="min-h-0 border-b md:border-b-0 md:border-e">
        <div className="border-b p-3">
          <h1 className="text-lg font-semibold">Omnichannel Inbox</h1>
        </div>
        {list.isError && (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertDescription>
                {list.error instanceof ApiError ? list.error.message : "Could not load conversations."}
              </AlertDescription>
            </Alert>
          </div>
        )}
        <div className="h-[calc(100%-3.5rem)]">
          <ConversationList
            filters={filters}
            onFiltersChange={setFilters}
            data={list.data}
            isLoading={list.isLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            perPage={PAGE_SIZE}
          />
        </div>
      </section>

      <section aria-label="Conversation" className="min-h-0">
        {selectedId ? (
          <ConversationThread key={selectedId} conversationId={selectedId} canWrite={canWrite} />
        ) : list.isLoading ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-10 w-1/2" />
            <Skeleton className="h-10 w-2/3 ms-auto" />
          </div>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">No conversation selected.</p>
        )}
      </section>

      <aside aria-label="Contact details" className="hidden min-h-0 overflow-y-auto border-s lg:block">
        <ContactPanel conversation={thread.data?.conversation} />
      </aside>
    </div>
  );
}
