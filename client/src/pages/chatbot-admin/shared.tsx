/** Small pieces shared by the content admin screens. */
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

export function PendingState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-base font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {children ?? "This part is not connected yet. The rest of the page works without it."}
        </p>
      </CardContent>
    </Card>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not load this</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-8 text-center">
      <p className="text-base font-medium">{title}</p>
      {action}
    </div>
  );
}
