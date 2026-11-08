import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, RefreshCw, PlayCircle } from "lucide-react";

type Engine =
  | "elevenlabs-twilio"
  | "twilio-openai"
  | "plivo-openai"
  | "elevenlabs-sip"
  | "openai-sip";

interface EngineScanResult {
  engine: Engine;
  unbilled: number;
  estimatedCredits: number;
  uniqueUsers: number;
  sampleIds: string[];
}

interface ScanResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: { unbilled: number; estimatedCredits: number; uniqueUsers: number };
  engines: EngineScanResult[];
  error?: string;
}

interface EngineBackfillResult {
  engine: Engine;
  scanned: number;
  charged: number;
  alreadyDeducted: number;
  insufficientCredits: number;
  errors: number;
  totalCreditsDeducted: number;
}

interface BackfillResult {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  engines: EngineBackfillResult[];
  totals: { scanned: number; charged: number; totalCreditsDeducted: number; errors: number };
}

interface StatusResponse {
  success: boolean;
  data: {
    engines: Engine[];
    lastScan: ScanResult | null;
    lastBackfill: BackfillResult | null;
  };
}

function formatTime(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function CreditBackfillManagement() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [sinceDays, setSinceDays] = useState<number>(30);
  const [dryRun, setDryRun] = useState<boolean>(true);

  const { data, isLoading } = useQuery<StatusResponse>({
    queryKey: ["/api/admin/credit-backfill/status"],
  });

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/credit-backfill/scan", {
        sinceDays,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: t("adminDashboard.creditBackfill.toasts.scanComplete"), description: t("adminDashboard.creditBackfill.toasts.scanCompleteDesc") });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/credit-backfill/status"] });
    },
    onError: (err: any) => {
      toast({ title: t("adminDashboard.creditBackfill.toasts.scanFailed"), description: err?.message || t("common.unknownError"), variant: "destructive" });
    },
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/credit-backfill/run", {
        sinceDays,
        dryRun,
      });
      return res.json();
    },
    onSuccess: (json: any) => {
      const r: BackfillResult = json?.data;
      toast({
        title: dryRun ? t("adminDashboard.creditBackfill.toasts.dryRunComplete") : t("adminDashboard.creditBackfill.toasts.backfillComplete"),
        description: r
          ? t("adminDashboard.creditBackfill.toasts.backfillCompleteDesc", {
              scanned: r.totals.scanned,
              charged: r.totals.charged,
              credits: r.totals.totalCreditsDeducted,
              errors: r.totals.errors,
            })
          : t("adminDashboard.creditBackfill.toasts.backfillDone"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/credit-backfill/status"] });
    },
    onError: (err: any) => {
      toast({ title: t("adminDashboard.creditBackfill.toasts.backfillFailed"), description: err?.message || t("common.unknownError"), variant: "destructive" });
    },
  });

  const lastScan = data?.data?.lastScan;
  const lastBackfill = data?.data?.lastBackfill;
  const totalUnbilled = lastScan?.totals?.unbilled ?? 0;

  return (
    <div className="space-y-6" data-testid="page-credit-backfill">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t("adminDashboard.creditBackfill.title")}</h2>
        <p className="text-muted-foreground">
          {t("adminDashboard.creditBackfill.description")}
        </p>
      </div>

      {totalUnbilled > 0 && (
        <Alert variant="destructive" data-testid="alert-unbilled">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("adminDashboard.creditBackfill.unbilledAlert.title")}</AlertTitle>
          <AlertDescription>
            {t("adminDashboard.creditBackfill.unbilledAlert.description", {
              count: totalUnbilled,
              credits: lastScan?.totals.estimatedCredits ?? 0,
              users: lastScan?.totals.uniqueUsers ?? 0,
            })}
          </AlertDescription>
        </Alert>
      )}

      {totalUnbilled === 0 && lastScan && !lastScan.error && (
        <Alert data-testid="alert-clean">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>{t("adminDashboard.creditBackfill.allClear.title")}</AlertTitle>
          <AlertDescription>
            {t("adminDashboard.creditBackfill.allClear.description", { time: formatTime(lastScan.finishedAt) })}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("adminDashboard.creditBackfill.controls.title")}</CardTitle>
          <CardDescription>
            {t("adminDashboard.creditBackfill.controls.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="since-days">{t("adminDashboard.creditBackfill.controls.lookBackLabel")}</Label>
              <Input
                id="since-days"
                type="number"
                min={1}
                max={3650}
                value={sinceDays}
                onChange={(e) => setSinceDays(Math.max(1, Number(e.target.value) || 1))}
                className="w-32"
                data-testid="input-since-days"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="dry-run"
                checked={dryRun}
                onCheckedChange={setDryRun}
                data-testid="switch-dry-run"
              />
              <Label htmlFor="dry-run">{t("adminDashboard.creditBackfill.controls.dryRunLabel")}</Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => scanMutation.mutate()}
                disabled={scanMutation.isPending}
                data-testid="button-run-scan"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${scanMutation.isPending ? "animate-spin" : ""}`} />
                {t("adminDashboard.creditBackfill.controls.runScan")}
              </Button>
              <Button
                onClick={() => runMutation.mutate()}
                disabled={runMutation.isPending}
                data-testid="button-run-backfill"
              >
                <PlayCircle className={`h-4 w-4 mr-2 ${runMutation.isPending ? "animate-pulse" : ""}`} />
                {dryRun ? t("adminDashboard.creditBackfill.controls.runDryRunBackfill") : t("adminDashboard.creditBackfill.controls.runBackfill")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("adminDashboard.creditBackfill.latestScan.title")}</CardTitle>
          <CardDescription>
            {lastScan
              ? t("adminDashboard.creditBackfill.latestScan.description", {
                  time: formatTime(lastScan.finishedAt),
                  duration: lastScan.durationMs,
                })
              : t("adminDashboard.creditBackfill.latestScan.noScanYet")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : lastScan ? (
            <div className="space-y-3">
              {lastScan.error && (
                <Alert variant="destructive">
                  <AlertDescription>{lastScan.error}</AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {lastScan.engines.map((e) => (
                  <Card key={e.engine} data-testid={`card-engine-${e.engine}`}>
                    <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                      <CardTitle className="text-base">{e.engine}</CardTitle>
                      <Badge variant={e.unbilled > 0 ? "destructive" : "secondary"}>
                        {t("adminDashboard.creditBackfill.latestScan.unbilled", { count: e.unbilled })}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestScan.creditsOwed")}</span>
                        <span data-testid={`text-credits-${e.engine}`}>{e.estimatedCredits}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestScan.usersAffected")}</span>
                        <span>{e.uniqueUsers}</span>
                      </div>
                      {e.sampleIds.length > 0 && (
                        <div className="text-xs text-muted-foreground break-all pt-2">
                          {t("adminDashboard.creditBackfill.latestScan.sample", { ids: e.sampleIds.join(", ") })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("adminDashboard.creditBackfill.latestScan.noData")}</p>
          )}
        </CardContent>
      </Card>

      {lastBackfill && (
        <Card>
          <CardHeader>
            <CardTitle>{t("adminDashboard.creditBackfill.latestBackfill.title")}</CardTitle>
            <CardDescription>
              {t("adminDashboard.creditBackfill.latestBackfill.description", {
                time: formatTime(lastBackfill.finishedAt),
                mode: lastBackfill.dryRun
                  ? t("adminDashboard.creditBackfill.latestBackfill.dryRun")
                  : t("adminDashboard.creditBackfill.latestBackfill.live"),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {lastBackfill.engines.map((e) => (
                <Card key={e.engine}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{e.engine}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestBackfill.scanned")}</span>
                      <span>{e.scanned}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestBackfill.charged")}</span>
                      <span>{e.charged}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestBackfill.alreadyDeducted")}</span>
                      <span>{e.alreadyDeducted}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestBackfill.insufficientCredits")}</span>
                      <span>{e.insufficientCredits}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{t("adminDashboard.creditBackfill.latestBackfill.creditsDeducted")}</span>
                      <span data-testid={`text-deducted-${e.engine}`}>{e.totalCreditsDeducted}</span>
                    </div>
                    {e.errors > 0 && (
                      <div className="flex justify-between gap-2 text-destructive">
                        <span>{t("adminDashboard.creditBackfill.latestBackfill.errors")}</span>
                        <span>{e.errors}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
