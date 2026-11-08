import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CockpitCard } from "./CockpitCard";
import {
  COCKPIT_SORT_ORDERS,
  sortCockpitItems,
  type CockpitItem,
  type CockpitSortOrder,
} from "./cockpit-logic";

const SORT_LABELS: Record<CockpitSortOrder, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  kind: "By kind",
};

export interface CockpitPanelProps {
  title: string;
  items: CockpitItem[];
  isLoading?: boolean;
  /** The reason the list could not be read. Shown in the empty state in place of emptyText. */
  error?: string | null;
  emptyText: string;
  /** A small caption under the list, such as the data source. */
  footnote?: string | null;
  onOpen: (item: CockpitItem) => void;
  /** Runs the card's suggested action. The card button calls this. */
  onAction: (item: CockpitItem) => void;
  actionPendingId?: string | null;
  actionError?: string | null;
  testId: string;
}

/**
 * A control panel: a sort control over a list of cards, with loading, error and empty states.
 */
export function CockpitPanel({
  title,
  items,
  isLoading = false,
  error = null,
  emptyText,
  footnote = null,
  onOpen,
  onAction,
  actionPendingId = null,
  actionError = null,
  testId,
}: CockpitPanelProps) {
  const [sortOrder, setSortOrder] = useState<CockpitSortOrder>("newest");
  const sorted = useMemo(() => sortCockpitItems(items, sortOrder), [items, sortOrder]);
  const sortId = `${testId}-sort`;

  const handlers = { onOpen, onAction };

  return (
    <Card data-testid={testId} className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          <label htmlFor={sortId} className="flex items-center gap-2 text-xs text-muted-foreground">
            Sort
            <select
              id={sortId}
              data-testid={`${testId}-sort`}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value as CockpitSortOrder)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
            >
              {COCKPIT_SORT_ORDERS.map((order) => (
                <option key={order} value={order}>
                  {SORT_LABELS[order]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {actionError && (
          <p role="alert" className="text-xs text-destructive">{actionError}</p>
        )}
        {isLoading ? (
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <span className="sr-only">Loading</span>
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
            data-testid={`${testId}-empty`}
          >
            {error}
          </div>
        ) : sorted.length === 0 ? (
          <div
            className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
            data-testid={`${testId}-empty`}
          >
            {emptyText}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {sorted.map((item) => (
              <li key={item.id}>
                <CockpitCard
                  item={item}
                  handlers={handlers}
                  actionPending={
                    item.action?.kind === "approve" && actionPendingId === item.action.approvalId
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {footnote && !isLoading && (
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-footnote`}>{footnote}</p>
        )}
      </CardContent>
    </Card>
  );
}
