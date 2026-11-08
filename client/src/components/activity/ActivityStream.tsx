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
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityCard, type ActivityItem } from "./ActivityCard";

export interface ActivityStreamProps {
  items: ActivityItem[];
  loading?: boolean;
  onArchive: (id: string) => void;
  onAccept: (id: string) => void;
}

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function ActivityStream({ items, loading = false, onArchive, onAccept }: ActivityStreamProps) {
  const { t } = useTranslation();

  const sorted = useMemo(
    () => [...items].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt)),
    [items],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-live="polite" data-testid="activity-stream-loading">
        <span className="sr-only">{t("activity.loading", "Loading activity")}</span>
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
        data-testid="activity-stream-empty"
      >
        {t("activity.empty", "No activity to review right now.")}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="activity-stream">
      {sorted.map((item) => (
        <li key={item.id}>
          <ActivityCard item={item} onArchive={onArchive} onAccept={onAccept} />
        </li>
      ))}
    </ul>
  );
}
