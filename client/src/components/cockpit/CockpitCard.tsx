import type { KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDistanceToNow } from "date-fns";
import { routeCardGesture, type CardHandlers, type CockpitItem } from "./cockpit-logic";

export interface CockpitCardProps {
  item: CockpitItem;
  handlers: CardHandlers;
  actionPending?: boolean;
}

function formatWhen(value: string | null): string {
  if (value === null) return "Time unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unknown";
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * One cockpit card. The button runs the suggested action. A tap on the body opens the item.
 * Cockpit cards have no swipe gestures.
 */
export function CockpitCard({ item, handlers, actionPending = false }: CockpitCardProps) {
  const open = () => routeCardGesture("body", item, handlers);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && event.target === event.currentTarget) open();
  };

  return (
    <Card
      data-testid={`cockpit-card-${item.id}`}
      onClick={open}
      onKeyDown={handleKeyDown}
      tabIndex={item.openHref ? 0 : -1}
      className={item.openHref ? "cursor-pointer hover-elevate" : undefined}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-card-foreground">{item.title}</p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.detail}</p>
          </div>
          <Badge variant="outline" className="shrink-0">
            {item.kind.replace(/_/g, " ")}
          </Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <time dateTime={item.createdAt ?? undefined}>{formatWhen(item.createdAt)}</time>
          {item.action && (
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending}
              data-testid={`cockpit-action-${item.id}`}
              onClick={(event) => {
                event.stopPropagation();
                routeCardGesture("button", item, handlers);
              }}
            >
              {item.action.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
