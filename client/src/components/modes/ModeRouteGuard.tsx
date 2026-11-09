import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeskProductMode } from "@/hooks/useDeskProductMode";
import type { ProductMode } from "@/lib/desk-product-mode";
import { ModeUnavailable } from "./ModeUnavailable";

export function ModeRouteGuard({ mode, children }: { mode: ProductMode; children: ReactNode }) {
  const { loading, availability } = useDeskProductMode(mode);
  if (loading) return <div role="status" aria-label="Checking mode access"><Skeleton className="h-32 w-full" /></div>;
  if (!availability.available) return <ModeUnavailable mode={mode} reason={availability.reason} />;
  return <>{children}</>;
}
