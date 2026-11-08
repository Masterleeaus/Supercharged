/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { clampDrag, decideSwipe } from "./swipe-logic";

export type ActivitySource = "workforce" | "inbox" | "campaign";

export interface SuggestedAction {
  label: string;
}

export interface ActivityItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  source: ActivitySource;
  createdAt: string;
  suggestedAction?: SuggestedAction;
}

export interface ActivityCardProps {
  item: ActivityItem;
  onArchive: (id: string) => void;
  onAccept: (id: string) => void;
}

const SOURCE_LABELS: Record<ActivitySource, string> = {
  workforce: "Workforce",
  inbox: "Inbox",
  campaign: "Campaign",
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ActivityCard({ item, onArchive, onAccept }: ActivityCardProps) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const offsetRef = useRef(0);

  const hasAction = Boolean(item.suggestedAction);

  const updateOffset = (value: number) => {
    offsetRef.current = value;
    setOffset(value);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startXRef.current = event.clientX;
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (startXRef.current === null) return;
    updateOffset(clampDrag(event.clientX - startXRef.current));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (startXRef.current === null) return;
    const dx = offsetRef.current;
    startXRef.current = null;
    if (pointerIdRef.current !== null) {
      event.currentTarget.releasePointerCapture?.(pointerIdRef.current);
    }
    pointerIdRef.current = null;
    setDragging(false);
    updateOffset(0);

    if (cancelled) return;
    const decision = decideSwipe({ dx });
    if (decision === "archive") {
      onArchive(item.id);
    } else if (decision === "accept" && hasAction) {
      onAccept(item.id);
    }
    // A right swipe with no suggested action does nothing and snaps back.
  };

  let hint: string | null = null;
  if (dragging && offset < 0) {
    hint = t("activity.archiveHint", "Archive");
  } else if (dragging && offset > 0 && hasAction) {
    hint = item.suggestedAction!.label;
  }

  return (
    <div className="relative overflow-hidden rounded-lg" data-testid={`activity-card-${item.id}`}>
      {hint !== null && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0 flex items-center px-4 text-sm font-semibold",
            offset < 0
              ? "justify-end bg-destructive/15 text-destructive"
              : "justify-start bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          )}
        >
          {hint}
        </div>
      )}
      <Card
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 200ms ease-out",
          touchAction: "pan-y",
        }}
        className="relative cursor-grab select-none active:cursor-grabbing"
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-card-foreground">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.detail}</p>
            </div>
            <Badge variant="outline" className="shrink-0">
              {SOURCE_LABELS[item.source] ?? item.source}
            </Badge>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time>
            {hasAction && (
              <span className="font-medium text-brand">{item.suggestedAction!.label}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
