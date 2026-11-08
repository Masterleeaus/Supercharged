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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { ApiError, queryClient } from "@/lib/queryClient";
import {
  approvalsQueryKeys,
  approveApproval,
  listApprovals,
  rejectApproval,
  type ApprovalItem,
  type ApprovalStatus,
} from "@/lib/approvals-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  Check,
  Clock,
  Inbox,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

const STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected", "expired"];
const PAGE_SIZE = 50;

/** Returns the current time, refreshed on an interval so "time left" stays accurate. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function statusVariant(status: ApprovalStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "pending":
      return "default";
    case "approved":
      return "secondary";
    case "rejected":
      return "destructive";
    default:
      return "outline";
  }
}

interface TimeLeft {
  expired: boolean;
  text: string | null;
}

function useTimeLeftLabel(expiresAt: string | null, now: number) {
  const { t } = useTranslation();
  const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(parsed)) {
    return { expired: false, text: null } as TimeLeft;
  }
  const ms = parsed - now;
  if (ms <= 0) {
    return { expired: true, text: t("approvals.timeLeft.expired") } as TimeLeft;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let text: string;
  if (hours >= 1) {
    text = t("approvals.timeLeft.hoursMinutes", { hours, minutes });
  } else if (minutes >= 1) {
    text = t("approvals.timeLeft.minutesSeconds", { minutes, seconds });
  } else {
    text = t("approvals.timeLeft.seconds", { seconds });
  }
  return { expired: false, text } as TimeLeft;
}

interface ApprovalCardProps {
  item: ApprovalItem;
  now: number;
  busy: boolean;
  onApprove: (item: ApprovalItem) => void;
  onReject: (item: ApprovalItem) => void;
}

function ApprovalCard({ item, now, busy, onApprove, onReject }: ApprovalCardProps) {
  const { t } = useTranslation();
  const timeLeft = useTimeLeftLabel(item.expiresAt, now);
  const isPending = item.status === "pending";
  const canDecide = isPending && !timeLeft.expired;
  const argsJson = JSON.stringify(item.arguments ?? {}, null, 2);

  return (
    <Card className="p-4 space-y-3" data-testid={`card-approval-${item.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm font-semibold break-all" data-testid={`text-approval-tool-${item.id}`}>
            {item.toolName}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("approvals.card.server")}: <span className="font-medium">{item.serverName}</span>
          </div>
        </div>
        <Badge variant={statusVariant(item.status)} data-testid={`badge-approval-status-${item.id}`}>
          {t(`approvals.status.${item.status}`)}
        </Badge>
      </div>

      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          {t("approvals.card.requestedBy")}: <span className="text-foreground">{item.requestedBy}</span>
        </div>
        <div>
          {t("approvals.card.createdAt")}: <span className="text-foreground">{formatDateTime(item.createdAt)}</span>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium">{t("approvals.card.policyReason")}</div>
        <p className="text-sm text-muted-foreground" data-testid={`text-approval-policy-${item.id}`}>
          {item.policyReason || t("approvals.card.noPolicyReason")}
        </p>
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium">{t("approvals.card.arguments")}</div>
        <pre
          className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs"
          data-testid={`text-approval-args-${item.id}`}
        >
          {argsJson}
        </pre>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`text-approval-expiry-${item.id}`}>
          <Clock className="h-3.5 w-3.5" />
          {isPending && timeLeft.text ? (
            <span className={timeLeft.expired ? "text-destructive" : undefined}>{timeLeft.text}</span>
          ) : item.expiresAt && !isPending ? (
            <span>{t("approvals.card.expiredOn", { date: formatDateTime(item.expiresAt) })}</span>
          ) : (
            <span>{t("approvals.card.noExpiry")}</span>
          )}
        </div>

        {isPending && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReject(item)}
              disabled={!canDecide || busy}
              data-testid={`button-reject-${item.id}`}
            >
              <X className="mr-1.5 h-4 w-4" />
              {t("approvals.actions.reject")}
            </Button>
            <Button
              size="sm"
              onClick={() => onApprove(item)}
              disabled={!canDecide || busy}
              data-testid={`button-approve-${item.id}`}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
              {t("approvals.actions.approve")}
            </Button>
          </div>
        )}
      </div>
      {isPending && timeLeft.expired && (
        <p className="text-xs text-muted-foreground">{t("approvals.card.pastExpiry")}</p>
      )}
    </Card>
  );
}

export default function Approvals() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [status, setStatus] = useState<ApprovalStatus>("pending");
  const [rejectTarget, setRejectTarget] = useState<ApprovalItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const now = useNow(5000);

  const query = useInfiniteQuery({
    queryKey: approvalsQueryKeys.list(status),
    queryFn: ({ pageParam }) =>
      listApprovals({ status, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // The app default queryFn would build the URL from the query key, so this page passes its own.
    // Pending items change under the user, so they are refetched; other tabs are historical.
    staleTime: 0,
    refetchOnWindowFocus: status === "pending",
    refetchInterval: status === "pending" ? 15000 : false,
  });

  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: approvalsQueryKeys.all });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveApproval(id),
    onSuccess: () => {
      toast({ title: t("approvals.toast.approved") });
    },
    onError: (err: unknown) => {
      toast({
        title: t("approvals.toast.actionFailed"),
        description: errorMessage(err, t("errors.generic")),
        variant: "destructive",
      });
    },
    onSettled: invalidate,
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectApproval(id, reason),
    onSuccess: () => {
      toast({ title: t("approvals.toast.rejected") });
      setRejectTarget(null);
      setRejectReason("");
    },
    onError: (err: unknown) => {
      toast({
        title: t("approvals.toast.actionFailed"),
        description: errorMessage(err, t("errors.generic")),
        variant: "destructive",
      });
    },
    onSettled: invalidate,
  });

  const openReject = (item: ApprovalItem) => {
    setRejectReason("");
    setRejectTarget(item);
  };

  const submitReject = () => {
    if (!rejectTarget || rejectReason.trim() === "") return;
    rejectMutation.mutate({ id: rejectTarget.id, reason: rejectReason });
  };

  const busyId =
    (approveMutation.isPending && approveMutation.variables) ||
    (rejectMutation.isPending && rejectMutation.variables?.id) ||
    null;

  const renderBody = () => {
    if (query.isLoading) {
      return (
        <div className="space-y-3" data-testid="state-approvals-loading">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-4 space-y-3">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-20 w-full" />
            </Card>
          ))}
        </div>
      );
    }

    if (query.isError) {
      return (
        <Alert variant="destructive" data-testid="state-approvals-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("approvals.error.title")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{errorMessage(query.error, t("errors.failedToLoad"))}</p>
            <Button variant="outline" size="sm" onClick={() => query.refetch()} data-testid="button-approvals-retry">
              <RefreshCw className="mr-1.5 h-4 w-4" />
              {t("common.refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      );
    }

    if (items.length === 0) {
      return (
        <Card className="flex flex-col items-center justify-center gap-2 p-10 text-center" data-testid="state-approvals-empty">
          <Inbox className="h-8 w-8 text-muted-foreground" />
          <h3 className="text-base font-medium">{t(`approvals.empty.${status}.title`)}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t(`approvals.empty.${status}.body`)}</p>
        </Card>
      );
    }

    return (
      <div className="space-y-3">
        {items.map((item) => (
          <ApprovalCard
            key={item.id}
            item={item}
            now={now}
            busy={busyId === item.id}
            onApprove={(target) => approveMutation.mutate(target.id)}
            onReject={openReject}
          />
        ))}
        {query.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              data-testid="button-approvals-load-more"
            >
              {query.isFetchingNextPage && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("approvals.loadMore")}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6" data-testid="page-approvals">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" />
          {t("approvals.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("approvals.subtitle")}</p>
      </div>

      <Alert data-testid="notice-approvals-no-execution">
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>{t("approvals.notice.title")}</AlertTitle>
        <AlertDescription>{t("approvals.notice.body")}</AlertDescription>
      </Alert>

      <Tabs value={status} onValueChange={(value) => setStatus(value as ApprovalStatus)}>
        <TabsList>
          {STATUSES.map((s) => (
            <TabsTrigger key={s} value={s} data-testid={`tab-approvals-${s}`}>
              {t(`approvals.status.${s}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {renderBody()}

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rejectMutation.isPending) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent data-testid="dialog-reject-approval">
          <DialogHeader>
            <DialogTitle>{t("approvals.reject.title")}</DialogTitle>
            <DialogDescription>
              {rejectTarget ? (
                <>
                  {t("approvals.reject.description")}{" "}
                  <span className="font-mono">{rejectTarget.toolName}</span>
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approval-reject-reason">{t("approvals.reject.reasonLabel")}</Label>
            <Textarea
              id="approval-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("approvals.reject.reasonPlaceholder")}
              rows={4}
              data-testid="input-reject-reason"
            />
            <p className="text-xs text-muted-foreground">{t("approvals.reject.reasonHint")}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason("");
              }}
              disabled={rejectMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={rejectReason.trim() === "" || rejectMutation.isPending}
              data-testid="button-confirm-reject"
            >
              {rejectMutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("approvals.actions.reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
