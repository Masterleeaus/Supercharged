import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, ensureValidToken } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  RotateCcw,
  FileArchive,
  ArrowUpCircle,
  Shield,
  HardDrive,
  Database,
  Clock,
  Trash2,
  Info,
  Download,
  WifiOff,
  X,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface AppliedMigration {
  file: string;
  statements: number;
  durationMs: number;
  status: "applied" | "failed";
  error?: string;
}

interface DbPushResult {
  exitCode: number;
  success: boolean;
  outputTail: string;
  appliedMigrations?: AppliedMigration[];
}

interface UpdateStatus {
  inProgress: boolean;
  phase: string;
  progress: number;
  message: string;
  currentVersion: string;
  targetVersion?: string;
  error?: string;
  startedAt?: string;
  dbPush?: DbPushResult;
}

interface ValidationResult {
  manifest: {
    version: string;
    name: string;
    releaseNotes?: string;
    minCompatibleVersion?: string;
  };
  currentVersion: string;
  fileCount: number;
  totalSize: number;
  diskSpaceWarning?: string;
}

interface UpdateHistoryItem {
  id: string;
  from_version: string;
  to_version: string;
  status: string;
  backup_path: string | null;
  release_notes: string | null;
  error_message: string | null;
  performed_by: string | null;
  file_count: number;
  created_at: string;
}

function parseProxyError(text: string, status: number): string | null {
  if (status === 413 || text.includes("413") || text.toLowerCase().includes("request entity too large") || text.toLowerCase().includes("too large")) {
    return "The file is too large for your server's upload limit. Please increase the 'client_max_body_size' in your nginx configuration (e.g., client_max_body_size 500M;) and restart nginx.";
  }
  if (status === 502 || text.includes("502") || text.toLowerCase().includes("bad gateway")) {
    return "The server is temporarily unavailable (502 Bad Gateway). Please wait a moment and try again.";
  }
  if (status === 504 || text.includes("504") || text.toLowerCase().includes("gateway timeout")) {
    return "The upload timed out. Try increasing the proxy timeout in your nginx configuration, or use a smaller update package.";
  }
  if (text.includes("<html") || text.includes("<!DOCTYPE") || text.includes("<head>")) {
    return `Server returned an unexpected error (HTTP ${status}). This usually means a reverse proxy (like nginx) is blocking the request. Check your server configuration.`;
  }
  return null;
}

async function safeJson(res: Response, fallbackMsg: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const proxyMsg = parseProxyError(text, res.status);
    if (proxyMsg) {
      throw new Error(proxyMsg);
    }
    throw new Error(text || fallbackMsg);
  }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  await ensureValidToken();
  const authHeader = AuthStorage.getAuthHeader();
  return authHeader ? { Authorization: authHeader } : {};
}

const PHASE_PROGRESS: Record<string, number> = {
  idle: 0,
  validating: 10,
  backing_up: 25,
  backing_up_db: 40,
  extracting: 55,
  installing_deps: 70,
  db_push: 80,
  restarting: 85,
  health_check: 90,
  complete: 100,
  rolling_back: 50,
  failed: 0,
};

export default function SystemUpdate() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const phaseLabel = (phase: string) => t(`adminDashboard.settings.update.phases.${phase}`);
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<string>("idle");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateMessage, setUpdateMessage] = useState("");
  const [showRollbackDialog, setShowRollbackDialog] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState<string | null>(null);

  const {
    data: statusData,
    refetch: refetchStatus,
    isError: statusFetchError,
    failureCount: statusFailureCount,
  } = useQuery<{ data: UpdateStatus }>({
    queryKey: ["/api/admin/system-update/status"],
    // Aggressive polling while a change is in flight, slow polling otherwise.
    // refetchInterval keeps firing even after errors, which gives us a
    // natural reconnect loop while the server restarts mid-update.
    refetchInterval: (query) => {
      const data = query.state.data as { data: UpdateStatus } | undefined;
      const phase = data?.data?.phase;
      const active = isUpdating || data?.data?.inProgress || phase === "rolling_back";
      return active ? 2000 : 30000;
    },
    refetchIntervalInBackground: true,
    // Keep retrying network failures with capped exponential backoff so the
    // UI doesn't give up while the server is mid-restart.
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });

  const serverUnreachable = statusFetchError && statusFailureCount > 0;

  const { data: historyData, isLoading: loadingHistory } = useQuery<{ data: { history: UpdateHistoryItem[] } }>({
    queryKey: ["/api/admin/system-update/history"],
  });

  useEffect(() => {
    if (!statusData?.data) return;
    const status = statusData.data;

    if (status.inProgress) {
      setIsUpdating(true);
      setUpdatePhase(status.phase);
      setUpdateProgress(status.progress || PHASE_PROGRESS[status.phase] || 0);
      setUpdateMessage(status.message || phaseLabel(status.phase) || "");
      return;
    }

    if (status.phase === "complete" || status.phase === "failed") {
      if (isUpdating) {
        // We were tracking this update locally — fire toasts once.
        if (status.phase === "complete") {
          toast({ title: t("adminDashboard.settings.update.toasts.updateComplete"), description: t("adminDashboard.settings.update.toasts.updateCompleteDesc", { version: status.targetVersion || "latest" }) });
          queryClient.invalidateQueries({ queryKey: ["/api/admin/system-update/history"] });
          setSelectedFile(null);
          setValidationResult(null);
        } else {
          toast({ title: t("adminDashboard.settings.update.toasts.updateFailed"), description: status.error || t("adminDashboard.settings.update.toasts.updateFailedDesc"), variant: "destructive" });
        }
      }
      setIsUpdating(false);
      setUpdatePhase(status.phase);
      setUpdateProgress(status.phase === "complete" ? 100 : status.progress || 0);
      setUpdateMessage(status.message || phaseLabel(status.phase) || "");
    } else if (status.phase === "idle") {
      setIsUpdating(false);
      setUpdatePhase("idle");
      setUpdateProgress(0);
      setUpdateMessage("");
    }
  }, [statusData]);

  const [showResetDialog, setShowResetDialog] = useState(false);

  const resetMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/system-update/reset"),
    onSuccess: () => {
      toast({
        title: t("adminDashboard.settings.update.toasts.resetSuccess"),
        description: t("adminDashboard.settings.update.toasts.resetSuccessDesc"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-update/status"] });
      setIsUpdating(false);
      setUpdatePhase("idle");
      setUpdateProgress(0);
      setUpdateMessage("");
      setShowResetDialog(false);
    },
    onError: (error: Error) => {
      toast({ title: t("adminDashboard.settings.update.toasts.resetFailed"), description: error.message, variant: "destructive" });
      setShowResetDialog(false);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/system-update/dismiss"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-update/status"] });
      setUpdatePhase("idle");
      setUpdateProgress(0);
      setUpdateMessage("");
    },
    onError: (error: Error) => {
      toast({ title: t("adminDashboard.settings.update.toasts.dismissFailed"), description: error.message, variant: "destructive" });
    },
  });

  const validateMutation = useMutation({
    mutationFn: async (file: File) => {
      const headers = await getAuthHeaders();
      const formData = new FormData();
      formData.append("update", file);
      let res: globalThis.Response;
      try {
        res = await fetch("/api/admin/system-update/validate", {
          method: "POST",
          body: formData,
          credentials: "include",
          headers,
        });
      } catch (networkErr: any) {
        throw new Error("Upload failed: Could not connect to the server. Please check your server is running and try again.");
      }
      if (!res.ok) {
        const text = await res.text();
        const proxyMsg = parseProxyError(text, res.status);
        if (proxyMsg) throw new Error(proxyMsg);
        try {
          const err = JSON.parse(text);
          throw new Error(err.message || err.error || "Validation failed");
        } catch (e: any) {
          if (e.message && e.message !== text) throw e;
          throw new Error("Validation failed");
        }
      }
      return safeJson(res, "Validation failed");
    },
    onSuccess: (data) => {
      setValidationResult(data.data);
    },
    onError: (error: Error) => {
      toast({ title: t("adminDashboard.settings.update.toasts.validationFailed"), description: error.message, variant: "destructive" });
      setSelectedFile(null);
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (file: File) => {
      const headers = await getAuthHeaders();
      const formData = new FormData();
      formData.append("update", file);
      let res: globalThis.Response;
      try {
        res = await fetch("/api/admin/system-update/apply", {
          method: "POST",
          body: formData,
          credentials: "include",
          headers,
        });
      } catch (networkErr: any) {
        throw new Error("Upload failed: Could not connect to the server. Please check your server is running and try again.");
      }
      if (!res.ok) {
        const text = await res.text();
        const proxyMsg = parseProxyError(text, res.status);
        if (proxyMsg) throw new Error(proxyMsg);
        try {
          const err = JSON.parse(text);
          throw new Error(err.message || err.error || "Update failed");
        } catch (e: any) {
          if (e.message && e.message !== text) throw e;
          throw new Error("Update failed");
        }
      }
      return safeJson(res, "Update failed");
    },
    onSuccess: () => {
      setIsUpdating(true);
      setUpdatePhase("validating");
      setUpdateProgress(10);
      setUpdateMessage(t("adminDashboard.settings.update.toasts.updateStarted"));
    },
    onError: (error: Error) => {
      toast({ title: t("adminDashboard.settings.update.toasts.applyFailed"), description: error.message, variant: "destructive" });
      setIsUpdating(false);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async (updateId: string) => {
      return apiRequest("POST", `/api/admin/system-update/rollback/${updateId}`);
    },
    onSuccess: () => {
      toast({ title: t("adminDashboard.settings.update.toasts.rollbackStarted"), description: t("adminDashboard.settings.update.toasts.rollbackStartedDesc") });
      setIsUpdating(true);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-update/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-update/status"] });
      setShowRollbackDialog(null);
    },
    onError: (error: Error) => {
      toast({ title: t("adminDashboard.settings.update.toasts.rollbackFailed"), description: error.message, variant: "destructive" });
      setShowRollbackDialog(null);
    },
  });

  const deleteBackupMutation = useMutation({
    mutationFn: async (updateId: string) => {
      return apiRequest("DELETE", `/api/admin/system-update/backups/${updateId}`);
    },
    onSuccess: () => {
      toast({ title: t("adminDashboard.settings.update.toasts.backupDeleted"), description: t("adminDashboard.settings.update.toasts.backupDeletedDesc") });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-update/history"] });
      setShowDeleteDialog(null);
    },
    onError: (error: Error) => {
      toast({ title: t("adminDashboard.settings.update.toasts.deleteFailed"), description: error.message, variant: "destructive" });
      setShowDeleteDialog(null);
    },
  });

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".zip")) {
      setSelectedFile(file);
      setValidationResult(null);
      validateMutation.mutate(file);
    } else {
      toast({ title: t("adminDashboard.settings.update.toasts.invalidFile"), description: t("adminDashboard.settings.update.toasts.invalidFileDesc"), variant: "destructive" });
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setValidationResult(null);
      validateMutation.mutate(file);
    }
    e.target.value = "";
  }, []);

  const currentVersion = statusData?.data?.currentVersion || "...";
  const history = historyData?.data?.history || [];

  function formatDate(dateStr: string) {
    try {
      return new Date(dateStr).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  }

  function formatSize(bytes: number) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold" data-testid="text-system-update-title">{t("adminDashboard.settings.update.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("adminDashboard.settings.update.description")}
        </p>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t("adminDashboard.settings.update.currentVersion")}</span>
          <Badge variant="outline" data-testid="badge-current-version">v{currentVersion}</Badge>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3" data-testid="alert-update-warning">
        <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-yellow-700 dark:text-yellow-300">{t("adminDashboard.settings.update.warning.important")}</span>{" "}
          {t("adminDashboard.settings.update.warning.text")}
        </div>
      </div>

      {(isUpdating || updatePhase === "complete" || updatePhase === "failed") && (
        <Card data-testid="card-update-progress">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {isUpdating ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {updatePhase === "rolling_back" ? t("adminDashboard.settings.update.progress.rollbackInProgress") : t("adminDashboard.settings.update.progress.updateInProgress")}
                </>
              ) : updatePhase === "complete" ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  {statusData?.data?.targetVersion ? t("adminDashboard.settings.update.progress.updateComplete") : t("adminDashboard.settings.update.progress.operationComplete")}
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-destructive" />
                  {t("adminDashboard.settings.update.progress.operationFailed")}
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={updateProgress} className="h-2" />
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium" data-testid="text-update-phase">
                {phaseLabel(updatePhase) || updateMessage}
              </span>
              <span className="text-sm text-muted-foreground" data-testid="text-update-percent">
                {updateProgress}%
              </span>
            </div>
            {updateMessage && updateMessage !== phaseLabel(updatePhase) && (
              <div className="text-sm text-muted-foreground" data-testid="text-update-message">
                {updateMessage}
              </div>
            )}
            {isUpdating && serverUnreachable && (
              <div
                className="flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
                data-testid="alert-reconnecting"
              >
                <WifiOff className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  {t("adminDashboard.settings.update.progress.reconnecting", { count: statusFailureCount })}
                </span>
              </div>
            )}
            {updatePhase === "failed" && statusData?.data?.error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="text-update-error">
                <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{statusData.data.error}</span>
              </div>
            )}
            {updatePhase === "complete" && (
              <div className="flex items-start gap-2 rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{updateMessage || t("adminDashboard.settings.update.progress.operationSuccess")}</span>
              </div>
            )}
            {statusData?.data?.dbPush?.appliedMigrations && statusData.data.dbPush.appliedMigrations.length > 0 && (
              <div
                className="rounded-md border bg-muted/30 p-3 text-sm"
                data-testid="section-applied-migrations"
              >
                <div className="mb-2 font-medium">
                  {t("adminDashboard.settings.update.migrations.title")}
                </div>
                <ul className="space-y-1">
                  {statusData.data.dbPush.appliedMigrations.map((m) => (
                    <li
                      key={m.file}
                      className="flex items-center justify-between gap-2"
                      data-testid={`row-migration-${m.file}`}
                    >
                      <span className="flex items-center gap-2">
                        {m.status === "applied" ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive" />
                        )}
                        <code className="text-xs" data-testid={`text-migration-file-${m.file}`}>
                          {m.file}
                        </code>
                      </span>
                      <span
                        className="text-xs text-muted-foreground"
                        data-testid={`text-migration-stats-${m.file}`}
                      >
                        {t("adminDashboard.settings.update.migrations.statements", { count: m.statements })} · {m.durationMs}ms
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!isUpdating && (updatePhase === "complete" || updatePhase === "failed") && (
              <div className="flex justify-end gap-2 flex-wrap">
                {updatePhase === "failed" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowResetDialog(true)}
                    disabled={resetMutation.isPending}
                    data-testid="button-reset-update-state"
                  >
                    {resetMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4 mr-2" />
                    )}
                    {t("adminDashboard.settings.update.buttons.resetUpdateState")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => dismissMutation.mutate()}
                  disabled={dismissMutation.isPending}
                  data-testid="button-dismiss-update-result"
                >
                  {dismissMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <X className="h-4 w-4 mr-2" />
                  )}
                  {t("adminDashboard.settings.update.buttons.dismiss")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!isUpdating && updatePhase !== "complete" && updatePhase !== "failed" && (
        <Card data-testid="card-upload-update">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowUpCircle className="h-5 w-5" />
              {t("adminDashboard.settings.update.upload.title")}
            </CardTitle>
            <CardDescription>{t("adminDashboard.settings.update.upload.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`border-2 border-dashed rounded-md p-8 text-center transition-colors ${
                dragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              data-testid="dropzone-update-upload"
            >
              <FileArchive className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground mb-2">
                {t("adminDashboard.settings.update.upload.dropzoneText")}
              </p>
              <label>
                <Button variant="outline" asChild>
                  <span>
                    <Upload className="h-4 w-4 mr-2" />
                    {t("adminDashboard.settings.update.upload.chooseFile")}
                  </span>
                </Button>
                <input
                  type="file"
                  accept=".zip"
                  onChange={handleFileSelect}
                  className="hidden"
                  data-testid="input-update-file"
                />
              </label>
              {selectedFile && (
                <p className="text-sm text-muted-foreground mt-3" data-testid="text-selected-file">
                  {t("adminDashboard.settings.update.upload.selectedFile", { name: selectedFile.name, size: formatSize(selectedFile.size) })}
                </p>
              )}
            </div>

            {validateMutation.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("adminDashboard.settings.update.validation.validating")}
              </div>
            )}

            {validationResult && (
              <Card className="bg-muted/30" data-testid="card-validation-result">
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <span className="font-medium">{t("adminDashboard.settings.update.validation.valid")}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">{t("adminDashboard.settings.update.validation.name")}</span>
                      <span className="font-medium">{validationResult.manifest.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ArrowUpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">{t("adminDashboard.settings.update.validation.version")}</span>
                      <span className="font-medium">
                        {t("adminDashboard.settings.update.history.versionRange", { from: validationResult.currentVersion, to: validationResult.manifest.version })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">{t("adminDashboard.settings.update.validation.files")}</span>
                      <span className="font-medium">{t("adminDashboard.settings.update.history.fileCount", { count: validationResult.fileCount })}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Database className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">{t("adminDashboard.settings.update.validation.size")}</span>
                      <span className="font-medium">{formatSize(validationResult.totalSize)}</span>
                    </div>
                  </div>

                  {validationResult.manifest.releaseNotes && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">{t("adminDashboard.settings.update.validation.releaseNotes")}</span>
                      <p className="mt-1 text-foreground whitespace-pre-line">{validationResult.manifest.releaseNotes}</p>
                    </div>
                  )}

                  {validationResult.diskSpaceWarning && (
                    <div className="flex items-start gap-3 rounded-md bg-amber-500/10 p-3 text-sm" data-testid="text-disk-warning">
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                      <div className="text-foreground">
                        <div className="font-medium">{t("adminDashboard.settings.update.validation.lowDiskSpace")}</div>
                        <div className="text-muted-foreground">{validationResult.diskSpaceWarning}</div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-start gap-3 rounded-md bg-blue-500/10 p-3 text-sm">
                    <Shield className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                    <div className="text-muted-foreground">
                      {t("adminDashboard.settings.update.validation.backupNote")}
                    </div>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <Button
                      onClick={() => selectedFile && applyMutation.mutate(selectedFile)}
                      disabled={applyMutation.isPending}
                      data-testid="button-apply-update"
                    >
                      {applyMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ArrowUpCircle className="h-4 w-4 mr-2" />
                      )}
                      {t("adminDashboard.settings.update.buttons.applyUpdate")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelectedFile(null);
                        setValidationResult(null);
                      }}
                      data-testid="button-cancel-update"
                    >
                      {t("adminDashboard.settings.update.buttons.cancel")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-update-history">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            {t("adminDashboard.settings.update.history.title")}
          </CardTitle>
          <CardDescription>{t("adminDashboard.settings.update.history.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingHistory ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground" data-testid="text-no-history">
              {t("adminDashboard.settings.update.history.empty")}
            </div>
          ) : (
            <div className="space-y-3">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 flex-wrap rounded-md border p-3"
                  data-testid={`row-update-${item.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {item.status === "success" ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                    ) : item.status === "rolled_back" ? (
                      <RotateCcw className="h-5 w-5 text-yellow-600 flex-shrink-0" />
                    ) : (
                      <XCircle className="h-5 w-5 text-destructive flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">
                          {t("adminDashboard.settings.update.history.versionRange", { from: item.from_version, to: item.to_version })}
                        </span>
                        <Badge
                          variant={item.status === "success" ? "default" : item.status === "rolled_back" ? "secondary" : "destructive"}
                        >
                          {item.status === "success" ? t("adminDashboard.settings.update.history.statuses.success") : item.status === "rolled_back" ? t("adminDashboard.settings.update.history.statuses.rolled_back") : t("adminDashboard.settings.update.history.statuses.failed")}
                        </Badge>
                        {item.file_count > 0 && (
                          <span className="text-xs text-muted-foreground">{t("adminDashboard.settings.update.history.fileCount", { count: item.file_count })}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {formatDate(item.created_at)}
                        {item.release_notes && (
                          <span className="ml-2">- {item.release_notes.substring(0, 80)}{item.release_notes.length > 80 ? "..." : ""}</span>
                        )}
                      </div>
                      {item.error_message && (
                        <div className="text-xs text-destructive mt-0.5">{item.error_message}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.backup_path && item.status === "success" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowRollbackDialog(item.id)}
                        disabled={rollbackMutation.isPending || isUpdating}
                        data-testid={`button-rollback-${item.id}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        {t("adminDashboard.settings.update.buttons.rollback")}
                      </Button>
                    )}
                    {item.backup_path && (
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        data-testid={`button-download-backup-${item.id}`}
                      >
                        <a
                          href={`/api/admin/system-update/backups/${item.id}/download`}
                          download
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          {t("adminDashboard.settings.update.buttons.download")}
                        </a>
                      </Button>
                    )}
                    {item.backup_path && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowDeleteDialog(item.id)}
                        disabled={deleteBackupMutation.isPending || isUpdating}
                        data-testid={`button-delete-backup-${item.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={showResetDialog} onOpenChange={(open) => !open && setShowResetDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.settings.update.dialogs.reset.title")}</AlertDialogTitle>
            <AlertDialogDescription
              dangerouslySetInnerHTML={{ __html: t("adminDashboard.settings.update.dialogs.reset.description") }}
            />
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-reset-cancel">{t("adminDashboard.settings.update.dialogs.reset.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => resetMutation.mutate()}
              data-testid="button-reset-confirm"
            >
              {resetMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              {t("adminDashboard.settings.update.dialogs.reset.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!showRollbackDialog} onOpenChange={() => setShowRollbackDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.settings.update.dialogs.rollback.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.settings.update.dialogs.rollback.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-rollback-cancel">{t("adminDashboard.settings.update.dialogs.rollback.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => showRollbackDialog && rollbackMutation.mutate(showRollbackDialog)}
              data-testid="button-rollback-confirm"
            >
              {rollbackMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              {t("adminDashboard.settings.update.dialogs.rollback.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!showDeleteDialog} onOpenChange={() => setShowDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.settings.update.dialogs.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.settings.update.dialogs.delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">{t("adminDashboard.settings.update.dialogs.delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => showDeleteDialog && deleteBackupMutation.mutate(showDeleteDialog)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-confirm"
            >
              {deleteBackupMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              {t("adminDashboard.settings.update.dialogs.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
